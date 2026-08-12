const request = require('supertest');
const { createTestApp, mockDb, MASTER_KEY } = require('../setup');

let app;

beforeEach(() => {
  mockDb.reset();
  app = createTestApp();
});

describe('GET /metrics', () => {
  it('requires the master key when METRICS_PUBLIC/METRICS_TOKEN are unset', async () => {
    const res = await request(app).get('/metrics');
    expect(res.status).toBe(401);
  });

  it('rejects a wrong master key', async () => {
    const res = await request(app).get('/metrics').set('x-api-key', 'nope');
    expect(res.status).toBe(403);
  });

  it('returns Prometheus text with a known metric when authorized', async () => {
    const res = await request(app).get('/metrics').set('x-api-key', MASTER_KEY);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('http_requests_total');
    // A default Node metric is present too.
    expect(res.text).toMatch(/process_cpu_user_seconds_total|nodejs_/);
  });

  it('increments http_requests_total for a served request', async () => {
    // Drive one request through the app, then scrape.
    await request(app).get('/health');
    await new Promise((r) => setImmediate(r));

    const res = await request(app).get('/metrics').set('x-api-key', MASTER_KEY);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/http_requests_total\{[^}]*method="GET"[^}]*\}\s+\d+/);
  });
});
