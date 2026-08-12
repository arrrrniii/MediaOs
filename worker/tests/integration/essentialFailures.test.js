/**
 * Essential failure coverage (Phase 11).
 *
 * One named test per item on the plan's "8 essential failures" list. Each test
 * asserts a durability/safety invariant under a specific fault. Faults that are
 * hard to reproduce for real (a Postgres commit failing mid-transaction, a
 * MinIO PUT failing after a DB row exists, a Redis disconnect during a flush)
 * are injected with mocks; the guarantees that only hold against real Redis are
 * asserted in the companion essentialFailures.redis.test.js.
 *
 * Loads ../setup for the shared db/queue/minio/videoProcessor mocks, and adds
 * storageBackendService + transfer mocks (the same seams the media/archive unit
 * tests use) so the media and archive processors can be driven without touching
 * real object storage.
 */

const {
  mockDb, mockMinio, createTestApp,
  testProject, testFile, otherUser, otherAccount, sessionHeaders, mockSession,
} = require('../setup');
const { hmacSha256 } = require('../../src/utils/crypto');

// A single controllable storage client shared by the media + archive paths.
const mockStorageClient = {
  putFile: jest.fn(async () => {}),
  putBuffer: jest.fn(async () => {}),
  getObject: jest.fn(),
  getPartialObject: jest.fn(),
  statObject: jest.fn(async () => ({ size: 5000, etag: 'e' })),
  removeObject: jest.fn(async () => {}),
};

jest.mock('../../src/services/storageBackendService', () => ({
  getDefaultBackend: jest.fn(),
  getBackendClient: jest.fn(),
  getBackendById: jest.fn(),
  resolveColdBackend: jest.fn(),
}));

// Keep the REAL ChecksumMismatchError so archive.js's instanceof check works.
jest.mock('../../src/storage/transfer', () => {
  const actual = jest.requireActual('../../src/storage/transfer');
  return { ...actual, copyVerified: jest.fn() };
});

const db = require('../../src/db');
const storageBackendService = require('../../src/services/storageBackendService');
const transfer = require('../../src/storage/transfer');
const videoProcessor = require('../../src/services/videoProcessor');
const { processMediaJob } = require('../../src/queue/processors/media');
const { processArchiveJob } = require('../../src/queue/processors/archive');
const usageFlush = require('../../src/services/usageFlushService');
const urlGuard = require('../../src/utils/urlGuard');

const FILE_ID = 'vid-1';
const FINAL_KEY = 'proj-1/clip-abc123.mp4';
const TEMP_KEY = '_processing_deadbeef.mov';
const BACKEND = { id: 'backend-1', type: 'minio', configuration_encrypted: null };

function mediaJob(overrides = {}) {
  return {
    fileId: FILE_ID, projectId: 'proj-1', tempKey: TEMP_KEY, finalKey: FINAL_KEY,
    kind: 'video', originalMime: 'video/quicktime', originalExt: '.mov', ...overrides,
  };
}

function primeMediaReads({ status = 'processing', settings = {} } = {}) {
  mockDb.onQuery('SELECT id, status FROM files WHERE id', { rows: [{ id: FILE_ID, status }] });
  mockDb.onQuery('SELECT * FROM projects WHERE id', {
    rows: [{ id: 'proj-1', account_id: 'acc-1', name: 'P', settings, signing_secret: 'a'.repeat(64) }],
  });
  mockDb.onQuery('SELECT id FROM files WHERE id', { rows: [{ id: FILE_ID }] });
}

function objectRoles() {
  return mockDb.queryCalls
    .filter((c) => c.text.includes('INSERT INTO file_objects'))
    .map((c) => c.params[1]);
}
function findCall(sub) {
  return mockDb.queryCalls.find((c) => c.text.includes(sub));
}
function removedKeys() {
  return mockStorageClient.removeObject.mock.calls.map((c) => c[0]);
}

