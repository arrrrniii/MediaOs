const request = require('supertest');
const {
  createTestApp, mockDb, mockMinio, testProject, testApiKey, testFile,
} = require('../setup');
const { sha256 } = require('../../src/utils/crypto');

let app;

const FULL_KEY = 'mv_live_test0123456789abcdef0123456789ab';

// Authenticate a request, optionally overriding the project (e.g. to set an
// original-preservation policy).
function auth(project = testProject) {
  const prefix = FULL_KEY.substring(0, 12);
  const hash = sha256(FULL_KEY);
  mockDb.onQuery('SELECT * FROM api_keys WHERE key_prefix', {
    rows: [{ ...testApiKey, key_prefix: prefix, key_hash: hash }],
  });
  mockDb.onQuery('SELECT * FROM projects WHERE id', { rows: [project] });
  mockDb.onQuery('UPDATE api_keys SET last_used_at', { rowCount: 1 });
}

function insertedObjectRoles() {
  return mockDb.queryCalls
    .filter((c) => c.text.includes('INSERT INTO file_objects'))
    .map((c) => c.params[1]);
}

beforeEach(() => {
  mockDb.reset();
  mockMinio.reset();
  app = createTestApp();
});

describe('Logical asset model — upload', () => {
  it("policy 'discard' (default): one optimized object, no source, usage = optimized size", async () => {
    auth();
    mockDb.onQuery('INSERT INTO files', {
      rows: [{ ...testFile, storage_key: `${testProject.id}/img-abc.webp` }],
    });
    mockDb.onQuery('UPDATE projects SET storage_used', { rowCount: 1 });

    const res = await request(app)
      .post('/api/v1/upload')
      .set('X-API-Key', FULL_KEY)
      .attach('file', Buffer.from('fake-image-data'), {
        filename: 'test.png', contentType: 'image/png',
      });

    expect(res.status).toBe(200);
    // Exactly one physical object, role optimized.
    expect(insertedObjectRoles()).toEqual(['optimized']);
    expect(res.body.objects).toHaveLength(1);
    expect(res.body.objects[0].role).toBe('optimized');
    expect(res.body.source_url).toBeUndefined();

    // storage_used incremented by the optimized (WebP) size only. The mocked
    // sharp emits a 9-byte 'webp-data' buffer.
    const counter = mockDb.queryCalls.find((c) => c.text.includes('UPDATE projects SET storage_used'));
    expect(counter.params[0]).toBe(9);
  });

  it("policy 'keep': source + optimized objects recorded, checksum set, usage = sum of both", async () => {
    const keepProject = {
      ...testProject,
      settings: { ...testProject.settings, original_policy: { original_policy: 'keep' } },
    };
    auth(keepProject);
    mockDb.onQuery('INSERT INTO files', {
      rows: [{ ...testFile, storage_key: `${testProject.id}/img-abc.webp` }],
    });
    mockDb.onQuery('UPDATE projects SET storage_used', { rowCount: 1 });

    const uploaded = Buffer.from('fake-image-data'); // 15 bytes -> the source

    const res = await request(app)
      .post('/api/v1/upload')
      .set('X-API-Key', FULL_KEY)
      .attach('file', uploaded, { filename: 'test.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    // Both the preserved source and the optimized rendition are recorded.
    expect(insertedObjectRoles().sort()).toEqual(['optimized', 'source']);
    expect(res.body.objects).toHaveLength(2);
    expect(res.body.source_url).toBeDefined();

    // files.checksum (param 18, 0-indexed 17) is the source SHA-256.
    const insert = mockDb.queryCalls.find((c) => c.text.includes('INSERT INTO files'));
    expect(insert.params[17]).toBe(sha256(uploaded));

    // storage_used = source (15) + optimized (9).
    const counter = mockDb.queryCalls.find((c) => c.text.includes('UPDATE projects SET storage_used'));
    expect(counter.params[0]).toBe(15 + 9);

    // Two physical copies land in storage.
    expect(mockMinio.putBufferCalls).toHaveLength(2);
  });

  it("policy as a bare string ('keep'): preserves the source too", async () => {
    // The policy may be written either as { original_policy: 'keep' } or as a
    // bare string. Both must behave identically.
    const keepProject = {
      ...testProject,
      settings: { ...testProject.settings, original_policy: 'keep' },
    };
    auth(keepProject);
    mockDb.onQuery('INSERT INTO files', {
      rows: [{ ...testFile, storage_key: `${testProject.id}/img-abc.webp` }],
    });
    mockDb.onQuery('UPDATE projects SET storage_used', { rowCount: 1 });

    const res = await request(app)
      .post('/api/v1/upload')
      .set('X-API-Key', FULL_KEY)
      .attach('file', Buffer.from('fake-image-data'), { filename: 'test.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(insertedObjectRoles().sort()).toEqual(['optimized', 'source']);
  });

  it("policy 'temporary': sets files.retention_until", async () => {
    const tempProject = {
      ...testProject,
      settings: {
        ...testProject.settings,
        original_policy: { original_policy: 'temporary', archive_original_after_days: 7 },
      },
    };
    auth(tempProject);
    mockDb.onQuery('INSERT INTO files', { rows: [{ ...testFile }] });
    mockDb.onQuery('UPDATE projects SET storage_used', { rowCount: 1 });

    const res = await request(app)
      .post('/api/v1/upload')
      .set('X-API-Key', FULL_KEY)
      .attach('file', Buffer.from('fake-image-data'), { filename: 'test.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    const insert = mockDb.queryCalls.find((c) => c.text.includes('INSERT INTO files'));
    // retention_until is the last param (index 18) and is a Date in the future.
    expect(insert.params[18]).toBeInstanceOf(Date);
    expect(insert.params[18].getTime()).toBeGreaterThan(Date.now());
  });

  it('non-transformed types (generic file) record a single source object regardless of policy', async () => {
    auth();
    mockDb.onQuery('INSERT INTO files', {
      rows: [{ ...testFile, type: 'file', mime_type: 'application/pdf', storage_key: `${testProject.id}/doc.pdf` }],
    });
    mockDb.onQuery('UPDATE projects SET storage_used', { rowCount: 1 });

    const res = await request(app)
      .post('/api/v1/upload')
      .set('X-API-Key', FULL_KEY)
      .attach('file', Buffer.from('%PDF-1.4 fake'), { filename: 'doc.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(200);
    expect(insertedObjectRoles()).toEqual(['source']);
  });
});

describe('Logical asset model — delete', () => {
  it('removes every physical object key and decrements by summed bytes', async () => {
    auth();
    mockDb.onQuery('SELECT * FROM files WHERE id', { rows: [testFile] });
    mockDb.onQuery('FROM file_objects WHERE file_id = $1 ORDER BY created_at', {
      rows: [
        { storage_key: 'proj/a.webp', size: '9', storage_backend_id: 'b1' },
        { storage_key: 'proj/a-src.png', size: '15', storage_backend_id: 'b1' },
      ],
    });
    mockDb.onQuery('UPDATE files SET deleted_at', { rowCount: 1 });
    mockDb.onQuery('UPDATE projects SET storage_used', { rowCount: 1 });

    const res = await request(app)
      .delete(`/api/v1/files/${testFile.id}`)
      .set('X-API-Key', FULL_KEY);

    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    // Summed bytes across both copies.
    expect(res.body.freed_bytes).toBe(24);
    const counter = mockDb.queryCalls.find((c) => c.text.includes('UPDATE projects SET storage_used'));
    expect(counter.params[0]).toBe(24);
    // Both physical keys removed from storage.
    expect(mockMinio.removedKeys).toEqual(expect.arrayContaining(['proj/a.webp', 'proj/a-src.png']));
  });

  it('falls back to the legacy key/size when a file has no objects', async () => {
    auth();
    mockDb.onQuery('SELECT * FROM files WHERE id', { rows: [testFile] });
    mockDb.onQuery('FROM file_objects WHERE file_id = $1 ORDER BY created_at', { rows: [] });
    mockDb.onQuery('UPDATE files SET deleted_at', { rowCount: 1 });
    mockDb.onQuery('UPDATE projects SET storage_used', { rowCount: 1 });

    const res = await request(app)
      .delete(`/api/v1/files/${testFile.id}`)
      .set('X-API-Key', FULL_KEY);

    expect(res.status).toBe(200);
    expect(res.body.freed_bytes).toBe(testFile.size);
    expect(mockMinio.removedKeys).toContain(testFile.storage_key);
  });
});

describe('Logical asset model — serve read-through', () => {
  it('streams the object resolved from file_objects', async () => {
    const altKey = 'proj-test-id/optimized-xyz.webp';
    mockMinio.objects[altKey] = { buffer: Buffer.from('optimized-bytes'), contentType: 'image/webp', size: 15 };

    mockDb.onQuery('SELECT f.*, p.signing_secret', {
      rows: [{ ...testFile, signing_secret: 'a'.repeat(64) }],
    });
    // getObjectByRole(file, 'optimized') resolves to a different physical key.
    mockDb.onQuery('AND role = $2', {
      rows: [{ storage_key: altKey, storage_backend_id: 'b1', role: 'optimized' }],
    });

    const res = await request(app).get(`/f/${testFile.storage_key}`);

    expect(res.status).toBe(200);
    // The object query was consulted.
    expect(mockDb.queryCalls.some((c) => c.text.includes('file_objects'))).toBe(true);
  });

  it('falls back to the legacy storage_key when no objects exist', async () => {
    mockMinio.objects[testFile.storage_key] = {
      buffer: Buffer.from('legacy-bytes'), contentType: 'image/webp', size: 12,
    };
    mockDb.onQuery('SELECT f.*, p.signing_secret', {
      rows: [{ ...testFile, signing_secret: 'a'.repeat(64) }],
    });
    mockDb.onQuery('AND role = $2', { rows: [] }); // optimized: none
    mockDb.onQuery('AND role = $2', { rows: [] }); // source: none

    const res = await request(app).get(`/f/${testFile.storage_key}`);

    expect(res.status).toBe(200);
  });
});
