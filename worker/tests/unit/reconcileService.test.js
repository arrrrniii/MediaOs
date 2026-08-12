const { mockDb } = require('../setup');

// Control the storage seam.
jest.mock('../../src/services/storageBackendService', () => ({
  getBackendById: jest.fn(),
  getBackendClient: jest.fn(),
  getDefaultBackend: jest.fn(),
}));

const storageBackendService = require('../../src/services/storageBackendService');
const queue = require('../../src/queue');
const minio = require('../../src/minio');
const reconcile = require('../../src/services/reconcileService');

const RUN_ID = 'run-1';

function issueInsert(category) {
  return mockDb.queryCalls.find(
    (c) => c.text.includes('INSERT INTO reconciliation_issues') && c.params[1] === category
  );
}
function auditInsert(action) {
  return mockDb.queryCalls.find(
    (c) => c.text.includes('INSERT INTO lifecycle_audit') && c.params[3] === action
  );
}
function findCall(sub) {
  return mockDb.queryCalls.find((c) => c.text.includes(sub));
}
function makeClient(overrides = {}) {
  return {
    statObject: jest.fn(async () => ({ size: 100 })),
    getObject: jest.fn(async () => streamOf(Buffer.from('bytes'))),
    removeObject: jest.fn(async () => {}),
    ...overrides,
  };
}
function streamOf(buf) {
  const { Readable } = require('stream');
  const r = new Readable();
  r.push(buf);
  r.push(null);
  return r;
}
function listStreamOf(items) {
  const { Readable } = require('stream');
  const r = new Readable({ objectMode: true });
  for (const it of items) r.push(it);
  r.push(null);
  return r;
}

beforeEach(() => {
  mockDb.reset();
  storageBackendService.getBackendById.mockReset();
  storageBackendService.getBackendClient.mockReset();
  storageBackendService.getDefaultBackend.mockReset();
  queue.addJob.mockClear();
  queue.isEnabled.mockReturnValue(true);
  minio.minioClient.listObjectsV2.mockReset();
  reconcile.setRedis(null);
});

// ── missing_objects ─────────────────────────────────────
describe('checkMissingObjects', () => {
  const OBJ = {
    id: 'o1', file_id: 'f1', role: 'optimized', storage_backend_id: 'b1',
    storage_key: 'proj/o.webp', storage_tier: 'hot', project_id: 'proj', account_id: 'acc',
  };

  it('marks an object missing when its bytes are gone and audits the repair', async () => {
    mockDb.onQuery('FROM file_objects o', { rows: [OBJ] });
    mockDb.onQuery('id <> $2 AND status', { rows: [] }); // no siblings
    const client = makeClient({ statObject: jest.fn(async () => { throw new Error('NoSuchKey'); }) });
    storageBackendService.getBackendById.mockResolvedValue({ id: 'b1' });
    storageBackendService.getBackendClient.mockReturnValue(client);

    const r = await reconcile.checkMissingObjects(RUN_ID);

    expect(r).toMatchObject({ checked: 1, issuesFound: 1 });
    expect(findCall("SET status = 'missing'")).toBeDefined();
    expect(auditInsert('repair.missing_objects')).toBeDefined();
    const issue = issueInsert('missing_objects');
    expect(issue.params[7]).toBe(false); // not auto-repaired (no recoverable copy)
    expect(issue.params[2]).toBe('error');
  });

  it('enqueues a restore when a cold sibling exists', async () => {
    mockDb.onQuery('FROM file_objects o', { rows: [OBJ] });
    mockDb.onQuery('id <> $2 AND status', { rows: [{ id: 'o2', storage_tier: 'cold' }] });
    const client = makeClient({ statObject: jest.fn(async () => { throw new Error('gone'); }) });
    storageBackendService.getBackendById.mockResolvedValue({ id: 'b1' });
    storageBackendService.getBackendClient.mockReturnValue(client);

    const r = await reconcile.checkMissingObjects(RUN_ID);

    expect(r.repaired).toBe(1);
    expect(queue.addJob).toHaveBeenCalledWith(
      'restore', 'restore', expect.objectContaining({ fileId: 'f1' }),
      expect.objectContaining({ jobId: 'restore:f1' })
    );
  });

  it('is safe to run twice: a present object records nothing', async () => {
    mockDb.onQuery('FROM file_objects o', { rows: [OBJ] });
    const client = makeClient(); // statObject resolves — object present
    storageBackendService.getBackendById.mockResolvedValue({ id: 'b1' });
    storageBackendService.getBackendClient.mockReturnValue(client);

    const r = await reconcile.checkMissingObjects(RUN_ID);
    expect(r).toMatchObject({ checked: 1, issuesFound: 0, repaired: 0 });
    expect(issueInsert('missing_objects')).toBeUndefined();
  });
});

