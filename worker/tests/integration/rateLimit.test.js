const request = require('supertest');
const {
  createTestApp,
  mockDb,
  INTERNAL_SECRET,
  testProject,
  testApiKey,
} = require('../setup');
const { sha256 } = require('../../src/utils/crypto');

let app;

beforeEach(() => {
  mockDb.reset();
  app = createTestApp();
});

// No Redis in tests, so these exercise the in-memory fallback path.
describe('Login rate limiting', () => {
  it('should 429 after 10 failed attempts in a window', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('x-internal-secret', INTERNAL_SECRET)
        .send({ email: 'attacker@example.com', password: `guess-${i}` });
      expect(res.status).toBe(401);
    }

    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('x-internal-secret', INTERNAL_SECRET)
      .send({ email: 'attacker@example.com', password: 'guess-11' });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(res.body.retry_after).toBeGreaterThan(0);
    expect(res.headers['retry-after']).toBeDefined();
  });

  it('should count attempts per email as well as per IP', async () => {
    // Ten attempts spread over ten emails stay under the per-email limit but
    // still exhaust the per-IP one.
    for (let i = 0; i < 10; i++) {
      await request(app)
        .post('/api/v1/auth/login')
        .set('x-internal-secret', INTERNAL_SECRET)
        .send({ email: `user${i}@example.com`, password: 'guess' });
    }

    const res = await request(app)
      .post('/api/v1/auth/login')
      .set('x-internal-secret', INTERNAL_SECRET)
      .send({ email: 'fresh@example.com', password: 'guess' });

    expect(res.status).toBe(429);
  });

  it('should rate limit the legacy accounts login too', async () => {
    for (let i = 0; i < 10; i++) {
      await request(app)
        .post('/api/v1/accounts/login')
        .send({ email: 'attacker@example.com', password: `guess-${i}` });
    }

    const res = await request(app)
      .post('/api/v1/accounts/login')
      .send({ email: 'attacker@example.com', password: 'guess-11' });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
  });

  it('should check the internal secret before spending a login attempt', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'attacker@example.com', password: 'guess' });

    expect(res.status).toBe(401);
    expect(res.body.code).toBe('INTERNAL_SECRET_REQUIRED');
  });
});

describe('Setup rate limiting', () => {
  it('should 429 account creation after 5 attempts in a window', async () => {
    for (let i = 0; i < 5; i++) {
      mockDb.onQuery('SELECT COUNT', { rows: [{ count: '1' }] });
      const res = await request(app)
        .post('/api/v1/setup')
        .send({ name: 'Admin', email: 'a@example.com', password: 'password123' });
      expect(res.status).toBe(403);
    }

    const res = await request(app)
      .post('/api/v1/setup')
      .send({ name: 'Admin', email: 'a@example.com', password: 'password123' });

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
  });

  it('should let the needsSetup probe through more often', async () => {
    // The login page polls this on every load, so it must survive well past
    // the account-creation limit.
    for (let i = 0; i < 20; i++) {
      mockDb.onQuery('SELECT COUNT', { rows: [{ count: '1' }] });
      const res = await request(app).get('/api/v1/setup');
      expect(res.status).toBe(200);
    }
  });
});

describe('Per-API-key rate limiting', () => {
  const FULL_KEY = 'mv_live_test0123456789abcdef0123456789ab';

  // The limiter now runs inside auth(), so each request needs the key lookup
  // primed — the mock consumes one matcher per call.
  function primeKeyAuth(times, rateLimit) {
    const prefix = FULL_KEY.substring(0, 12);
    const hash = sha256(FULL_KEY);
    for (let i = 0; i < times; i++) {
      mockDb.onQuery('SELECT * FROM api_keys WHERE key_prefix', {
        rows: [{ ...testApiKey, key_prefix: prefix, key_hash: hash, rate_limit: rateLimit }],
      });
      mockDb.onQuery('SELECT * FROM projects WHERE id', { rows: [testProject] });
      mockDb.onQuery('UPDATE api_keys SET last_used_at', { rowCount: 1 });
    }
  }

  it('should 429 once the key exceeds its rate_limit', async () => {
    primeKeyAuth(5, 3);

    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/api/v1/usage').set('X-API-Key', FULL_KEY);
      statuses.push(res.status);
    }

    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses[3]).toBe(429);
    expect(statuses[4]).toBe(429);
  });

  it('should report the limit in X-RateLimit headers', async () => {
    primeKeyAuth(1, 3);

    const res = await request(app).get('/api/v1/usage').set('X-API-Key', FULL_KEY);

    expect(res.headers['x-ratelimit-limit']).toBe('3');
    expect(res.headers['x-ratelimit-remaining']).toBe('2');
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('should return retry_after on the 429', async () => {
    primeKeyAuth(3, 1);

    await request(app).get('/api/v1/usage').set('X-API-Key', FULL_KEY);
    const res = await request(app).get('/api/v1/usage').set('X-API-Key', FULL_KEY);

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('RATE_LIMITED');
    expect(res.body.retry_after).toBeGreaterThan(0);
  });

  it('should not spend a rate limit slot on an invalid key', async () => {
    const res = await request(app).get('/api/v1/usage').set('X-API-Key', 'mv_live_bogus000000000000');

    expect(res.status).toBe(403);
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  });
});
