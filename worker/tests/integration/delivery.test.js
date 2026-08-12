const request = require('supertest');
const {
  createTestApp, mockDb, mockMinio, mockSession, sessionHeaders,
  testProject, testApiKey,
} = require('../setup');
const { sha256 } = require('../../src/utils/crypto');

let app;

const FULL_KEY = 'mv_live_test0123456789abcdef0123456789ab';
function apiAuth(scopes = ['upload', 'read', 'delete', 'admin']) {
  const prefix = FULL_KEY.substring(0, 12);
  const hash = sha256(FULL_KEY);
  mockDb.onQuery('SELECT * FROM api_keys WHERE key_prefix', {
    rows: [{ ...testApiKey, key_prefix: prefix, key_hash: hash, scopes }],
  });
  mockDb.onQuery('SELECT * FROM projects WHERE id', { rows: [testProject] });
  mockDb.onQuery('UPDATE api_keys SET last_used_at', { rowCount: 1 });
}

function accountProject() {
  mockDb.onQuery("SELECT * FROM projects WHERE id = $1 AND account_id", { rows: [testProject] });
}

beforeEach(() => {
  mockDb.reset();
  mockMinio.reset();
  app = createTestApp();
});

describe('named variants — session-scoped', () => {
  it('lists stored variants plus built-ins', async () => {
    mockSession();
    accountProject();
    mockDb.onQuery('FROM named_variants WHERE project_id', {
      rows: [{ id: 'v1', project_id: testProject.id, name: 'square', mode: 'fill', width: 500, height: 500, format: 'auto', quality: null }],
    });
    const res = await request(app)
      .get(`/api/v1/projects/${testProject.id}/variants`)
      .set(sessionHeaders());
    expect(res.status).toBe(200);
    expect(res.body.data[0].name).toBe('square');
    expect(res.body.builtins.length).toBe(3);
  });

  it('creates a variant (editor)', async () => {
    mockSession({ role: 'editor' });
    accountProject();
    mockDb.onQuery('INSERT INTO named_variants', {
      rows: [{ id: 'v2', project_id: testProject.id, name: 'card', mode: 'fill', width: 600, height: 400, format: 'auto', quality: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
    });
    const res = await request(app)
      .post(`/api/v1/projects/${testProject.id}/variants`)
      .set(sessionHeaders())
      .send({ name: 'card', mode: 'fill', width: 600, height: 400 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('card');
  });

  it('rejects an invalid variant with 400', async () => {
    mockSession({ role: 'editor' });
    accountProject();
    const res = await request(app)
      .post(`/api/v1/projects/${testProject.id}/variants`)
      .set(sessionHeaders())
      .send({ name: 'bad name', mode: 'fit', width: 10, height: 10 });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_VARIANT');
  });

  it('404s variants for another tenant’s project', async () => {
    mockSession();
    mockDb.onQuery("SELECT * FROM projects WHERE id = $1 AND account_id", { rows: [] });
    const res = await request(app)
      .get(`/api/v1/projects/${testProject.id}/variants`)
      .set(sessionHeaders());
    expect(res.status).toBe(404);
  });
});

describe('purge-cache — session-scoped', () => {
  it('bumps cache_version for a file (editor)', async () => {
    mockSession({ role: 'editor' });
    accountProject();
    mockDb.onQuery('SELECT id FROM files WHERE id = $1 AND project_id', { rows: [{ id: 'f1' }] });
    mockDb.onQuery('SELECT storage_key FROM transform_cache', { rows: [] });
    mockDb.onQuery('UPDATE files SET cache_version', { rows: [{ cache_version: 3 }] });
    const res = await request(app)
      .post(`/api/v1/projects/${testProject.id}/files/f1/purge-cache`)
      .set(sessionHeaders())
      .send();
    expect(res.status).toBe(200);
    expect(res.body.cache_version).toBe(3);
  });
});

describe('srcset — session-scoped', () => {
  it('returns a srcset for an image', async () => {
    mockSession();
    accountProject();
    mockDb.onQuery('SELECT * FROM files WHERE id = $1 AND project_id', {
      rows: [{ id: 'f1', project_id: testProject.id, type: 'image', storage_key: `${testProject.id}/x.webp`, access: 'public' }],
    });
    const res = await request(app)
      .get(`/api/v1/projects/${testProject.id}/files/f1/srcset`)
      .set(sessionHeaders());
    expect(res.status).toBe(200);
    expect(res.body.srcset).toContain('320w');
  });
});

describe('named variants — API-key scoped', () => {
  it('lists variants for the key’s project', async () => {
    apiAuth(['read']);
    mockDb.onQuery('FROM named_variants WHERE project_id', { rows: [] });
    const res = await request(app)
      .get('/api/v1/variants')
      .set('X-API-Key', FULL_KEY);
    expect(res.status).toBe(200);
    expect(res.body.builtins.length).toBe(3);
  });

  it('requires admin scope to create a variant', async () => {
    apiAuth(['read']);
    const res = await request(app)
      .post('/api/v1/variants')
      .set('X-API-Key', FULL_KEY)
      .send({ name: 'card', mode: 'fill', width: 600, height: 400 });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INSUFFICIENT_SCOPE');
  });

  it('creates a variant with admin scope', async () => {
    apiAuth(['admin']);
    mockDb.onQuery('INSERT INTO named_variants', {
      rows: [{ id: 'v3', project_id: testProject.id, name: 'hero', mode: 'fit', width: 1600, height: 0, format: 'auto', quality: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
    });
    const res = await request(app)
      .post('/api/v1/variants')
      .set('X-API-Key', FULL_KEY)
      .send({ name: 'hero', mode: 'fit', width: 1600, height: 0 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe('hero');
  });

  it('purges a file cache with delete scope', async () => {
    apiAuth(['delete']);
    mockDb.onQuery('SELECT id FROM files WHERE id = $1 AND project_id', { rows: [{ id: 'f1' }] });
    mockDb.onQuery('SELECT storage_key FROM transform_cache', { rows: [] });
    mockDb.onQuery('UPDATE files SET cache_version', { rows: [{ cache_version: 2 }] });
    const res = await request(app)
      .post('/api/v1/files/f1/purge-cache')
      .set('X-API-Key', FULL_KEY)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.cache_version).toBe(2);
  });
});