// ── corrupt_checksums ───────────────────────────────────
describe('checkCorruptChecksums', () => {
  const goodBytes = Buffer.from('the real content');
  const crypto = require('crypto');
  const goodSum = crypto.createHash('sha256').update(goodBytes).digest('hex');

  it('marks corrupt when the re-hash does not match the stored checksum', async () => {
    mockDb.onQuery('AND o.checksum IS NOT NULL', {
      rows: [{ id: 'o1', file_id: 'f1', role: 'optimized', storage_backend_id: 'b1',
        storage_key: 'proj/o.webp', checksum: 'WRONGSUM', metadata: {}, project_id: 'proj', account_id: 'acc' }],
    });
    mockDb.onQuery('id <> $2 AND status', { rows: [] });
    const client = makeClient({ getObject: jest.fn(async () => streamOf(goodBytes)) });
    storageBackendService.getBackendById.mockResolvedValue({ id: 'b1' });
    storageBackendService.getBackendClient.mockReturnValue(client);

    const r = await reconcile.checkCorruptChecksums(RUN_ID);

    expect(r.issuesFound).toBe(1);
    expect(findCall("SET status = 'corrupt'")).toBeDefined();
    expect(auditInsert('repair.corrupt_checksums')).toBeDefined();
  });

  it('stamps verified_at and records nothing when the checksum matches (idempotent rotation)', async () => {
    mockDb.onQuery('AND o.checksum IS NOT NULL', {
      rows: [{ id: 'o1', file_id: 'f1', role: 'optimized', storage_backend_id: 'b1',
        storage_key: 'proj/o.webp', checksum: goodSum, metadata: {}, project_id: 'proj', account_id: 'acc' }],
    });
    const client = makeClient({ getObject: jest.fn(async () => streamOf(goodBytes)) });
    storageBackendService.getBackendById.mockResolvedValue({ id: 'b1' });
    storageBackendService.getBackendClient.mockReturnValue(client);

    const r = await reconcile.checkCorruptChecksums(RUN_ID);

    expect(r.issuesFound).toBe(0);
    expect(findCall("SET status = 'corrupt'")).toBeUndefined();
    const verify = mockDb.queryCalls.find((c) => c.text.includes('SET metadata = $2'));
    expect(verify).toBeDefined();
    expect(verify.params[1]).toContain('verified_at');
  });
});

// ── storage_counter_drift ───────────────────────────────
describe('checkStorageCounterDrift', () => {
  it('recomputes and corrects a drifted project counter', async () => {
    mockDb.onQuery('SELECT id, account_id, storage_used, file_count FROM projects', {
      rows: [{ id: 'proj', account_id: 'acc', storage_used: '999', file_count: 7 }],
    });
    mockDb.onQuery('COALESCE((SELECT SUM(o.size)', {
      rows: [{ storage_used: '500', file_count: 3 }],
    });

    const r = await reconcile.checkStorageCounterDrift(RUN_ID);

    expect(r).toMatchObject({ checked: 1, issuesFound: 1, repaired: 1 });
    const update = findCall('UPDATE projects SET storage_used = $2, file_count = $3');
    expect(update.params).toEqual(['proj', 500, 3]);
    expect(auditInsert('repair.storage_counter_drift')).toBeDefined();
  });

  it('is idempotent: no drift produces no update', async () => {
    mockDb.onQuery('SELECT id, account_id, storage_used, file_count FROM projects', {
      rows: [{ id: 'proj', account_id: 'acc', storage_used: '500', file_count: 3 }],
    });
    mockDb.onQuery('COALESCE((SELECT SUM(o.size)', {
      rows: [{ storage_used: '500', file_count: 3 }],
    });

    const r = await reconcile.checkStorageCounterDrift(RUN_ID);
    expect(r).toMatchObject({ issuesFound: 0, repaired: 0 });
    expect(findCall('UPDATE projects SET storage_used')).toBeUndefined();
  });
});

