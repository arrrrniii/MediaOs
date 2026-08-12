const request = require('supertest');
const { createTestApp, mockDb, MASTER_KEY } = require('../setup');

let app;

beforeEach(() => {
  mockDb.reset();
  app = createTestApp();
  const queue = require('../../src/queue');
  queue.isEnabled.mockReturnValue(true);
  queue.addJob.mockClear();
});

describe('System routes (MASTER_KEY / adminAuth)', () => {
  describe('auth', () => {
    it('401 without an admin key', async () => {
      const res = await request(app).get('/api/v1/system/health');
      expect(res.status).toBe(401);
    });

    it('403 with a wrong admin key', async () => {
      const res = await request(app).get('/api/v1/system/health').set('X-API-Key', 'nope');
      expect(res.status).toBe(403);
    });

    it('rejects the run endpoint without a key', async () => {
      const res = await request(app).post('/api/v1/system/reconciliation/run').send({});
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/v1/system/health', () => {
    it('returns live metrics + the latest snapshot', async () => {
      // healthService.computeHealth issues a batch of COUNTs; the mock returns
      // { rows: [] } for anything unprimed, which scalar() reads as 0.
      mockDb.onQuery('FROM health_snapshots ORDER BY captured_at DESC', {
        rows: [{ id: 'snap-1', captured_at: '2026-08-12T00:00:00Z', metrics: { healthy_assets: 10 } }],
      });

      const res = await request(app).get('/api/v1/system/health').set('X-API-Key', MASTER_KEY);

      expect(res.status).toBe(200);
      expect(res.body.live).toEqual(expect.objectContaining({
        healthy_assets: expect.any(Number),
        missing_objects: expect.any(Number),
        orphan_objects: expect.any(Number),
        corrupt_objects: expect.any(Number),
        stuck_jobs: expect.any(Number),
        failed_webhooks: expect.any(Number),
        pending_restores: expect.any(Number),
      }));
      expect(res.body.snapshot).toMatchObject({ id: 'snap-1' });
    });
  });

  describe('GET /api/v1/system/reconciliation/runs', () => {
    it('lists recent runs', async () => {
      mockDb.onQuery('FROM reconciliation_runs r', {
        rows: [{ id: 'run-1', kind: 'all', status: 'completed', checked: 5, issues_found: 1, repaired: 1, error_count: 0 }],
      });
      const res = await request(app).get('/api/v1/system/reconciliation/runs').set('X-API-Key', MASTER_KEY);
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].kind).toBe('all');
    });
  });

  describe('GET /api/v1/system/reconciliation/runs/:id/issues', () => {
    it('lists a run\'s issues', async () => {
      mockDb.onQuery('FROM reconciliation_issues', {
        rows: [{ id: 'i1', category: 'missing_objects', severity: 'error', repaired: false }],
      });
      const res = await request(app)
        .get('/api/v1/system/reconciliation/runs/run-1/issues')
        .set('X-API-Key', MASTER_KEY);
      expect(res.status).toBe(200);
      expect(res.body.data[0].category).toBe('missing_objects');
    });
  });

  describe('POST /api/v1/system/reconciliation/run', () => {
    it('enqueues a full reconcile pass (202)', async () => {
      const res = await request(app)
        .post('/api/v1/system/reconciliation/run')
        .set('X-API-Key', MASTER_KEY)
        .send({});
      expect(res.status).toBe(202);
      expect(res.body.enqueued).toBe(true);
      const queue = require('../../src/queue');
      expect(queue.addJob).toHaveBeenCalledWith('reconciliation', 'reconcile.all', {});
    });

    it('enqueues a single-category pass', async () => {
      const res = await request(app)
        .post('/api/v1/system/reconciliation/run')
        .set('X-API-Key', MASTER_KEY)
        .send({ category: 'orphan_objects' });
      expect(res.status).toBe(202);
      const queue = require('../../src/queue');
      expect(queue.addJob).toHaveBeenCalledWith('reconciliation', 'reconcile.category', { category: 'orphan_objects' });
    });

    it('rejects an unknown category (400)', async () => {
      const res = await request(app)
        .post('/api/v1/system/reconciliation/run')
        .set('X-API-Key', MASTER_KEY)
        .send({ category: 'not_a_real_check' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_CATEGORY');
    });
  });
});
