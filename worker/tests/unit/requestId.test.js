const express = require('express');
const request = require('supertest');
const requestId = require('../../src/middleware/requestId');

function appWith(routePath = '/thing') {
  const app = express();
  app.use(requestId);
  app.get(routePath, (req, res) => res.json({ id: req.id, hasLog: typeof req.log === 'object' }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('requestId middleware', () => {
  it('generates an id and echoes it in X-Request-Id, and sets req.id + req.log', async () => {
    const res = await request(appWith()).get('/thing');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.body.id).toBe(res.headers['x-request-id']);
    expect(res.body.hasLog).toBe(true);
  });

  it('echoes a valid incoming X-Request-Id', async () => {
    const res = await request(appWith()).get('/thing').set('X-Request-Id', 'trace-123');
    expect(res.headers['x-request-id']).toBe('trace-123');
    expect(res.body.id).toBe('trace-123');
  });

  it('ignores an unsafe incoming id (newline/oversized) and generates one', async () => {
    const res = await request(appWith()).get('/thing').set('X-Request-Id', 'bad id with spaces');
    expect(res.headers['x-request-id']).not.toBe('bad id with spaces');
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('classifies hot paths (excluded from info access logging)', () => {
    expect(requestId.isHotPath('/health')).toBe(true);
    expect(requestId.isHotPath('/health/ready')).toBe(true);
    expect(requestId.isHotPath('/metrics')).toBe(true);
    expect(requestId.isHotPath('/f/abc.jpg')).toBe(true);
    expect(requestId.isHotPath('/img/abc.jpg')).toBe(true);
    expect(requestId.isHotPath('/api/v1/upload')).toBe(false);
  });
});
