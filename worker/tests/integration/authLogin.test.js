const request = require('supertest');
const bcrypt = require('bcrypt');
const {
  createTestApp,
  mockDb,
  INTERNAL_SECRET,
  MASTER_KEY,
  testAccount,
  testUser,
} = require('../setup');

let app;

beforeEach(() => {
  mockDb.reset();
  app = createTestApp();
});

function post(body) {
  return request(app)
    .post('/api/v1/auth/login')
    .set('x-internal-secret', INTERNAL_SECRET)
    .send(body);
}

describe('POST /api/v1/auth/login', () => {
  describe('access control', () => {
    it('should require the internal secret', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .send({ email: 'test@example.com', password: 'correctpassword' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INTERNAL_SECRET_REQUIRED');
    });

    it('should reject the master key in place of the internal secret', async () => {
      const res = await request(app)
        .post('/api/v1/auth/login')
        .set('x-internal-secret', MASTER_KEY)
        .send({ email: 'test@example.com', password: 'correctpassword' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INTERNAL_SECRET_INVALID');
    });
  });

  describe('user credentials', () => {
    it('should return the user and their account memberships', async () => {
      const hash = await bcrypt.hash('correctpassword', 12);

      mockDb.onQuery('FROM users WHERE email', {
        rows: [{ ...testUser, password_hash: hash }],
      });
      mockDb.onQuery('FROM account_memberships m', {
        rows: [
          { id: testAccount.id, name: testAccount.name, plan: 'pro', role: 'owner' },
          { id: 'acc-second', name: 'Second Co', plan: 'free', role: 'editor' },
        ],
      });

      const res = await post({ email: testUser.email, password: 'correctpassword' });

      expect(res.status).toBe(200);
      expect(res.body.user).toEqual({
        id: testUser.id,
        name: testUser.name,
        email: testUser.email,
      });
      expect(res.body.accounts).toHaveLength(2);
      expect(res.body.accounts[0]).toEqual({
        id: testAccount.id,
        name: testAccount.name,
        plan: 'pro',
        role: 'owner',
      });
      expect(res.body.user.password_hash).toBeUndefined();
    });

    it('should reject a wrong password', async () => {
      const hash = await bcrypt.hash('correctpassword', 12);
      mockDb.onQuery('FROM users WHERE email', {
        rows: [{ ...testUser, password_hash: hash }],
      });

      const res = await post({ email: testUser.email, password: 'wrongpassword' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_INVALID');
    });

    it('should give the same generic error for an unknown email', async () => {
      const res = await post({ email: 'nobody@example.com', password: 'whatever' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_INVALID');
      expect(res.body.error).toBe('Invalid email or password');
    });

    it('should require email and password', async () => {
      const res = await post({ email: 'test@example.com' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('should return no accounts for a user with no memberships', async () => {
      const hash = await bcrypt.hash('correctpassword', 12);
      mockDb.onQuery('FROM users WHERE email', {
        rows: [{ ...testUser, password_hash: hash }],
      });
      mockDb.onQuery('FROM account_memberships m', { rows: [] });

      const res = await post({ email: testUser.email, password: 'correctpassword' });

      expect(res.status).toBe(200);
      expect(res.body.accounts).toEqual([]);
    });
  });

  describe('legacy account fallback', () => {
    it('should promote a pre-005 account row to a user with an owner membership', async () => {
      const hash = await bcrypt.hash('correctpassword', 12);

      // No users row yet
      mockDb.onQuery('FROM users WHERE email', { rows: [] });
      mockDb.onQuery('FROM accounts WHERE email', {
        rows: [{
          id: testAccount.id,
          name: testAccount.name,
          email: testAccount.email,
          password_hash: hash,
        }],
      });
      mockDb.onQuery('INSERT INTO users', {
        rows: [{ id: testUser.id, email: testAccount.email, name: testAccount.name, status: 'active' }],
      });
      mockDb.onQuery('INSERT INTO account_memberships', { rowCount: 1 });
      mockDb.onQuery('FROM account_memberships m', {
        rows: [{ id: testAccount.id, name: testAccount.name, plan: 'pro', role: 'owner' }],
      });

      const res = await post({ email: testAccount.email, password: 'correctpassword' });

      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe(testUser.id);
      expect(res.body.accounts[0].role).toBe('owner');

      const membershipInsert = mockDb.queryCalls.find(c =>
        c.text.includes('INSERT INTO account_memberships'));
      expect(membershipInsert.params).toEqual([testUser.id, testAccount.id]);
    });

    it('should not fall back when the legacy password is wrong', async () => {
      const hash = await bcrypt.hash('correctpassword', 12);

      mockDb.onQuery('FROM users WHERE email', { rows: [] });
      mockDb.onQuery('FROM accounts WHERE email', {
        rows: [{
          id: testAccount.id,
          name: testAccount.name,
          email: testAccount.email,
          password_hash: hash,
        }],
      });

      const res = await post({ email: testAccount.email, password: 'wrongpassword' });

      expect(res.status).toBe(401);
      expect(mockDb.queryCalls.some(c => c.text.includes('INSERT INTO users'))).toBe(false);
    });
  });
});
