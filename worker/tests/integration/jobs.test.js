const request = require('supertest');
const {
  createTestApp, mockDb, sessionHeaders, mockSession, testProject,
} = require('../setup');

let app;

beforeEach(() => {
  mockDb.reset();
  app = createTestApp();
});

describe('Jobs API', () => {
  describe('GET /api/v1/projects/:id/jobs', () => {
    it('lists this project\'s jobs, scoped to the account', async () => {
      mockSession({ role: 'owner' });
      mockDb.onQuery('SELECT * FROM projects WHERE id', { rows: [testProject] });
      mockDb.onQuery('FROM job_attempts ja', {
        rows: [{
          id: 'ja-1', queue: 'media-processing', job_id: 'media:file-1', file_id: 'file-1',
          status: 'failed', attempt: 5, error: 'boom', filename: 'v.mp4', type: 'video',
        }],
      });

      const res = await request(app)
        .get(`/api/v1/projects/${testProject.id}/jobs?status=failed`)
        .set(sessionHeaders());

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].status).toBe('failed');
      // The status filter was applied as a bound param.
      const call = mockDb.queryCalls.find((c) => c.text.includes('FROM job_attempts ja'));
      expect(call.params).toEqual([testProject.id, 'failed']);
    });

    it('rejects an invalid status filter', async () => {
      mockSession({ role: 'owner' });
      mockDb.onQuery('SELECT * FROM projects WHERE id', { rows: [testProject] });

      const res = await request(app)
        .get(`/api/v1/projects/${testProject.id}/jobs?status=bogus`)
        .set(sessionHeaders());

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_STATUS');
    });

    it('returns 404 for a project in another account (tenant isolation)', async () => {
      mockSession({ role: 'owner' });
      // loadProject finds nothing for this account.
      mockDb.onQuery('SELECT * FROM projects WHERE id', { rows: [] });

      const res = await request(app)
        .get('/api/v1/projects/other-proj/jobs')
        .set(sessionHeaders());

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });
  });

  describe('POST /api/v1/jobs/:jobId/retry', () => {
    it('returns 404 when the job is not in the caller\'s account', async () => {
      mockSession({ role: 'admin' });
      // Ownership join returns nothing → cross-tenant / missing.
      mockDb.onQuery('FROM job_attempts ja', { rows: [] });

      const res = await request(app)
        .post('/api/v1/jobs/media:some-file/retry')
        .set(sessionHeaders());

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NOT_FOUND');
    });

    it('requires an admin role', async () => {
      mockSession({ role: 'viewer' });

      const res = await request(app)
        .post('/api/v1/jobs/media:some-file/retry')
        .set(sessionHeaders());

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('INSUFFICIENT_ROLE');
    });
  });
});
