const request = require('supertest');
const {
  createTestApp,
  mockDb,
  mockSession,
  sessionHeaders,
  INTERNAL_SECRET,
  testProject,
  testUser,
  testAccount,
} = require('../setup');

let app;

beforeEach(() => {
  mockDb.reset();
  app = createTestApp();
});

describe('sessionAuth middleware', () => {
  describe('internal secret', () => {
    it('should reject a request with no internal secret', async () => {
      const res = await request(app)
        .get('/api/v1/projects')
        .set('x-user-id', testUser.id)
        .set('x-account-id', testAccount.id);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INTERNAL_SECRET_REQUIRED');
    });

    it('should reject a wrong internal secret', async () => {
      const res = await request(app)
        .get('/api/v1/projects')
        .set(sessionHeaders({ secret: 'not-the-secret-at-all!!' }));

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INTERNAL_SECRET_INVALID');
    });

    it('should reject a secret of the right length but wrong value', async () => {
      const wrong = 'x'.repeat(INTERNAL_SECRET.length);

      const res = await request(app)
        .get('/api/v1/projects')
        .set(sessionHeaders({ secret: wrong }));

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INTERNAL_SECRET_INVALID');
    });
  });

  describe('identity headers', () => {
    it('should require x-user-id', async () => {
      const res = await request(app)
        .get('/api/v1/projects')
        .set('x-internal-secret', INTERNAL_SECRET)
        .set('x-account-id', testAccount.id);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('SESSION_REQUIRED');
    });

    it('should require x-account-id', async () => {
      const res = await request(app)
        .get('/api/v1/projects')
        .set('x-internal-secret', INTERNAL_SECRET)
        .set('x-user-id', testUser.id);

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('SESSION_REQUIRED');
    });

    it('should reject an unknown or inactive user', async () => {
      mockDb.onQuery('SELECT id, email, name, status FROM users', { rows: [] });

      const res = await request(app)
        .get('/api/v1/projects')
        .set(sessionHeaders());

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('USER_INVALID');
    });
  });

  describe('membership', () => {
    it('should reject a user with no membership in the account', async () => {
      mockSession({ membership: false });

      const res = await request(app)
        .get('/api/v1/projects')
        .set(sessionHeaders());

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('NOT_A_MEMBER');
    });

    it('should look the membership up by both user and account', async () => {
      mockSession({ membership: false });

      await request(app)
        .get('/api/v1/projects')
        .set(sessionHeaders());

      const call = mockDb.queryCalls.find(c => c.text.includes('FROM account_memberships m'));
      expect(call.params).toEqual([testUser.id, testAccount.id]);
      expect(call.text).toContain("a.status = 'active'");
    });
  });

  describe('role enforcement', () => {
    it('should let a viewer read a project', async () => {
      mockSession({ role: 'viewer' });
      mockDb.onQuery('SELECT id, account_id', { rows: [testProject] });

      const res = await request(app)
        .get(`/api/v1/projects/${testProject.id}`)
        .set(sessionHeaders());

      expect(res.status).toBe(200);
    });

    it('should not let a viewer delete a project', async () => {
      mockSession({ role: 'viewer' });

      const res = await request(app)
        .delete(`/api/v1/projects/${testProject.id}`)
        .set(sessionHeaders());

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    });

    it('should not let a viewer upload a file', async () => {
      mockSession({ role: 'viewer' });

      const res = await request(app)
        .post(`/api/v1/projects/${testProject.id}/upload`)
        .set(sessionHeaders())
        .attach('file', Buffer.from('data'), 'test.png');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    });

    it('should let an editor delete a file', async () => {
      mockSession({ role: 'editor' });
      mockDb.onQuery('SELECT * FROM projects WHERE id', { rows: [testProject] });
      mockDb.onQuery('SELECT * FROM files', { rows: [] });

      const res = await request(app)
        .delete(`/api/v1/projects/${testProject.id}/files/some-file`)
        .set(sessionHeaders());

      expect(res.status).not.toBe(403);
    });

    it('should not let an editor create a webhook', async () => {
      mockSession({ role: 'editor' });

      const res = await request(app)
        .post(`/api/v1/projects/${testProject.id}/webhooks`)
        .set(sessionHeaders())
        .send({ url: 'https://example.com/hook' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    });

    it('should admit an owner where admin is required', async () => {
      mockSession({ role: 'owner' });
      mockDb.onQuery('SELECT * FROM projects WHERE id', { rows: [testProject] });

      const res = await request(app)
        .get(`/api/v1/projects/${testProject.id}/webhooks`)
        .set(sessionHeaders());

      expect(res.status).toBe(200);
    });
  });
});