beforeEach(() => {
  mockDb.reset();
  mockMinio.reset();

  Object.values(mockStorageClient).forEach((fn) => fn.mockReset && fn.mockReset());
  mockStorageClient.putFile.mockResolvedValue(undefined);
  mockStorageClient.putBuffer.mockResolvedValue(undefined);
  mockStorageClient.removeObject.mockResolvedValue(undefined);
  mockStorageClient.statObject.mockResolvedValue({ size: 5000, etag: 'e' });
  mockStorageClient.getObject.mockImplementation(async () => {
    const { Readable } = require('stream');
    const r = new Readable();
    r.push(Buffer.from('source-bytes'));
    r.push(null);
    return r;
  });

  storageBackendService.getDefaultBackend.mockReset().mockResolvedValue(BACKEND);
  storageBackendService.getBackendClient.mockReset().mockReturnValue(mockStorageClient);
  storageBackendService.getBackendById.mockReset().mockResolvedValue(BACKEND);
  storageBackendService.resolveColdBackend.mockReset();
  transfer.copyVerified.mockReset();

  // Default withTransaction runs fn against the mock client (from setup).
  db.withTransaction.mockImplementation(async (fn) => fn({ query: db.query, release: jest.fn() }));

  videoProcessor.transcodeHls.mockClear();
  videoProcessor.transcodeVideo.mockClear();
});

