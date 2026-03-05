const request = require('supertest');
const { createTestApp, mockDb, MASTER_KEY, testProject, testAccount } = require('../setup');

let app;

beforeEach(() => {
  mockDb.reset();
  app = createTestApp();
});

describe('Projects API', () => {
  // ── POST /api/v1/projects ──────────────────────────
  describe('POST /api/v1/projects', () => {
    it('should create project with valid data', async () => {
      // Account exists
      mockDb.onQuery('SELECT id FROM accounts', { rows: [{ id: testAccount.id }] });
      // No duplicate slug
      mockDb.onQuery('SELECT id FROM projects WHERE account_id', { rows: [] });
      // Insert
      mockDb.onQuery('INSERT INTO projects', { rows: [testProject], rowCount: 1 });

      const res = await request(app)
        .post('/api/v1/projects')
        .set('X-API-Key', MASTER_KEY)
        .send({
          account_id: testAccount.id,
          name: 'Test Project',
          description: 'A test project',
        });

      expect(res.status).toBe(201);
      expect(res.body.name).toBe('Test Project');
      expect(res.body.slug).toBe('test-project');
      expect(res.body.signing_secret).toBeDefined();
    });

    it('should auto-generate slug from name', async () => {
      mockDb.onQuery('SELECT id FROM accounts', { rows: [{ id: testAccount.id }] });
      mockDb.onQuery('SELECT id FROM projects WHERE account_id', { rows: [] });
      mockDb.onQuery('INSERT INTO projects', { rows: [testProject], rowCount: 1 });

      const res = await request(app)
        .post('/api/v1/projects')
        .set('X-API-Key', MASTER_KEY)
        .send({ account_id: testAccount.id, name: 'My Cool Project!' });

      expect(res.status).toBe(201);
      // Check the slug was generated from the name
      const insertCall = mockDb.queryCalls.find(c => c.text.includes('INSERT INTO projects'));
      expect(insertCall.params[2]).toBe('my-cool-project'); // slug param
    });

    it('should reject duplicate slug for same account', async () => {
      mockDb.onQuery('SELECT id FROM accounts', { rows: [{ id: testAccount.id }] });
      mockDb.onQuery('SELECT id FROM projects WHERE account_id', { rows: [{ id: 'existing' }] });

      const res = await request(app)
        .post('/api/v1/projects')
        .set('X-API-Key', MASTER_KEY)
        .send({ account_id: testAccount.id, name: 'Test Project' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('DUPLICATE_SLUG');
    });

    it('should require account_id and name', async () => {
      const res = await request(app)
        .post('/api/v1/projects')
        .set('X-API-Key', MASTER_KEY)
        .send({ name: 'Test' });

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });

    it('should reject non-existent account', async () => {
      mockDb.onQuery('SELECT id FROM accounts', { rows: [] });

      const res = await request(app)
        .post('/api/v1/projects')
        .set('X-API-Key', MASTER_KEY)
        .send({ account_id: 'nonexistent', name: 'Test' });

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('ACCOUNT_NOT_FOUND');
    });
  });

  // ── GET /api/v1/projects ───────────────────────────
  describe('GET /api/v1/projects', () => {
    it('should list projects with pagination', async () => {
      mockDb.onQuery('SELECT COUNT', { rows: [{ count: '1' }] });
      mockDb.onQuery('SELECT id, account_id', { rows: [testProject] });

      const res = await request(app)
        .get('/api/v1/projects')
        .set('X-API-Key', MASTER_KEY);

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.total).toBe(1);
    });

    it('should filter by account_id', async () => {
      mockDb.onQuery('SELECT COUNT', { rows: [{ count: '1' }] });
      mockDb.onQuery('SELECT id, account_id', { rows: [testProject] });

      const res = await request(app)
        .get(`/api/v1/projects?account_id=${testAccount.id}`)
        .set('X-API-Key', MASTER_KEY);

      expect(res.status).toBe(200);
      const countCall = mockDb.queryCalls.find(c => c.text.includes('COUNT'));
      expect(countCall.params).toContain(testAccount.id);
    });

    it('should exclude deleted projects', async () => {
      mockDb.onQuery('SELECT COUNT', { rows: [{ count: '0' }] });
      mockDb.onQuery('SELECT id, account_id', { rows: [] });

      await request(app)
        .get('/api/v1/projects')
        .set('X-API-Key', MASTER_KEY);

      // Check that query filters out deleted
      const countCall = mockDb.queryCalls.find(c => c.text.includes('COUNT'));
      expect(countCall.text).toContain("status != 'deleted'");
    });
  });

  // ── GET /api/v1/projects/:id ───────────────────────
  describe('GET /api/v1/projects/:id', () => {
    it('should return project with usage data', async () => {
      mockDb.onQuery('SELECT id, account_id', { rows: [testProject] });

      const res = await request(app)
        .get(`/api/v1/projects/${testProject.id}`)
        .set('X-API-Key', MASTER_KEY);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(testProject.id);
      expect(res.body.usage).toBeDefined();
    });

    it('should return 404 for non-existent project', async () => {
      mockDb.onQuery('SELECT id, account_id', { rows: [] });

      const res = await request(app)
        .get('/api/v1/projects/nonexistent')
        .set('X-API-Key', MASTER_KEY);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });

  // ── PATCH /api/v1/projects/:id ─────────────────────
  describe('PATCH /api/v1/projects/:id', () => {
    it('should update project name', async () => {
      mockDb.onQuery('SELECT * FROM projects', { rows: [testProject] });
      mockDb.onQuery('UPDATE projects SET', { rows: [{ ...testProject, name: 'Updated' }] });

      const res = await request(app)
        .patch(`/api/v1/projects/${testProject.id}`)
        .set('X-API-Key', MASTER_KEY)
        .send({ name: 'Updated' });

      expect(res.status).toBe(200);
    });

    it('should merge settings', async () => {
      mockDb.onQuery('SELECT * FROM projects', { rows: [testProject] });
      mockDb.onQuery('UPDATE projects SET', {
        rows: [{ ...testProject, settings: { ...testProject.settings, webp_quality: 90 } }],
      });

      const res = await request(app)
        .patch(`/api/v1/projects/${testProject.id}`)
        .set('X-API-Key', MASTER_KEY)
        .send({ settings: { webp_quality: 90 } });

      expect(res.status).toBe(200);
    });

    it('should reject with no fields', async () => {
      mockDb.onQuery('SELECT * FROM projects', { rows: [testProject] });

      const res = await request(app)
        .patch(`/api/v1/projects/${testProject.id}`)
        .set('X-API-Key', MASTER_KEY)
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
    });
  });

  // ── DELETE /api/v1/projects/:id ────────────────────
  describe('DELETE /api/v1/projects/:id', () => {
    it('should soft-delete project and cascade', async () => {
      mockDb.onQuery("UPDATE projects SET status = 'deleted'", { rowCount: 1 });
      // Cascade queries (fire-and-forget)
      mockDb.onQuery('UPDATE files SET deleted_at', { rowCount: 5 });
      mockDb.onQuery("UPDATE api_keys SET status = 'revoked'", { rowCount: 2 });

      const res = await request(app)
        .delete(`/api/v1/projects/${testProject.id}`)
        .set('X-API-Key', MASTER_KEY);

      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);
    });

    it('should return 404 for non-existent project', async () => {
      mockDb.onQuery("UPDATE projects SET status = 'deleted'", { rowCount: 0 });

      const res = await request(app)
        .delete('/api/v1/projects/nonexistent')
        .set('X-API-Key', MASTER_KEY);

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });
});
