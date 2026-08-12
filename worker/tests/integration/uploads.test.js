const request = require('supertest');
const { createTestApp, mockDb, mockMinio, testProject, testApiKey } = require('../setup');
const { sha256 } = require('../../src/utils/crypto');

let app;

const FULL_KEY = 'mv_live_test0123456789abcdef0123456789ab';

function auth(scopes = ['upload', 'read', 'delete', 'admin']) {
  const prefix = FULL_KEY.substring(0, 12);
  const hash = sha256(FULL_KEY);
  mockDb.onQuery('SELECT * FROM api_keys WHERE key_prefix', {
    rows: [{ ...testApiKey, key_prefix: prefix, key_hash: hash, scopes }],
  });
  mockDb.onQuery('SELECT * FROM projects WHERE id', { rows: [testProject] });
  mockDb.onQuery('UPDATE api_keys SET last_used_at', { rowCount: 1 });
}

beforeEach(() => {
  mockDb.reset();
  mockMinio.reset();
  app = createTestApp();
});

describe('POST /api/v1/uploads/direct', () => {
  it('creates a one-time grant with an upload URL', async () => {
    auth();
    mockDb.onQuery('INSERT INTO direct_uploads', {
      rows: [{ id: 'grant-1', created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600e3).toISOString() }],
    });

    const res = await request(app)
      .post('/api/v1/uploads/direct')
      .set('X-API-Key', FULL_KEY)
      .send({ content_type: 'image/png', access: 'public' });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe('grant-1');
    expect(res.body.upload_url).toContain('/api/v1/uploads/direct/');
    expect(res.body.method).toBe('PUT');
  });

  it('enforces the upload scope', async () => {
    auth(['read']);
    const res = await request(app)
      .post('/api/v1/uploads/direct')
      .set('X-API-Key', FULL_KEY)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INSUFFICIENT_SCOPE');
  });
});

describe('PUT /api/v1/uploads/direct/:token', () => {
  it('rejects a reused (non-pending) grant with 409', async () => {
    mockDb.onQuery('FROM direct_uploads WHERE token_hash', {
      rows: [{ id: 'g1', project_id: testProject.id, status: 'completed', max_bytes: null, expires_at: new Date(Date.now() + 3600e3).toISOString() }],
    });
    const res = await request(app)
      .put('/api/v1/uploads/direct/sometoken')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('bytes'));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('GRANT_USED');
  });

  it('rejects an expired grant with 410', async () => {
    mockDb.onQuery('FROM direct_uploads WHERE token_hash', {
      rows: [{ id: 'g1', project_id: testProject.id, status: 'pending', max_bytes: null, expires_at: new Date(Date.now() - 1000).toISOString() }],
    });
    mockDb.onQuery("UPDATE direct_uploads SET status = 'expired'", { rowCount: 1 });
    const res = await request(app)
      .put('/api/v1/uploads/direct/sometoken')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('bytes'));
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('GRANT_EXPIRED');
  });

  it('404s an unknown token', async () => {
    mockDb.onQuery('FROM direct_uploads WHERE token_hash', { rows: [] });
    const res = await request(app)
      .put('/api/v1/uploads/direct/sometoken')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('bytes'));
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('GRANT_NOT_FOUND');
  });

  it('consumes a pending grant and processes the bytes', async () => {
    mockDb.onQuery('FROM direct_uploads WHERE token_hash', {
      rows: [{ id: 'g1', project_id: testProject.id, status: 'pending', max_bytes: 1048576, content_type: 'application/octet-stream', access: 'public', folder: null, idempotency_key: null, expires_at: new Date(Date.now() + 3600e3).toISOString() }],
    });
    mockDb.onQuery("UPDATE direct_uploads SET status = 'aborted'", { rows: [{ id: 'g1' }], rowCount: 1 });
    mockDb.onQuery("SELECT * FROM projects WHERE id", { rows: [testProject] });
    mockDb.onQuery('AND content_hash = $2', { rows: [] });
    mockDb.onQuery('INSERT INTO files', {
      rows: [{ id: 'file-9', project_id: testProject.id, storage_key: `${testProject.id}/upload.bin`, filename: 'upload.bin', type: 'file', mime_type: 'application/octet-stream', size: 5, access: 'public', status: 'done', created_at: new Date().toISOString() }],
    });
    mockDb.onQuery('UPDATE projects SET storage_used', { rowCount: 1 });
    mockDb.onQuery("UPDATE direct_uploads SET status = 'completed'", { rowCount: 1 });

    const res = await request(app)
      .put('/api/v1/uploads/direct/sometoken')
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('bytes'));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('file-9');
  });
});