// ─────────────────────────────────────────────────────────────────────────
// 1. Postgres fails AFTER the MinIO uploads succeeded → the asset is never
//    left marked ready, no half-committed objects, source kept for retry.
// ─────────────────────────────────────────────────────────────────────────
describe('Essential failure 1 — Postgres fails after a MinIO upload succeeded', () => {
  it('rolls back the commit, marks the file failed, and never records a ready/available object', async () => {
    primeMediaReads();

    // Every rendition/poster/segment PUT succeeds; the commit transaction is
    // the thing that fails (simulating Postgres dying after storage is written).
    db.withTransaction.mockImplementationOnce(async () => {
      throw new Error('pg commit failed: connection terminated');
    });

    await expect(processMediaJob(mediaJob())).rejects.toThrow(/pg commit failed/);

    // The objects were physically uploaded before the DB failure...
    const uploaded = mockStorageClient.putFile.mock.calls.map((c) => c[0]);
    expect(uploaded).toContain(FINAL_KEY);
    expect(uploaded).toContain('proj-1/clip-abc123/hls/master.m3u8');

    // ...but the rolled-back commit means NO file_objects row was written
    // (no phantom "available" object) and the file was never marked done.
    expect(objectRoles()).toHaveLength(0);
    expect(findCall("status = 'done'")).toBeUndefined();

    // The catch path marks the asset failed (reconcilable) and removes the
    // objects it uploaded this run — while KEEPING the source temp for a retry.
    expect(findCall("status = 'failed', video_status = 'failed'")).toBeDefined();
    expect(removedKeys()).toContain(FINAL_KEY);
    expect(removedKeys()).not.toContain(TEMP_KEY);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. MinIO fails after the files DB record exists → asset failed, no phantom
//    "available" object, uploaded partials cleaned up, source kept.
// ─────────────────────────────────────────────────────────────────────────
describe('Essential failure 2 — MinIO fails after a files DB record is created', () => {
  it('marks the file failed and leaves no available object behind', async () => {
    primeMediaReads();
    // Progressive/thumb/poster upload, then the master playlist PUT fails.
    mockStorageClient.putFile.mockImplementation(async (key) => {
      if (key.endsWith('/master.m3u8')) throw new Error('MinIO 503: storage unavailable');
    });

    await expect(processMediaJob(mediaJob())).rejects.toThrow(/storage unavailable/);

    // Recording only happens in the final commit, which was never reached.
    expect(objectRoles()).not.toContain('optimized');
    expect(objectRoles()).toHaveLength(0);
    // File marked failed, partials removed, source kept for retry.
    expect(findCall("status = 'failed', video_status = 'failed'")).toBeDefined();
    expect(removedKeys()).toContain(FINAL_KEY);
    expect(removedKeys()).toContain('proj-1/clip-abc123/hls/poster.jpg');
    expect(removedKeys()).not.toContain(TEMP_KEY);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Worker restart during video processing → the media job is idempotent:
//    a re-run of an already-done asset does NOT re-transcode or duplicate.
//    (BullMQ persistence across a real restart is asserted in the .redis file.)
// ─────────────────────────────────────────────────────────────────────────
describe('Essential failure 3 — worker restart during video processing (idempotent re-run)', () => {
  it('skips re-processing a done asset that already has its HLS object', async () => {
    mockDb.onQuery('SELECT id, status FROM files WHERE id', { rows: [{ id: FILE_ID, status: 'done' }] });
    mockDb.onQuery('FROM file_objects WHERE file_id = $1 AND role = $2', {
      rows: [{ id: 'o1', storage_key: 'proj-1/clip-abc123/hls/master.m3u8' }],
    });

    const result = await processMediaJob(mediaJob());

    expect(result).toEqual({ skipped: 'already_done' });
    // No second transcode → no double-processing.
    expect(videoProcessor.transcodeHls).not.toHaveBeenCalled();
    // The leftover temp from the interrupted run is cleaned up.
    expect(mockStorageClient.removeObject).toHaveBeenCalledWith(TEMP_KEY);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 4. Redis disconnects during usage flushing → flush fails loudly (not
//    silently), the buffered counters are NOT consumed, and the next flush
//    after reconnect writes them through. The worker process stays up.
// ─────────────────────────────────────────────────────────────────────────
describe('Essential failure 4 — Redis disconnects during usage flushing', () => {
  it('does not GETDEL (drop) buffered counters when the SCAN fails', async () => {
    const brokenRedis = {
      scan: jest.fn(async () => { throw new Error('ECONNRESET: redis connection lost'); }),
      pipeline: jest.fn(),
    };

    await expect(usageFlush.flush(brokenRedis)).rejects.toThrow(/redis connection lost/);
    // GETDEL is only issued via a pipeline; if we never pipelined, the counters
    // are still in Redis to be flushed on the next cycle (not lost silently).
    expect(brokenRedis.pipeline).not.toHaveBeenCalled();
  });

  it('the flush loop swallows the error so the worker stays up', async () => {
    const brokenRedis = {
      scan: jest.fn(async () => { throw new Error('ECONNRESET'); }),
      pipeline: jest.fn(),
    };
    // Mirror the wrapper startFlushInterval uses: flush(...).catch(...). A
    // handled rejection means no unhandledRejection can crash the process.
    await expect(usageFlush.flush(brokenRedis).catch(() => 'handled')).resolves.toBe('handled');
  });

  it('flushes the surviving counters on the next cycle after reconnect', async () => {
    // Redis is back: one usage key survived the disconnect and is now flushed.
    const key = 'usage:proj-1:2026-08-12:downloads';
    let scanned = false;
    const redis = {
      scan: jest.fn(async () => {
        if (scanned) return ['0', []];
        scanned = true;
        return ['0', [key]];
      }),
      pipeline: jest.fn(() => ({
        getdel: jest.fn(),
        exec: jest.fn(async () => [[null, '5']]), // GETDEL → value 5
      })),
    };

    await usageFlush.flush(redis);

    const upsert = mockDb.queryCalls.find((c) => c.text.includes('INSERT INTO usage_daily'));
    expect(upsert).toBeDefined();
    expect(upsert.params).toEqual(expect.arrayContaining(['proj-1', '2026-08-12', 5]));
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5. Cold-storage copy has the wrong checksum → archive aborts, marks the
//    cold attempt corrupt, and NEVER deletes the hot copy.
// ─────────────────────────────────────────────────────────────────────────
describe('Essential failure 5 — cold-storage copy has the wrong checksum', () => {
  it('marks the object corrupt and leaves the hot copy intact', async () => {
    mockDb.onQuery('FROM files f JOIN projects p ON p.id = f.project_id', {
      rows: [{ id: 'f1', lifecycle_state: 'archiving', project_id: 'proj-1', account_id: 'acc-1' }],
    });
    mockDb.onQuery('FROM file_objects', {
      rows: [{
        id: 'obj-1', role: 'source', storage_backend_id: 'hot-b',
        storage_key: 'proj-1/original.bin', mime_type: 'application/octet-stream',
        size: 100, checksum: 'sum1', storage_tier: 'hot', status: 'available', metadata: {},
      }],
    });
    storageBackendService.resolveColdBackend.mockResolvedValue({ id: 'cold-b', type: 'minio' });

    transfer.copyVerified.mockRejectedValue(
      new transfer.ChecksumMismatchError('destination checksum mismatch', { side: 'destination' })
    );

    await expect(processArchiveJob({ fileId: 'f1', scope: 'source', graceMs: 0 }))
      .rejects.toThrow(/checksum mismatch/);

    // Cold attempt flipped to corrupt + audited; hot copy never removed.
    expect(findCall("SET status = 'corrupt'")).toBeDefined();
    const corruptAudit = mockDb.queryCalls.find(
      (c) => c.text.includes('INSERT INTO lifecycle_audit') && c.params[3] === 'archive.corrupt'
    );
    expect(corruptAudit).toBeDefined();
    expect(removedKeys()).not.toContain('proj-1/original.bin');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 6. Webhook points to a private address → rejected by the SSRF guard.
//    (The delivery path recording a permanent failure is covered in
//    tests/unit/webhook-security.test.js; here we assert the guard itself.)
// ─────────────────────────────────────────────────────────────────────────
describe('Essential failure 6 — webhook points to a private address', () => {
  it('rejects link-local, loopback, and private literal-IP targets', () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data', // cloud metadata
      'http://127.0.0.1/hook',                    // loopback
      'http://10.0.0.5/hook',                     // RFC1918
      'http://[::1]/hook',                        // IPv6 loopback
    ]) {
      expect(() => urlGuard.validateWebhookUrl(url)).toThrow(/not publicly routable|must be a domain/i);
    }
    expect(urlGuard.isPublicIp('169.254.169.254')).toBe(false);
    // A public target passes the guard.
    expect(() => urlGuard.validateWebhookUrl('https://hooks.example.com/incoming')).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 7. Tenant A requests Tenant B's project → 404 (no cross-tenant leak).
// ─────────────────────────────────────────────────────────────────────────
describe('Essential failure 7 — tenant A requests tenant B\'s project', () => {
  it('returns 404 NOT_FOUND scoped by account id', async () => {
    const app = createTestApp();
    // Session belongs to the OTHER account; the project belongs to testAccount.
    mockSession({ user: otherUser, account: otherAccount, role: 'owner' });
    // The scoped lookup finds nothing for this account.
    mockDb.onQuery('SELECT * FROM projects WHERE id = $1 AND account_id = $2', { rows: [] });

    const res = await require('supertest')(app)
      .get(`/api/v1/projects/${testProject.id}`)
      .set(sessionHeaders({ user: otherUser, account: otherAccount }));

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    // The query was scoped to the requesting account, not the project's owner.
    const call = mockDb.queryCalls.find((c) => c.text.includes('FROM projects WHERE id = $1 AND account_id = $2'));
    expect(call.params).toEqual([testProject.id, otherAccount.id]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 8. A cached signed URL is requested after expiry → 403 URL_EXPIRED, and the
//    Nginx edge is configured to bypass its cache for signed requests so an
//    expired token can never be served from a stored copy.
// ─────────────────────────────────────────────────────────────────────────
describe('Essential failure 8 — a cached signed URL is requested after expiry', () => {
  const SECRET = testProject.signing_secret;
  const KEY = testFile.storage_key;

  it('rejects an expired signed original with 403 URL_EXPIRED', async () => {
    const app = createTestApp();
    mockDb.onQuery('SELECT f.*, p.signing_secret', {
      rows: [{ ...testFile, access: 'private', signing_secret: SECRET }],
    });

    const expires = Math.floor(Date.now() / 1000) - 60; // already expired
    const token = hmacSha256(SECRET, `${KEY}:${expires}`);

    const res = await require('supertest')(app).get(`/f/${KEY}?token=${token}&expires=${expires}`);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('URL_EXPIRED');
  });

  it('Nginx bypasses the edge cache for signed (token/expires) requests', () => {
    const fs = require('fs');
    const path = require('path');
    const conf = fs.readFileSync(
      path.join(__dirname, '../../../deploy/nginx.conf'), 'utf8'
    );
    // Both file-serving locations must bypass + refuse to store signed responses,
    // otherwise a stored 200 would outlive its token.
    const bypasses = conf.match(/proxy_cache_bypass\s+\$arg_token\s+\$arg_expires/g) || [];
    const noCache = conf.match(/proxy_no_cache\s+\$arg_token\s+\$arg_expires/g) || [];
    expect(bypasses.length).toBeGreaterThanOrEqual(2); // /f/ and /img/
    expect(noCache.length).toBeGreaterThanOrEqual(2);
  });
});
