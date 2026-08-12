const request = require('supertest');
const {
  createTestApp,
  mockDb,
  mockSession,
  sessionHeaders,
  testProject,
} = require('../setup');

let app;

beforeEach(() => {
  mockDb.reset();
  app = createTestApp();
});

// loadProject resolves the project against the session account, so every
// handler here already ran an ownership check.
function mockProjectLookup(rows = [testProject]) {
  mockDb.onQuery("SELECT * FROM projects WHERE id", { rows });
}

describe('API Keys', () => {
  // ── POST /api/v1/projects/:id/keys ─────────────────
  describe('POST /api/v1/projects/:id/keys', () => {
    it('should create API key with valid scopes', async () => {
      mockSession();
      mockProjectLookup();
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
        .set(sessionHeaders())
        .send({ name: 'My Key', scopes: ['upload', 'read'] });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('My Key');
      expect(res.body.key).toBeDefined(); // Full key returned on creation
      expect(res.body.key).toMatch(/^mv_live_/);
    });

    it('should reject invalid scopes', async () => {
      mockSession();
      mockProjectLookup();

      const res = await request(app)
        .post(`/api/v1/projects/${testProject.id}/keys`)
        .set(sessionHeaders())
        .send({ name: 'Bad Key', scopes: ['upload', 'superadmin'] });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_SCOPES');
    });

    it('should reject for non-existent project', async () => {
      mockSession();
      mockProjectLookup([]);

      const res = await request(app)
        .post('/api/v1/projects/nonexistent/keys')
        .set(sessionHeaders())
        .send({ name: 'Key' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('should reject an editor', async () => {
      mockSession({ role: 'editor' });

      const res = await request(app)
        .post(`/api/v1/projects/${testProject.id}/keys`)
        .set(sessionHeaders())
        .send({ name: 'Key' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    });
  });

  // ── GET /api/v1/projects/:id/keys ──────────────────
  describe('GET /api/v1/projects/:id/keys', () => {
    it('should list keys without exposing hashes', async () => {
      mockSession();
      mockProjectLookup();
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
        .set(sessionHeaders());

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].key_hash).toBeUndefined(); // Hash not exposed
      expect(res.body.data[0].key_prefix).toBeDefined();
    });
  });

  // ── POST /api/v1/projects/:id/keys/:keyId/reveal ───
  describe('POST /api/v1/projects/:id/keys/:keyId/reveal', () => {
    it('should filter the reveal on both key id and project id', async () => {
      mockSession();
      mockProjectLookup();
      mockDb.onQuery('SELECT encrypted_key FROM api_keys', { rows: [] });

      const res = await request(app)
        .post(`/api/v1/projects/${testProject.id}/keys/key-from-another-project/reveal`)
        .set(sessionHeaders());

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');

      const call = mockDb.queryCalls.find(c => c.text.includes('SELECT encrypted_key'));
      expect(call.text).toContain('project_id = $2');
      expect(call.params).toEqual(['key-from-another-project', testProject.id]);
    });
  });

  // ── DELETE /api/v1/projects/:id/keys/:keyId ────────
  describe('DELETE /api/v1/projects/:id/keys/:keyId', () => {
    it('should revoke an active key', async () => {
      mockSession();
      mockProjectLookup();
      mockDb.onQuery("UPDATE api_keys SET status = 'revoked'", { rowCount: 1 });

      const res = await request(app)
        .delete(`/api/v1/projects/${testProject.id}/keys/key-1`)
        .set(sessionHeaders());

      expect(res.status).toBe(200);
      expect(res.body.revoked).toBe(true);
    });

    it('should return 404 for non-existent key', async () => {
      mockSession();
      mockProjectLookup();
      mockDb.onQuery("UPDATE api_keys SET status = 'revoked'", { rowCount: 0 });

      const res = await request(app)
        .delete(`/api/v1/projects/${testProject.id}/keys/nonexistent`)
        .set(sessionHeaders());

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('should filter the revoke on both key id and project id', async () => {
      mockSession();
      mockProjectLookup();
      mockDb.onQuery("UPDATE api_keys SET status = 'revoked'", { rowCount: 0 });

      await request(app)
        .delete(`/api/v1/projects/${testProject.id}/keys/key-from-another-project`)
        .set(sessionHeaders());

      const call = mockDb.queryCalls.find(c => c.text.includes("UPDATE api_keys SET status = 'revoked'"));
      expect(call.text).toContain('project_id = $2');
      expect(call.params).toEqual(['key-from-another-project', testProject.id]);
    });
  });
});
