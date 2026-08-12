const request = require('supertest');

// Control the storage seam so /verify uses a fake client (no real S3/network)
// and PATCH/DELETE's cache invalidation is a no-op.
const mockClient = {
  putBuffer: jest.fn(async () => {}),
  statObject: jest.fn(async () => ({ size: 13 })),
  removeObject: jest.fn(async () => {}),
};
jest.mock('../../src/services/storageBackendService', () => ({
  getBackendClient: jest.fn(() => mockClient),
  invalidateClient: jest.fn(),
}));

const { createTestApp, mockDb, sessionHeaders, mockSession, testAccount } = require('../setup');
const secretBox = require('../../src/utils/secretBox');

const SECRET = 'TOPSECRETaccesskey0000';

// A stored row whose encrypted config decrypts to a known config, so redact
// can surface endpoint/bucket. The plaintext secret must never appear in a
// response.
function storedRow(overrides = {}) {
  return {
    id: 'be-1',
    account_id: testAccount.id,
    type: 'r2',
    name: 'My R2',
    configuration_encrypted: secretBox.encryptJson({
      endpoint: 'https://acct.r2.cloudflarestorage.com',
      region: 'auto',
      bucket: 'cold-bucket',
      accessKeyId: 'AK123',
      secretAccessKey: SECRET,
      forcePathStyle: true,
    }),
    status: 'active',
    is_cold_default: true,
    last_verified_at: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

let app;
beforeEach(() => {
  mockDb.reset();
  app = createTestApp();
});

describe('Storage backends API', () => {
  it('creates a backend without ever returning the secret', async () => {
    mockSession({ role: 'admin' });
    mockDb.onQuery('INSERT INTO storage_backends', { rows: [storedRow()] });

    const res = await request(app)
      .post('/api/v1/storage/backends')
      .set(sessionHeaders())
      .send({ type: 'r2', name: 'My R2', endpoint: 'https://acct.r2.cloudflarestorage.com',
        region: 'auto', bucket: 'cold-bucket', accessKeyId: 'AK123', secretAccessKey: SECRET, is_cold_default: true });

    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ type: 'r2', name: 'My R2', bucket: 'cold-bucket', is_cold_default: true });
    // No secret material anywhere in the response.
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toContain('secretAccessKey');
    expect(res.body.data.secretAccessKey).toBeUndefined();
  });

  it('rejects a create missing credentials', async () => {
    mockSession({ role: 'admin' });
    const res = await request(app)
      .post('/api/v1/storage/backends')
      .set(sessionHeaders())
      .send({ type: 'r2', name: 'X', endpoint: 'https://e', bucket: 'b' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('CREDENTIALS_REQUIRED');
  });

  it('lists backends redacted (no secrets)', async () => {
    mockSession({ role: 'admin' });
    mockDb.onQuery('WHERE account_id = $1\n        ORDER BY created_at DESC', { rows: [storedRow()] });

    const res = await request(app).get('/api/v1/storage/backends').set(sessionHeaders());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ bucket: 'cold-bucket', endpoint: 'https://acct.r2.cloudflarestorage.com' });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('404s a backend owned by another account (cross-tenant)', async () => {
    mockSession({ role: 'admin' });
    // loadOwnedBackend's SELECT filters account_id, so a foreign backend returns none.
    mockDb.onQuery('FROM storage_backends WHERE id = $1 AND account_id = $2', { rows: [] });

    const res = await request(app)
      .patch('/api/v1/storage/backends/be-foreign')
      .set(sessionHeaders())
      .send({ name: 'hijack' });

    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('blocks deleting a backend that still holds objects', async () => {
    mockSession({ role: 'admin' });
    mockDb.onQuery('FROM storage_backends WHERE id = $1 AND account_id = $2', { rows: [storedRow()] });
    mockDb.onQuery('FROM file_objects WHERE storage_backend_id = $1', { rows: [{ n: 3 }] });

    const res = await request(app).delete('/api/v1/storage/backends/be-1').set(sessionHeaders());

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('BACKEND_IN_USE');
  });

  it('verifies connectivity with a probe and stamps last_verified_at', async () => {
    mockSession({ role: 'admin' });
    mockDb.onQuery('FROM storage_backends WHERE id = $1 AND account_id = $2', { rows: [storedRow()] });
    mockDb.onQuery('SET last_verified_at = NOW()', { rows: [storedRow({ last_verified_at: new Date().toISOString() })] });

    const res = await request(app).post('/api/v1/storage/backends/be-1/verify').set(sessionHeaders());

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);
    expect(mockClient.putBuffer).toHaveBeenCalled();
    expect(mockClient.removeObject).toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('forbids non-admins', async () => {
    mockSession({ role: 'viewer' });
    const res = await request(app).get('/api/v1/storage/backends').set(sessionHeaders());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INSUFFICIENT_ROLE');
  });
});