// ── failed_archives / incomplete_restores (stuck lifecycle) ─
describe('checkFailedArchives', () => {
  it('re-enqueues a stuck archiving file idempotently and audits it', async () => {
    mockDb.onQuery('FROM files f JOIN projects p ON p.id = f.project_id', {
      rows: [{ id: 'f1', project_id: 'proj', lifecycle_state: 'archiving', updated_at: new Date(), account_id: 'acc' }],
    });

    const r = await reconcile.checkFailedArchives(RUN_ID);

    expect(r).toMatchObject({ checked: 1, issuesFound: 1, repaired: 1 });
    expect(queue.addJob).toHaveBeenCalledWith(
      'archive', 'archive', expect.objectContaining({ fileId: 'f1', scope: 'all' }),
      expect.objectContaining({ jobId: 'archive:f1' })
    );
    expect(auditInsert('repair.failed_archives')).toBeDefined();
  });

  it('is safe to run twice: the guarded select returns nothing the second time', async () => {
    mockDb.onQuery('FROM files f JOIN projects p ON p.id = f.project_id', { rows: [] });
    const r = await reconcile.checkFailedArchives(RUN_ID);
    expect(r).toMatchObject({ checked: 0, issuesFound: 0, repaired: 0 });
    expect(queue.addJob).not.toHaveBeenCalled();
  });
});

describe('checkIncompleteRestores', () => {
  it('re-enqueues a stuck restoring file', async () => {
    mockDb.onQuery('FROM files f JOIN projects p ON p.id = f.project_id', {
      rows: [{ id: 'f2', project_id: 'proj', lifecycle_state: 'restoring', updated_at: new Date(), account_id: 'acc' }],
    });
    const r = await reconcile.checkIncompleteRestores(RUN_ID);
    expect(r.repaired).toBe(1);
    expect(queue.addJob).toHaveBeenCalledWith(
      'restore', 'restore', expect.objectContaining({ fileId: 'f2' }),
      expect.objectContaining({ jobId: 'restore:f2' })
    );
  });
});

// ── stuck_processing (media) ────────────────────────────
describe('checkStuckProcessing', () => {
  it('flags a stuck processing file when no live media job can be recovered', async () => {
    queue.isEnabled.mockReturnValue(false); // no durable queue → cannot re-drive
    mockDb.onQuery('WHERE f.status = \'processing\'', {
      rows: [{ id: 'f1', project_id: 'proj', status: 'processing', updated_at: new Date(), account_id: 'acc' }],
    });

    const r = await reconcile.checkStuckProcessing(RUN_ID);

    expect(r).toMatchObject({ checked: 1, issuesFound: 1, repaired: 0 });
    const issue = issueInsert('stuck_processing');
    expect(issue.params[2]).toBe('error'); // severity error when unrepaired
    expect(issue.params[8]).toBe('flagged');
  });

  it('is safe to run twice: guarded select returns nothing', async () => {
    mockDb.onQuery('WHERE f.status = \'processing\'', { rows: [] });
    const r = await reconcile.checkStuckProcessing(RUN_ID);
    expect(r).toMatchObject({ checked: 0, issuesFound: 0 });
  });
});

// ── failed_webhooks ─────────────────────────────────────
describe('checkFailedWebhooks', () => {
  it('re-arms a failed outbox event to pending', async () => {
    mockDb.onQuery('FROM outbox_events\n      WHERE status = \'failed\'', {
      rows: [{ id: 'evt1', event_type: 'file.processed', aggregate_id: 'f1', attempts: 10 }],
    });
    mockDb.onQuery("SET status = 'pending', attempts = 0", { rowCount: 1 });

    const r = await reconcile.checkFailedWebhooks(RUN_ID);

    expect(r).toMatchObject({ checked: 1, issuesFound: 1, repaired: 1 });
    const issue = issueInsert('failed_webhooks');
    expect(issue.params[8]).toBe('re-armed');
  });
});

