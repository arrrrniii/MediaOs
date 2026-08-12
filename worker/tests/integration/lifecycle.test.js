const request = require('supertest');
const {
  createTestApp, mockDb, sessionHeaders, mockSession, testAccount, testProject,
} = require('../setup');

let app;

beforeEach(() => {
  mockDb.reset();
  app = createTestApp();
});

describe('Lifecycle inbox API', () => {
  describe('GET /api/v1/lifecycle/inbox', () => {
    it('lists cold/delete candidates scoped to the caller\'s account, with savings + suggestion', async () => {
      mockSession({ role: 'owner' });
      mockDb.onQuery('COUNT(*)::int AS total', { rows: [{ total: 1 }] });
      mockDb.onQuery('LEFT JOIN LATERAL', {
        rows: [{
          id: 'f1', filename: 'old.webp', lifecycle_state: 'cold_candidate',
          last_accessed_at: null, access_count: 0, retention_until: null, file_size: 900,
          protected_from_delete: false, project_id: 'proj-1', project_name: 'Proj',
          physical_copies: 2, total_bytes: '1500', cold_candidate_bytes: '1200', current_tier: 'hot',
        }],
      });

      const res = await request(app)
        .get('/api/v1/lifecycle/inbox')
        .set(sessionHeaders());

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.data).toHaveLength(1);
      const row = res.body.data[0];
      expect(row.file).toEqual({ id: 'f1', name: 'old.webp' });
      expect(row.project).toEqual({ id: 'proj-1', name: 'Proj' });
      expect(row.size).toBe(1500);
      expect(row.physical_copies).toBe(2);
      expect(row.estimated_savings).toBe(1200);
      expect(row.current_tier).toBe('hot');
      expect(row.suggested_action).toBe('archive_source');

      // Account isolation: both queries are bound to the caller's account.
      const data = mockDb.queryCalls.find((c) => c.text.includes('LEFT JOIN LATERAL'));
      expect(data.params[0]).toBe(testAccount.id);
    });

    it('suggests delete_after_grace once the retention window has elapsed', async () => {
      mockSession({ role: 'viewer' });
      mockDb.onQuery('COUNT(*)::int AS total', { rows: [{ total: 1 }] });
      mockDb.onQuery('LEFT JOIN LATERAL', {
        rows: [{
          id: 'f2', filename: 'doomed.webp', lifecycle_state: 'delete_candidate',
          last_accessed_at: null, access_count: 0,
          retention_until: new Date(Date.now() - 86400000).toISOString(),
          file_size: 100, protected_from_delete: false, project_id: 'proj-1', project_name: 'Proj',
          physical_copies: 1, total_bytes: '100', cold_candidate_bytes: '0', current_tier: 'cold',
        }],
      });

      const res = await request(app).get('/api/v1/lifecycle/inbox').set(sessionHeaders());
      expect(res.body.data[0].suggested_action).toBe('delete_after_grace');
    });
  });

  describe('GET /api/v1/lifecycle/notifications', () => {
    it('returns the account\'s notifications plus an unread count', async () => {
      mockSession({ role: 'viewer' });
      mockDb.onQuery('FROM lifecycle_notifications', {
        rows: [{ id: 'n1', status: 'unread', title: 'Review', data: {} }],
      });
      mockDb.onQuery("status = 'unread'", { rows: [{ n: 1 }] });

      const res = await request(app).get('/api/v1/lifecycle/notifications').set(sessionHeaders());
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.unread_count).toBe(1);
    });
  });

  describe('POST /api/v1/projects/:id/files/:fileId/lifecycle', () => {
    it('rejects a viewer outright (editor+ required)', async () => {
      mockSession({ role: 'viewer' });
      const res = await request(app)
        .post('/api/v1/projects/proj-1/files/f1/lifecycle')
        .set(sessionHeaders())
        .send({ action: 'keep' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    });

    it('rejects an editor attempting an admin-only action (protect)', async () => {
      mockSession({ role: 'editor' });
      mockDb.onQuery('SELECT * FROM projects WHERE id', { rows: [testProject] });
      const res = await request(app)
        .post('/api/v1/projects/proj-1/files/f1/lifecycle')
        .set(sessionHeaders())
        .send({ action: 'protect' });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    });

    it('lets an editor keep a file active', async () => {
      mockSession({ role: 'editor' });
      mockDb.onQuery('SELECT * FROM projects WHERE id', { rows: [testProject] });
      mockDb.onQuery('deleted_at IS NULL', { rows: [{ id: 'f1', lifecycle_state: 'cold_candidate', project_id: 'proj-1' }] });
      mockDb.onQuery('FROM files WHERE id = $1', { rows: [{ id: 'f1', lifecycle_state: 'active' }] });

      const res = await request(app)
        .post('/api/v1/projects/proj-1/files/f1/lifecycle')
        .set(sessionHeaders())
        .send({ action: 'keep' });

      expect(res.status).toBe(200);
      expect(res.body.data.lifecycle_state).toBe('active');
    });

    it('rejects an unknown action', async () => {
      mockSession({ role: 'editor' });
      mockDb.onQuery('SELECT * FROM projects WHERE id', { rows: [testProject] });
      const res = await request(app)
        .post('/api/v1/projects/proj-1/files/f1/lifecycle')
        .set(sessionHeaders())
        .send({ action: 'nuke' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_ACTION');
    });

    it('returns 404 for a project in another account (tenant isolation)', async () => {
      mockSession({ role: 'admin' });
      mockDb.onQuery('SELECT * FROM projects WHERE id', { rows: [] }); // loadProject finds nothing
      const res = await request(app)
        .post('/api/v1/projects/other-proj/files/f1/lifecycle')
        .set(sessionHeaders())
        .send({ action: 'keep' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });

  describe('GET /api/v1/projects/:id/files/:fileId/lifecycle/audit', () => {
    it('returns a file\'s audit trail', async () => {
      mockSession({ role: 'viewer' });
      mockDb.onQuery('SELECT * FROM projects WHERE id', { rows: [testProject] });
      mockDb.onQuery('SELECT id FROM files WHERE id = $1', { rows: [{ id: 'f1' }] });
      mockDb.onQuery('FROM lifecycle_audit', {
        rows: [{ id: 'a1', action: 'scan.cold_candidate', from_state: 'active', to_state: 'cold_candidate' }],
      });

      const res = await request(app)
        .get('/api/v1/projects/proj-1/files/f1/lifecycle/audit')
        .set(sessionHeaders());

      expect(res.status).toBe(200);
      expect(res.body.data[0].action).toBe('scan.cold_candidate');
    });
  });
});
