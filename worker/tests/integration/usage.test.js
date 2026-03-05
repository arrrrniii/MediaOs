const request = require('supertest');
const { createTestApp, mockDb, testProject, testApiKey } = require('../setup');
const { sha256 } = require('../../src/utils/crypto');

let app;

const FULL_KEY = 'mv_live_test0123456789abcdef0123456789ab';

function setupAuthenticatedRequest() {
  const prefix = FULL_KEY.substring(0, 12);
  const hash = sha256(FULL_KEY);

  mockDb.onQuery('SELECT * FROM api_keys WHERE key_prefix', {
    rows: [{ ...testApiKey, key_prefix: prefix, key_hash: hash }],
  });
  mockDb.onQuery("SELECT * FROM projects WHERE id", { rows: [testProject] });
  mockDb.onQuery('UPDATE api_keys SET last_used_at', { rowCount: 1 });
}

beforeEach(() => {
  mockDb.reset();
  app = createTestApp();
});

describe('Usage API', () => {
  // ── GET /api/v1/usage ──────────────────────────────
  describe('GET /api/v1/usage', () => {
    it('should return current usage data', async () => {
      setupAuthenticatedRequest();

      const res = await request(app)
        .get('/api/v1/usage')
        .set('X-API-Key', FULL_KEY);

      expect(res.status).toBe(200);
      expect(res.body.project_id).toBeDefined();
      expect(res.body.storage).toBeDefined();
      expect(res.body.bandwidth).toBeDefined();
      expect(res.body.uploads).toBeDefined();
      expect(res.body.files).toBeDefined();
    });
  });

  // ── GET /api/v1/usage/history ──────────────────────
  describe('GET /api/v1/usage/history', () => {
    it('should return usage history', async () => {
      setupAuthenticatedRequest();

      const res = await request(app)
        .get('/api/v1/usage/history')
        .set('X-API-Key', FULL_KEY);

      expect(res.status).toBe(200);
      expect(res.body.data).toBeDefined();
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('should accept days parameter', async () => {
      setupAuthenticatedRequest();

      const res = await request(app)
        .get('/api/v1/usage/history?days=7')
        .set('X-API-Key', FULL_KEY);

      expect(res.status).toBe(200);
    });
  });
});