describe('multipart resumable uploads', () => {
  const SESSION = {
    id: 'sess-1', project_id: testProject.id, filename: 'big.bin', content_type: 'application/octet-stream',
    access: 'public', folder: null, parts: [], total_bytes: 10, received_bytes: 0, status: 'active',
    idempotency_key: null, file_id: null, created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3600e3).toISOString(),
  };

  it('starts a session', async () => {
    auth();
    mockDb.onQuery('INSERT INTO upload_sessions', { rows: [SESSION] });
    const res = await request(app)
      .post('/api/v1/uploads/multipart/start')
      .set('X-API-Key', FULL_KEY)
      .send({ filename: 'big.bin', size: 10, content_type: 'application/octet-stream' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('sess-1');
    expect(res.body.status).toBe('active');
    expect(res.body.part_size).toBeGreaterThan(0);
  });

  it('uploads a part and records received bytes', async () => {
    auth();
    mockDb.onQuery('FROM upload_sessions WHERE id', { rows: [SESSION] });
    mockDb.onQuery('UPDATE upload_sessions SET parts', { rowCount: 1 });
    const res = await request(app)
      .put('/api/v1/uploads/multipart/sess-1/parts/1')
      .set('X-API-Key', FULL_KEY)
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('12345'));
    expect(res.status).toBe(200);
    expect(res.body.part_number).toBe(1);
    expect(res.body.received_bytes).toBe(5);
    const partWrites = mockMinio.putBufferCalls.filter((c) => c.key.startsWith('_multipart/'));
    expect(partWrites.length).toBe(1);
  });

  it('returns session state for resume', async () => {
    auth();
    mockDb.onQuery('FROM upload_sessions WHERE id', {
      rows: [{ ...SESSION, parts: [{ part_number: 1, size: 5, key: '_multipart/sess-1/1' }], received_bytes: 5 }],
    });
    const res = await request(app)
      .get('/api/v1/uploads/multipart/sess-1')
      .set('X-API-Key', FULL_KEY);
    expect(res.status).toBe(200);
    expect(res.body.received_bytes).toBe(5);
    expect(res.body.parts).toEqual([{ part_number: 1, size: 5 }]);
  });

  it('completes a session by assembling parts through the pipeline', async () => {
    auth();
    mockDb.onQuery('FROM upload_sessions WHERE id', {
      rows: [{ ...SESSION, parts: [{ part_number: 1, size: 4, key: '_multipart/sess-1/1' }] }],
    });
    mockDb.onQuery('AND content_hash = $2', { rows: [] });
    mockDb.onQuery('INSERT INTO files', {
      rows: [{ id: 'file-mp', project_id: testProject.id, storage_key: `${testProject.id}/big.bin`, filename: 'big.bin', type: 'file', mime_type: 'application/octet-stream', size: 4, access: 'public', status: 'done', created_at: new Date().toISOString() }],
    });
    mockDb.onQuery('UPDATE projects SET storage_used', { rowCount: 1 });
    mockDb.onQuery("UPDATE upload_sessions SET status = 'completed'", { rowCount: 1 });

    const res = await request(app)
      .post('/api/v1/uploads/multipart/sess-1/complete')
      .set('X-API-Key', FULL_KEY)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.file.id).toBe('file-mp');
  });

  it('aborts a session', async () => {
    auth();
    mockDb.onQuery('FROM upload_sessions WHERE id', {
      rows: [{ ...SESSION, parts: [{ part_number: 1, size: 5, key: '_multipart/sess-1/1' }] }],
    });
    mockDb.onQuery("UPDATE upload_sessions SET status = 'aborted'", { rowCount: 1 });
    const res = await request(app)
      .post('/api/v1/uploads/multipart/sess-1/abort')
      .set('X-API-Key', FULL_KEY)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.aborted).toBe(true);
  });

  it('404s a session that belongs to another project (cross-tenant)', async () => {
    auth();
    // Scoped query returns nothing for a foreign session id.
    mockDb.onQuery('FROM upload_sessions WHERE id', { rows: [] });
    const res = await request(app)
      .get('/api/v1/uploads/multipart/foreign-sess')
      .set('X-API-Key', FULL_KEY);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('SESSION_NOT_FOUND');
  });
});
