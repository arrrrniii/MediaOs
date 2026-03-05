const request = require('supertest');
const { createTestApp, mockDb, MASTER_KEY, testProject, testApiKey } = require('../setup');
const { sha256 } = require('../../src/utils/crypto');

let app;

const ADMIN_KEY = 'mv_live_admn0123456789abcdef0123456789ab';

function setupAuthenticatedRequest() {
  const prefix = ADMIN_KEY.substring(0, 12);
  const hash = sha256(ADMIN_KEY);

  mockDb.onQuery('SELECT * FROM api_keys WHERE key_prefix', {
    rows: [{ ...testApiKey, key_prefix: prefix, key_hash: hash, scopes: ['upload', 'read', 'delete', 'admin'] }],
  });
  mockDb.onQuery("SELECT * FROM projects WHERE id", { rows: [testProject] });
  mockDb.onQuery('UPDATE api_keys SET last_used_at', { rowCount: 1 });
}

beforeEach(() => {
  mockDb.reset();
  app = createTestApp();
});

describe('Webhooks API', () => {
  // ── POST /api/v1/webhooks ──────────────────────────
  describe('POST /api/v1/webhooks', () => {
    it('should create webhook with URL and events', async () => {
      setupAuthenticatedRequest();

      const res = await request(app)
        .post('/api/v1/webhooks')
        .set('X-API-Key', ADMIN_KEY)
        .send({
          url: 'https://example.com/hook',
          events: ['file.uploaded', 'file.deleted'],
        });

      expect(res.status).toBe(201);
      expect(res.body.url).toBe('https://example.com/hook');
      expect(res.body.secret).toBeDefined();
      expect(res.body.secret).toMatch(/^whsec_/);
    });

    it('should require URL', async () => {
      setupAuthenticatedRequest();

      const res = await request(app)
        .post('/api/v1/webhooks')
        .set('X-API-Key', ADMIN_KEY)
        .send({ events: ['file.uploaded'] });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('should require admin scope', async () => {
      const readKey = 'mv_live_rdonly23456789abcdef0123456789ab';
      const prefix = readKey.substring(0, 12);
      const hash = sha256(readKey);

      mockDb.onQuery('SELECT * FROM api_keys WHERE key_prefix', {
        rows: [{ ...testApiKey, key_prefix: prefix, key_hash: hash, scopes: ['read'] }],
      });
      mockDb.onQuery("SELECT * FROM projects WHERE id", { rows: [testProject] });
      mockDb.onQuery('UPDATE api_keys SET last_used_at', { rowCount: 1 });

      const res = await request(app)
        .post('/api/v1/webhooks')
        .set('X-API-Key', readKey)
        .send({ url: 'https://example.com/hook' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_SCOPE');
    });
  });

  // ── GET /api/v1/webhooks ───────────────────────────
  describe('GET /api/v1/webhooks', () => {
    it('should list webhooks', async () => {
      setupAuthenticatedRequest();

      const res = await request(app)
        .get('/api/v1/webhooks')
        .set('X-API-Key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(Array.isArray(res.body.data)).toBe(true);
    });
  });

  // ── DELETE /api/v1/webhooks/:id ────────────────────
  describe('DELETE /api/v1/webhooks/:id', () => {
    it('should delete a webhook', async () => {
      setupAuthenticatedRequest();

      const res = await request(app)
        .delete('/api/v1/webhooks/wh-test-id')
        .set('X-API-Key', ADMIN_KEY);

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
    });
  });
});
