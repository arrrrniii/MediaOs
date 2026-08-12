const request = require('supertest');
const { createTestApp, mockDb, testProject, testApiKey } = require('../setup');
const { sha256 } = require('../../src/utils/crypto');
const webhookService = require('../../src/services/webhookService');

let app;

const ADMIN_KEY = 'mv_live_admn0123456789abcdef0123456789ab';

function setupAuthenticatedRequest() {
  const prefix = ADMIN_KEY.substring(0, 12);
  const hash = sha256(ADMIN_KEY);

  mockDb.onQuery('SELECT * FROM api_keys WHERE key_prefix', {
    rows: [{ ...testApiKey, key_prefix: prefix, key_hash: hash, scopes: ['upload', 'read', 'delete', 'admin'] }],
  });
  mockDb.onQuery('SELECT * FROM projects WHERE id', { rows: [testProject] });
  mockDb.onQuery('UPDATE api_keys SET last_used_at', { rowCount: 1 });
}

function typedError(code, message) {
  const err = new Error(message);
  err.status = 400;
  err.code = code;
  return err;
}

beforeEach(() => {
  mockDb.reset();
  jest.clearAllMocks();
  webhookService.listWebhooks.mockResolvedValue([]);
  app = createTestApp();
});

describe('Webhook SSRF guard (route level)', () => {
  it('should return 400 INVALID_WEBHOOK_URL for a blocked target', async () => {
    setupAuthenticatedRequest();
    webhookService.createWebhook.mockRejectedValueOnce(
      typedError('INVALID_WEBHOOK_URL', 'Webhook URL host is not publicly routable')
    );

    const res = await request(app)
      .post('/api/v1/webhooks')
      .set('X-API-Key', ADMIN_KEY)
      .send({ url: 'http://169.254.169.254/latest/meta-data' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_WEBHOOK_URL');
  });

  it('should return 400 INVALID_WEBHOOK_EVENTS for unknown events', async () => {
    setupAuthenticatedRequest();
    webhookService.createWebhook.mockRejectedValueOnce(
      typedError('INVALID_WEBHOOK_EVENTS', 'Unknown event "file.exfiltrated"')
    );

    const res = await request(app)
      .post('/api/v1/webhooks')
      .set('X-API-Key', ADMIN_KEY)
      .send({ url: 'https://example.com/hook', events: ['file.exfiltrated'] });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_WEBHOOK_EVENTS');
  });

  it('should reject creation past the per-project webhook limit', async () => {
    setupAuthenticatedRequest();
    webhookService.listWebhooks.mockResolvedValue(
      new Array(20).fill(null).map((_, i) => ({ id: `wh-${i}` }))
    );

    const res = await request(app)
      .post('/api/v1/webhooks')
      .set('X-API-Key', ADMIN_KEY)
      .send({ url: 'https://example.com/hook' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WEBHOOK_LIMIT_REACHED');
    expect(webhookService.createWebhook).not.toHaveBeenCalled();
  });

  it('should still create a webhook for a valid public URL', async () => {
    setupAuthenticatedRequest();

    const res = await request(app)
      .post('/api/v1/webhooks')
      .set('X-API-Key', ADMIN_KEY)
      .send({ url: 'https://example.com/hook', events: ['file.uploaded'] });

    expect(res.status).toBe(201);
    expect(res.body.url).toBe('https://example.com/hook');
  });
});
