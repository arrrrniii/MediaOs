const request = require('supertest');
const { createTestApp, mockDb, MASTER_KEY, testAccount } = require('../setup');

let app;

beforeEach(() => {
  mockDb.reset();
  app = createTestApp();
});

describe('Accounts API', () => {
  // ── POST /api/v1/accounts ──────────────────────────
  describe('POST /api/v1/accounts', () => {
    it('should create account with valid data', async () => {
      // No duplicate
      mockDb.onQuery('SELECT id FROM accounts WHERE email', { rows: [], rowCount: 0 });
      // Insert
      mockDb.onQuery('INSERT INTO accounts', {
        rows: [{ ...testAccount, id: 'new-id' }],
        rowCount: 1,
      });

      const res = await request(app)
        .post('/api/v1/accounts')
        .set('X-API-Key', MASTER_KEY)
        .send({ name: 'Test User', email: 'test@example.com', password: 'securepass123' });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Test User');
      expect(res.body.email).toBe('test@example.com');
      expect(res.body.password_hash).toBeUndefined(); // Never expose hash
    });

    it('should reject duplicate email', async () => {
      mockDb.onQuery('SELECT id FROM accounts WHERE email', { rows: [{ id: 'existing' }], rowCount: 1 });

      const res = await request(app)
        .post('/api/v1/accounts')
        .set('X-API-Key', MASTER_KEY)
        .send({ name: 'Test', email: 'existing@example.com', password: 'pass1234' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DUPLICATE_EMAIL');
    });

    it('should require name and email', async () => {
      const res = await request(app)
        .post('/api/v1/accounts')
        .set('X-API-Key', MASTER_KEY)
        .send({ name: '' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('should reject without master key', async () => {
      const res = await request(app)
        .post('/api/v1/accounts')
        .send({ name: 'Test', email: 'test@example.com' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_REQUIRED');
    });

    it('should reject with wrong master key', async () => {
      const res = await request(app)
        .post('/api/v1/accounts')
        .set('X-API-Key', 'wrong-key')
        .send({ name: 'Test', email: 'test@example.com' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('AUTH_INVALID');
    });
  });

  // ── GET /api/v1/accounts ───────────────────────────
  describe('GET /api/v1/accounts', () => {
    it('should list accounts with pagination', async () => {
      mockDb.onQuery('SELECT COUNT', { rows: [{ count: '2' }] });
      mockDb.onQuery('SELECT id, name', {
        rows: [testAccount, { ...testAccount, id: 'acc-2', email: 'two@test.com' }],
      });

      const res = await request(app)
        .get('/api/v1/accounts?page=1&limit=10')
        .set('X-API-Key', MASTER_KEY);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(2);
      expect(res.body.total).toBe(2);
      expect(res.body.page).toBe(1);
      expect(res.body.limit).toBe(10);
    });

    it('should filter by status', async () => {
      mockDb.onQuery('SELECT COUNT', { rows: [{ count: '1' }] });
      mockDb.onQuery('SELECT id, name', { rows: [testAccount] });

      const res = await request(app)
        .get('/api/v1/accounts?status=active')
        .set('X-API-Key', MASTER_KEY);

      expect(res.status).toBe(200);
      // Verify status param was passed
      const countCall = mockDb.queryCalls.find(c => c.text.includes('COUNT'));
      expect(countCall.params).toContain('active');
    });
  });

  // ── POST /api/v1/accounts/login ────────────────────
  describe('POST /api/v1/accounts/login', () => {
    it('should login with correct credentials', async () => {
      const bcrypt = require('bcrypt');
      const hash = await bcrypt.hash('correctpassword', 12);

      mockDb.onQuery('SELECT * FROM accounts', {
        rows: [{ ...testAccount, password_hash: hash }],
      });

      const res = await request(app)
        .post('/api/v1/accounts/login')
        .send({ email: 'test@example.com', password: 'correctpassword' });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(testAccount.id);
      expect(res.body.email).toBe(testAccount.email);
      expect(res.body.password_hash).toBeUndefined();
    });

    it('should reject wrong password', async () => {
      const bcrypt = require('bcrypt');
      const hash = await bcrypt.hash('correctpassword', 12);

      mockDb.onQuery('SELECT * FROM accounts', {
        rows: [{ ...testAccount, password_hash: hash }],
      });

      const res = await request(app)
        .post('/api/v1/accounts/login')
        .send({ email: 'test@example.com', password: 'wrongpassword' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_INVALID');
    });

    it('should reject unknown email', async () => {
      mockDb.onQuery('SELECT * FROM accounts', { rows: [] });

      const res = await request(app)
        .post('/api/v1/accounts/login')
        .send({ email: 'unknown@example.com', password: 'pass' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_INVALID');
    });

    it('should require email and password', async () => {
      const res = await request(app)
        .post('/api/v1/accounts/login')
        .send({ email: '' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  // ── PATCH /api/v1/accounts/:id/password ────────────
  describe('PATCH /api/v1/accounts/:id/password', () => {
    it('should change password with correct current password', async () => {
      const bcrypt = require('bcrypt');
      const hash = await bcrypt.hash('oldpass12', 12);

      mockDb.onQuery('SELECT id, password_hash', {
        rows: [{ id: testAccount.id, password_hash: hash }],
      });
      mockDb.onQuery('UPDATE accounts SET password_hash', { rowCount: 1 });

      const res = await request(app)
        .patch(`/api/v1/accounts/${testAccount.id}/password`)
        .set('X-API-Key', MASTER_KEY)
        .send({ current_password: 'oldpass12', new_password: 'newpass12' });

      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(true);
    });

    it('should reject wrong current password', async () => {
      const bcrypt = require('bcrypt');
      const hash = await bcrypt.hash('realpass1', 12);

      mockDb.onQuery('SELECT id, password_hash', {
        rows: [{ id: testAccount.id, password_hash: hash }],
      });

      const res = await request(app)
        .patch(`/api/v1/accounts/${testAccount.id}/password`)
        .set('X-API-Key', MASTER_KEY)
        .send({ current_password: 'wrongpass', new_password: 'newpass12' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_INVALID');
    });

    it('should reject short new password', async () => {
      const res = await request(app)
        .patch(`/api/v1/accounts/${testAccount.id}/password`)
        .set('X-API-Key', MASTER_KEY)
        .send({ current_password: 'oldpass12', new_password: 'short' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });
});
