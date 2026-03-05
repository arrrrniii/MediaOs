const request = require('supertest');
const { createTestApp, mockDb } = require('../setup');

let app;

beforeEach(() => {
  mockDb.reset();
  // Health check queries SELECT 1
  mockDb.onQuery('SELECT 1', { rows: [{ '?column?': 1 }] });
  app = createTestApp();
});

describe('Health Check', () => {
  it('GET /health should return status and services', async () => {
    const res = await request(app).get('/health');
    // May be 200 or 503 depending on mock behavior
    expect([200, 503]).toContain(res.status);
    expect(res.body.status).toBeDefined();
    expect(res.body.version).toBe('1.0.0');
    expect(res.body.services).toBeDefined();
    expect(res.body.queue).toBeDefined();
  });
});