// ── orphan_objects ──────────────────────────────────────
describe('checkOrphanObjects', () => {
  it('deletes an old orphan after re-checking the DB, and audits it', async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000); // 2 days old
    minio.minioClient.listObjectsV2.mockReturnValue(
      listStreamOf([{ name: 'proj/orphan.webp', lastModified: old, size: 10 }])
    );
    mockDb.onQuery('SELECT value FROM lifecycle_kv', { rows: [] });      // cursor
    mockDb.onQuery('INSERT INTO lifecycle_kv', { rowCount: 1 });         // cursor save
    mockDb.onQuery('storage_key = ANY($2)', { rows: [] });              // batch: unknown
    mockDb.onQuery('WHERE storage_key = $1 LIMIT 1', { rows: [] });     // recheck: still unknown
    storageBackendService.getDefaultBackend.mockResolvedValue({ id: 'b1' });
    const client = makeClient();
    storageBackendService.getBackendClient.mockReturnValue(client);

    const r = await reconcile.checkOrphanObjects(RUN_ID);

    expect(r.repaired).toBe(1);
    expect(client.removeObject).toHaveBeenCalledWith('proj/orphan.webp');
    expect(auditInsert('repair.orphan_objects')).toBeDefined();
    const issue = issueInsert('orphan_objects');
    expect(issue.params[8]).toBe('deleted');
  });

  it('reports but never deletes a young orphan', async () => {
    const recent = new Date(Date.now() - 60 * 1000); // 1 min old
    minio.minioClient.listObjectsV2.mockReturnValue(
      listStreamOf([{ name: 'proj/fresh.webp', lastModified: recent, size: 10 }])
    );
    mockDb.onQuery('SELECT value FROM lifecycle_kv', { rows: [] });
    mockDb.onQuery('INSERT INTO lifecycle_kv', { rowCount: 1 });
    mockDb.onQuery('storage_key = ANY($2)', { rows: [] });
    storageBackendService.getDefaultBackend.mockResolvedValue({ id: 'b1' });
    const client = makeClient();
    storageBackendService.getBackendClient.mockReturnValue(client);

    const r = await reconcile.checkOrphanObjects(RUN_ID);

    expect(r.repaired).toBe(0);
    expect(client.removeObject).not.toHaveBeenCalled();
    const issue = issueInsert('orphan_objects');
    expect(issue.params[8]).toBe('reported');
  });

  it('respects the DB re-check: a key that gained a row is not deleted', async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    minio.minioClient.listObjectsV2.mockReturnValue(
      listStreamOf([{ name: 'proj/racing.webp', lastModified: old, size: 10 }])
    );
    mockDb.onQuery('SELECT value FROM lifecycle_kv', { rows: [] });
    mockDb.onQuery('INSERT INTO lifecycle_kv', { rowCount: 1 });
    mockDb.onQuery('storage_key = ANY($2)', { rows: [] });               // batch: unknown
    mockDb.onQuery('WHERE storage_key = $1 LIMIT 1', { rows: [{ '?column?': 1 }] }); // recheck: now referenced
    storageBackendService.getDefaultBackend.mockResolvedValue({ id: 'b1' });
    const client = makeClient();
    storageBackendService.getBackendClient.mockReturnValue(client);

    const r = await reconcile.checkOrphanObjects(RUN_ID);

    expect(r.repaired).toBe(0);
    expect(client.removeObject).not.toHaveBeenCalled();
  });

  it('skips known keys (has a file_objects row)', async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    minio.minioClient.listObjectsV2.mockReturnValue(
      listStreamOf([{ name: 'proj/known.webp', lastModified: old, size: 10 }])
    );
    mockDb.onQuery('SELECT value FROM lifecycle_kv', { rows: [] });
    mockDb.onQuery('INSERT INTO lifecycle_kv', { rowCount: 1 });
    mockDb.onQuery('storage_key = ANY($2)', { rows: [{ storage_key: 'proj/known.webp' }] });
    storageBackendService.getDefaultBackend.mockResolvedValue({ id: 'b1' });
    const client = makeClient();
    storageBackendService.getBackendClient.mockReturnValue(client);

    const r = await reconcile.checkOrphanObjects(RUN_ID);
    expect(r.issuesFound).toBe(0);
    expect(client.removeObject).not.toHaveBeenCalled();
  });

  it('never reaps system-managed _cache/ and _multipart/ objects', async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000); // old enough to delete
    minio.minioClient.listObjectsV2.mockReturnValue(
      listStreamOf([
        { name: '_cache/v1/file-1/r_fit_200x200.webp', lastModified: old, size: 10 },
        { name: '_multipart/sess-1/1', lastModified: old, size: 10 },
      ])
    );
    mockDb.onQuery('SELECT value FROM lifecycle_kv', { rows: [] });
    mockDb.onQuery('INSERT INTO lifecycle_kv', { rowCount: 1 });
    storageBackendService.getDefaultBackend.mockResolvedValue({ id: 'b1' });
    const client = makeClient();
    storageBackendService.getBackendClient.mockReturnValue(client);

    const r = await reconcile.checkOrphanObjects(RUN_ID);
    // Both are excluded before the DB check, so nothing is examined or deleted.
    expect(r.checked).toBe(0);
    expect(client.removeObject).not.toHaveBeenCalled();
  });
});

