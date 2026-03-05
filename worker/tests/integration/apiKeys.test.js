const request = require('supertest');
const { createTestApp, mockDb, MASTER_KEY, testProject } = require('../setup');

let app;

beforeEach(() => {
  mockDb.reset();
  app = createTestApp();
});

describe('API Keys', () => {
  // ── POST /api/v1/projects/:id/keys ─────────────────
  describe('POST /api/v1/projects/:id/keys', () => {
    it('should create API key with valid scopes', async () => {
      // Project exists
      mockDb.onQuery('SELECT id FROM projects', { rows: [{ id: testProject.id }] });
      // Insert key
      mockDb.onQuery('INSERT INTO api_keys', {
        rows: [{
          id: 'new-key-id',
          name: 'My Key',
          key_prefix: 'mv_live_abc',
          scopes: ['upload', 'read'],
          status: 'active',
          rate_limit: 100,
          expires_at: null,
          created_at: new Date().toISOString(),
        }],
      });

      const res = await request(app)
        .post(`/api/v1/projects/${testProject.id}/keys`)
        .set('X-API-Key', MASTER_KEY)
        .send({ name: 'My Key', scopes: ['upload', 'read'] });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('My Key');
      expect(res.body.key).toBeDefined(); // Full key returned on creation
      expect(res.body.key).toMatch(/^mv_live_/);
    });

    it('should reject invalid scopes', async () => {
      const res = await request(app)
        .post(`/api/v1/projects/${testProject.id}/keys`)
        .set('X-API-Key', MASTER_KEY)
        .send({ name: 'Bad Key', scopes: ['upload', 'superadmin'] });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SCOPES');
    });

    it('should reject for non-existent project', async () => {
      mockDb.onQuery('SELECT id FROM projects', { rows: [] });

      const res = await request(app)
        .post('/api/v1/projects/nonexistent/keys')
        .set('X-API-Key', MASTER_KEY)
        .send({ name: 'Key' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });

  // ── GET /api/v1/projects/:id/keys ──────────────────
  describe('GET /api/v1/projects/:id/keys', () => {
    it('should list keys without exposing hashes', async () => {
      mockDb.onQuery('SELECT id, name, key_prefix', {
        rows: [{
          id: 'key-1',
          name: 'Key 1',
          key_prefix: 'mv_live_abc',
          scopes: ['upload', 'read'],
          status: 'active',
          rate_limit: 100,
          last_used_at: null,
          expires_at: null,
          created_at: new Date().toISOString(),
        }],
      });

      const res = await request(app)
        .get(`/api/v1/projects/${testProject.id}/keys`)
        .set('X-API-Key', MASTER_KEY);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].key_hash).toBeUndefined(); // Hash not exposed
      expect(res.body.data[0].key_prefix).toBeDefined();
    });
  });

  // ── DELETE /api/v1/projects/:id/keys/:keyId ────────
  describe('DELETE /api/v1/projects/:id/keys/:keyId', () => {
    it('should revoke an active key', async () => {
      mockDb.onQuery("UPDATE api_keys SET status = 'revoked'", { rowCount: 1 });

      const res = await request(app)
        .delete(`/api/v1/projects/${testProject.id}/keys/key-1`)
        .set('X-API-Key', MASTER_KEY);

      expect(res.status).toBe(200);
      expect(res.body.revoked).toBe(true);
    });

    it('should return 404 for non-existent key', async () => {
      mockDb.onQuery("UPDATE api_keys SET status = 'revoked'", { rowCount: 0 });

      const res = await request(app)
        .delete(`/api/v1/projects/${testProject.id}/keys/nonexistent`)
        .set('X-API-Key', MASTER_KEY);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });
});
