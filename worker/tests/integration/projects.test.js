const request = require('supertest');
const {
  createTestApp,
  mockDb,
  mockSession,
  sessionHeaders,
  MASTER_KEY,
  testProject,
  testAccount,
} = require('../setup');

let app;

beforeEach(() => {
  mockDb.reset();
  app = createTestApp();
});

describe('Projects API', () => {
  // ── POST /api/v1/projects ──────────────────────────
  describe('POST /api/v1/projects', () => {
    it('should create project with valid data', async () => {
      mockSession();
      // No duplicate slug
      mockDb.onQuery('SELECT id FROM projects WHERE account_id', { rows: [] });
      // Insert
      mockDb.onQuery('INSERT INTO projects', { rows: [testProject], rowCount: 1 });

      const res = await request(app)
        .post('/api/v1/projects')
        .set(sessionHeaders())
        .send({
          name: 'Test Project',
          description: 'A test project',
        });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Test Project');
      expect(res.body.slug).toBe('test-project');
      expect(res.body.signing_secret).toBeDefined();
    });

    it('should own the new project with the session account, not the body', async () => {
      mockSession();
      mockDb.onQuery('SELECT id FROM projects WHERE account_id', { rows: [] });
      mockDb.onQuery('INSERT INTO projects', { rows: [testProject], rowCount: 1 });

      const res = await request(app)
        .post('/api/v1/projects')
        .set(sessionHeaders())
        .send({ name: 'Test Project' });

      expect(res.status).toBe(201);
      const insertCall = mockDb.queryCalls.find(c => c.text.includes('INSERT INTO projects'));
      expect(insertCall.params[0]).toBe(testAccount.id);
    });

    it('should reject an account_id belonging to another account', async () => {
      mockSession();

      const res = await request(app)
        .post('/api/v1/projects')
        .set(sessionHeaders())
        .send({ account_id: 'acc-somebody-else', name: 'Test Project' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('ACCOUNT_MISMATCH');
    });

    it('should auto-generate slug from name', async () => {
      mockSession();
      mockDb.onQuery('SELECT id FROM projects WHERE account_id', { rows: [] });
      mockDb.onQuery('INSERT INTO projects', { rows: [testProject], rowCount: 1 });

      const res = await request(app)
        .post('/api/v1/projects')
        .set(sessionHeaders())
        .send({ name: 'My Cool Project!' });

      expect(res.status).toBe(201);
      // Check the slug was generated from the name
      const insertCall = mockDb.queryCalls.find(c => c.text.includes('INSERT INTO projects'));
      expect(insertCall.params[2]).toBe('my-cool-project'); // slug param
    });

    it('should reject duplicate slug for same account', async () => {
      mockSession();
      mockDb.onQuery('SELECT id FROM projects WHERE account_id', { rows: [{ id: 'existing' }] });

      const res = await request(app)
        .post('/api/v1/projects')
        .set(sessionHeaders())
        .send({ name: 'Test Project' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DUPLICATE_SLUG');
    });

    it('should require name', async () => {
      mockSession();

      const res = await request(app)
        .post('/api/v1/projects')
        .set(sessionHeaders())
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('should reject a viewer', async () => {
      mockSession({ role: 'viewer' });

      const res = await request(app)
        .post('/api/v1/projects')
        .set(sessionHeaders())
        .send({ name: 'Test Project' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    });

    it('should reject MASTER_KEY', async () => {
      const res = await request(app)
        .post('/api/v1/projects')
        .set('X-API-Key', MASTER_KEY)
        .send({ name: 'Test Project' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INTERNAL_SECRET_REQUIRED');
    });
  });

  // ── GET /api/v1/projects ───────────────────────────
  describe('GET /api/v1/projects', () => {
    it('should list projects with pagination', async () => {
      mockSession();
      mockDb.onQuery('SELECT COUNT', { rows: [{ count: '1' }] });
      mockDb.onQuery('SELECT id, account_id', { rows: [testProject] });

      const res = await request(app)
        .get('/api/v1/projects')
        .set(sessionHeaders());

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(1);
    });

    it('should always scope the list to the session account', async () => {
      mockSession();
      mockDb.onQuery('SELECT COUNT', { rows: [{ count: '1' }] });
      mockDb.onQuery('SELECT id, account_id', { rows: [testProject] });

      // An account_id query param must not widen the result set.
      const res = await request(app)
        .get('/api/v1/projects?account_id=acc-somebody-else')
        .set(sessionHeaders());

      expect(res.status).toBe(200);
      const countCall = mockDb.queryCalls.find(c => c.text.includes('COUNT'));
      expect(countCall.text).toContain('account_id = $1');
      expect(countCall.params).toEqual([testAccount.id]);
    });

    it('should exclude deleted projects', async () => {
      mockSession();
      mockDb.onQuery('SELECT COUNT', { rows: [{ count: '0' }] });
      mockDb.onQuery('SELECT id, account_id', { rows: [] });

      await request(app)
        .get('/api/v1/projects')
        .set(sessionHeaders());

      // Check that query filters out deleted
      const countCall = mockDb.queryCalls.find(c => c.text.includes('COUNT'));
      expect(countCall.text).toContain("status != 'deleted'");
    });
  });

  // ── GET /api/v1/projects/:id ───────────────────────
  describe('GET /api/v1/projects/:id', () => {
    it('should return project with usage data', async () => {
      mockSession();
      mockDb.onQuery('SELECT id, account_id', { rows: [testProject] });

      const res = await request(app)
        .get(`/api/v1/projects/${testProject.id}`)
        .set(sessionHeaders());

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(testProject.id);
      expect(res.body.usage).toBeDefined();
    });

    it('should return 404 for non-existent project', async () => {
      mockSession();
      mockDb.onQuery('SELECT id, account_id', { rows: [] });

      const res = await request(app)
        .get('/api/v1/projects/nonexistent')
        .set(sessionHeaders());

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('should scope the lookup by account_id', async () => {
      mockSession();
      mockDb.onQuery('SELECT id, account_id', { rows: [] });

      await request(app)
        .get(`/api/v1/projects/${testProject.id}`)
        .set(sessionHeaders());

      const call = mockDb.queryCalls.find(c => c.text.includes('FROM projects WHERE id'));
      expect(call.text).toContain('account_id = $2');
      expect(call.params).toEqual([testProject.id, testAccount.id]);
    });
  });

  // ── PATCH /api/v1/projects/:id ─────────────────────
  describe('PATCH /api/v1/projects/:id', () => {
    it('should update project name', async () => {
      mockSession();
      mockDb.onQuery('SELECT * FROM projects', { rows: [testProject] });
      mockDb.onQuery('UPDATE projects SET', { rows: [{ ...testProject, name: 'Updated' }] });

      const res = await request(app)
        .patch(`/api/v1/projects/${testProject.id}`)
        .set(sessionHeaders())
        .send({ name: 'Updated' });

      expect(res.status).toBe(200);
    });

    it('should merge settings', async () => {
      mockSession();
      mockDb.onQuery('SELECT * FROM projects', { rows: [testProject] });
      mockDb.onQuery('UPDATE projects SET', {
        rows: [{ ...testProject, settings: { ...testProject.settings, webp_quality: 90 } }],
      });

      const res = await request(app)
        .patch(`/api/v1/projects/${testProject.id}`)
        .set(sessionHeaders())
        .send({ settings: { webp_quality: 90 } });

      expect(res.status).toBe(200);
    });

    it('should reject with no fields', async () => {
      mockSession();
      mockDb.onQuery('SELECT * FROM projects', { rows: [testProject] });

      const res = await request(app)
        .patch(`/api/v1/projects/${testProject.id}`)
        .set(sessionHeaders())
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('should reject an editor', async () => {
      mockSession({ role: 'editor' });

      const res = await request(app)
        .patch(`/api/v1/projects/${testProject.id}`)
        .set(sessionHeaders())
        .send({ name: 'Updated' });

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    });
  });

  // ── DELETE /api/v1/projects/:id ────────────────────
  describe('DELETE /api/v1/projects/:id', () => {
    it('should soft-delete project and cascade', async () => {
      mockSession();
      mockDb.onQuery("UPDATE projects SET status = 'deleted'", { rowCount: 1 });
      // Cascade queries (fire-and-forget)
      mockDb.onQuery('UPDATE files SET deleted_at', { rowCount: 5 });
      mockDb.onQuery("UPDATE api_keys SET status = 'revoked'", { rowCount: 2 });

      const res = await request(app)
        .delete(`/api/v1/projects/${testProject.id}`)
        .set(sessionHeaders());

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);

      const call = mockDb.queryCalls.find(c => c.text.includes("SET status = 'deleted'"));
      expect(call.params).toEqual([testProject.id, testAccount.id]);
    });

    it('should return 404 for non-existent project', async () => {
      mockSession();
      mockDb.onQuery("UPDATE projects SET status = 'deleted'", { rowCount: 0 });

      const res = await request(app)
        .delete('/api/v1/projects/nonexistent')
        .set(sessionHeaders());

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('should require owner role', async () => {
      mockSession({ role: 'admin' });

      const res = await request(app)
        .delete(`/api/v1/projects/${testProject.id}`)
        .set(sessionHeaders());

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    });
  });
});