// ── expired_temp_uploads ────────────────────────────────
describe('checkExpiredTempUploads', () => {
  it('deletes an aged temp upload', async () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    minio.minioClient.listObjectsV2.mockReturnValue(
      listStreamOf([{ name: '_processing_deadbeef.png', lastModified: old, size: 5 }])
    );
    storageBackendService.getDefaultBackend.mockResolvedValue({ id: 'b1' });
    const client = makeClient();
    storageBackendService.getBackendClient.mockReturnValue(client);

    const r = await reconcile.checkExpiredTempUploads(RUN_ID);

    expect(r.repaired).toBe(1);
    expect(client.removeObject).toHaveBeenCalledWith('_processing_deadbeef.png');
    expect(auditInsert('repair.expired_temp_uploads')).toBeDefined();
  });

  it('leaves a fresh temp upload alone', async () => {
    const recent = new Date(Date.now() - 60 * 1000);
    minio.minioClient.listObjectsV2.mockReturnValue(
      listStreamOf([{ name: '_processing_fresh.png', lastModified: recent, size: 5 }])
    );
    storageBackendService.getDefaultBackend.mockResolvedValue({ id: 'b1' });
    const client = makeClient();
    storageBackendService.getBackendClient.mockReturnValue(client);

    const r = await reconcile.checkExpiredTempUploads(RUN_ID);
    expect(r.repaired).toBe(0);
    expect(client.removeObject).not.toHaveBeenCalled();
  });
});

// ── unflushed_usage ─────────────────────────────────────
describe('checkUnflushedUsage', () => {
  it('reports info when Redis is not configured', async () => {
    reconcile.setRedis(null);
    const r = await reconcile.checkUnflushedUsage(RUN_ID);
    expect(r).toMatchObject({ checked: 0 });
    const issue = issueInsert('unflushed_usage');
    expect(issue.params[2]).toBe('info');
    expect(issue.params[8]).toBe('skipped');
  });

  it('triggers a flush when stale buffers exist', async () => {
    const usageFlush = require('../../src/services/usageFlushService');
    const accessFlush = require('../../src/services/lifecycleFlushService');
    jest.spyOn(usageFlush, 'flush').mockResolvedValue();
    jest.spyOn(accessFlush, 'flushAccess').mockResolvedValue();

    const yesterday = '2000-01-01';
    let usageScan = 0;
    let accessScan = 0;
    const fakeRedis = {
      scan: jest.fn(async (cursor, _m, pattern) => {
        if (pattern === 'usage:*') {
          if (usageScan++ === 0) return ['0', [`usage:proj:${yesterday}:uploads`]];
          return ['0', []];
        }
        if (accessScan++ === 0) return ['0', [`access:${yesterday}`]];
        return ['0', []];
      }),
    };
    reconcile.setRedis(fakeRedis);

    const r = await reconcile.checkUnflushedUsage(RUN_ID);

    expect(r.repaired).toBe(1);
    expect(usageFlush.flush).toHaveBeenCalled();
    expect(accessFlush.flushAccess).toHaveBeenCalled();
    const issue = issueInsert('unflushed_usage');
    expect(issue.params[8]).toBe('flushed');

    usageFlush.flush.mockRestore();
    accessFlush.flushAccess.mockRestore();
  });
});

// ── runAllChecks orchestration ──────────────────────────
describe('runAllChecks', () => {
  it('opens a run, runs a single category, and closes it', async () => {
    mockDb.onQuery('INSERT INTO reconciliation_runs', { rows: [{ id: 'run-x' }] });
    mockDb.onQuery('FROM files f JOIN projects p ON p.id = f.project_id', { rows: [] });

    const summary = await reconcile.runAllChecks({ categories: ['failed_archives'] });

    expect(summary).toMatchObject({ runId: 'run-x', kind: 'failed_archives', status: 'completed' });
    expect(findCall('INSERT INTO reconciliation_runs')).toBeDefined();
    const close = mockDb.queryCalls.find((c) => c.text.includes('UPDATE reconciliation_runs'));
    expect(close.params[1]).toBe('completed');
  });
});
