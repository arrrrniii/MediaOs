const request = require('supertest');
const { createTestApp, mockDb, MASTER_KEY, testProject, testApiKey } = require('../setup');
const { sha256 } = require('../../src/utils/crypto');

let app;

beforeEach(() => {
  mockDb.reset();
  app = createTestApp();
});

describe('Auth Middleware', () => {
  // ── Admin Auth (Master Key) ────────────────────────
  describe('adminAuth', () => {
    it('should accept valid master key via X-API-Key header', async () => {
      mockDb.onQuery('SELECT COUNT', { rows: [{ count: '0' }] });
      mockDb.onQuery('SELECT id, name', { rows: [] });

      const res = await request(app)
        .get('/api/v1/accounts')
        .set('X-API-Key', MASTER_KEY);

      expect(res.status).toBe(200);
    });

    it('should accept valid master key via Bearer token', async () => {
      mockDb.onQuery('SELECT COUNT', { rows: [{ count: '0' }] });
      mockDb.onQuery('SELECT id, name', { rows: [] });

      const res = await request(app)
        .get('/api/v1/accounts')
        .set('Authorization', `Bearer ${MASTER_KEY}`);

      expect(res.status).toBe(200);
    });

    it('should reject missing key', async () => {
      const res = await request(app).get('/api/v1/accounts');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_REQUIRED');
    });

    it('should reject invalid key', async () => {
      const res = await request(app)
        .get('/api/v1/accounts')
        .set('X-API-Key', 'wrong');
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTH_INVALID');
    });
  });

  // ── Project API Key Auth ───────────────────────────
  describe('project API key auth', () => {
    function setupValidKey(fullKey) {
      const prefix = fullKey.substring(0, 12);
      const hash = sha256(fullKey);

      // Key lookup by prefix
      mockDb.onQuery('SELECT * FROM api_keys WHERE key_prefix', {
        rows: [{ ...testApiKey, key_prefix: prefix, key_hash: hash }],
      });
      // Project lookup
      mockDb.onQuery("SELECT * FROM projects WHERE id", {
        rows: [testProject],
      });
      // Update last_used_at (fire-and-forget)
      mockDb.onQuery('UPDATE api_keys SET last_used_at', { rowCount: 1 });
    }

    it('should authenticate with valid API key', async () => {
      const fullKey = 'mv_live_test0123456789abcdef0123456789ab';
      setupValidKey(fullKey);
      // listFiles queries
      mockDb.onQuery('SELECT COUNT', { rows: [{ count: '0' }] });
      mockDb.onQuery('SELECT * FROM files', { rows: [] });

      const res = await request(app)
        .get('/api/v1/files')
        .set('X-API-Key', fullKey);

      expect(res.status).toBe(200);
    });

    it('should reject invalid API key', async () => {
      mockDb.onQuery('SELECT * FROM api_keys WHERE key_prefix', { rows: [] });

      const res = await request(app)
        .get('/api/v1/files')
        .set('X-API-Key', 'mv_live_invalidkey12345678901234567890');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTH_INVALID');
    });

    it('should reject key with insufficient scope', async () => {
      const fullKey = 'mv_live_read0123456789abcdef0123456789ab';
      const prefix = fullKey.substring(0, 12);
      const hash = sha256(fullKey);

      mockDb.onQuery('SELECT * FROM api_keys WHERE key_prefix', {
        rows: [{ ...testApiKey, key_prefix: prefix, key_hash: hash, scopes: ['read'] }],
      });
      mockDb.onQuery("SELECT * FROM projects WHERE id", { rows: [testProject] });
      mockDb.onQuery('UPDATE api_keys SET last_used_at', { rowCount: 1 });

      const res = await request(app)
        .delete('/api/v1/files/some-id')
        .set('X-API-Key', fullKey);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_SCOPE');
    });

    it('should reject expired key', async () => {
      const fullKey = 'mv_live_expi0123456789abcdef0123456789ab';
      const prefix = fullKey.substring(0, 12);
      const hash = sha256(fullKey);

      mockDb.onQuery('SELECT * FROM api_keys WHERE key_prefix', {
        rows: [{
          ...testApiKey,
          key_prefix: prefix,
          key_hash: hash,
          expires_at: new Date('2020-01-01').toISOString(),
        }],
      });

      const res = await request(app)
        .get('/api/v1/files')
        .set('X-API-Key', fullKey);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTH_INVALID');
    });

    it('should reject key for inactive project', async () => {
      const fullKey = 'mv_live_inac0123456789abcdef0123456789ab';
      const prefix = fullKey.substring(0, 12);
      const hash = sha256(fullKey);

      mockDb.onQuery('SELECT * FROM api_keys WHERE key_prefix', {
        rows: [{ ...testApiKey, key_prefix: prefix, key_hash: hash }],
      });
      mockDb.onQuery("SELECT * FROM projects WHERE id", { rows: [] }); // no active project

      const res = await request(app)
        .get('/api/v1/files')
        .set('X-API-Key', fullKey);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PROJECT_INACTIVE');
    });
  });
});
