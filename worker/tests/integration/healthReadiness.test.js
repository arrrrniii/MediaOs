const request = require('supertest');
const { createTestApp, mockDb } = require('../setup');

let app;

beforeEach(() => {
  mockDb.reset();
  app = createTestApp();
});

describe('Liveness / Readiness', () => {
  it('GET /health/live always returns 200 alive', async () => {
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('alive');
    expect(typeof res.body.uptime).toBe('number');
  });

  it('GET /health/ready returns 200 when PG, migrations, and MinIO are healthy', async () => {
    // checkPostgres (SELECT 1) does not throw with the mock; migrations must
    // report at least one applied row; MinIO bucketExists is mocked true.
    mockDb.onQuery('_migrations', { rows: [{ n: 1 }] });
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    expect(res.body.checks.postgres).toBe(true);
    expect(res.body.checks.migrations_applied).toBe(true);
    expect(res.body.checks.minio).toBe(true);
  });

  it('GET /health/ready returns 503 when a dependency check fails (no migrations)', async () => {
    // Do not prime the _migrations count → it reports 0 applied → not ready.
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('not_ready');
    expect(res.body.checks.migrations_applied).toBe(false);
  });
});
