const request = require('supertest');
const { createTestApp, mockDb, mockMinio } = require('../setup');
const queue = require('../../src/queue');

function primeFile(overrides = {}) {
  mockDb.onQuery('FROM files f JOIN projects p ON f.project_id = p.id', {
    rows: [{
      id: 'f1', project_id: 'proj-1', storage_key: 'proj-1/img.png', filename: 'img.png',
      type: 'image', mime_type: 'image/png', status: 'done', access: 'public',
      signing_secret: 'a'.repeat(64), project_account_id: 'acc-1',
      lifecycle_state: 'archived', project_settings: {}, deleted_at: null,
      ...overrides,
    }],
  });
}

let app;
beforeEach(() => {
  mockDb.reset();
  mockMinio.reset();
  queue.addJob.mockClear();
  app = createTestApp();
});

describe('on-access restore (GET /f)', () => {
  it('returns 202 + Retry-After and enqueues a restore for an archived file', async () => {
    primeFile({ lifecycle_state: 'archived', project_settings: { lifecycle_policy: { restore_on_access: true } } });
    mockDb.onQuery("SET lifecycle_state = 'restoring'", { rowCount: 1 });

    const res = await request(app).get('/f/proj-1/img.png');

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ status: 'restoring', message: 'Restore in progress' });
    expect(res.headers['retry-after']).toBeDefined();
    expect(res.headers['cache-control']).toBe('no-store');
    expect(queue.addJob).toHaveBeenCalledWith(
      'restore', 'restore', expect.objectContaining({ fileId: 'f1' }),
      expect.objectContaining({ jobId: 'restore:f1' })
    );
  });

  it('returns 202 for a file already restoring, without re-enqueuing', async () => {
    primeFile({ lifecycle_state: 'restoring' });

    const res = await request(app).get('/f/proj-1/img.png');

    expect(res.status).toBe(202);
    expect(res.body.status).toBe('restoring');
    expect(queue.addJob).not.toHaveBeenCalled();
  });

  it('does not 202 when restore_on_access is disabled (serves from cold instead)', async () => {
    primeFile({
      lifecycle_state: 'archived',
      project_settings: { lifecycle_policy: { restore_on_access: false } },
    });
    // Falls through to normal serving from the (still-available) cold copy.
    mockMinio.objects['proj-1/img.png'] = { buffer: Buffer.from('cold-bytes'), contentType: 'image/png', size: 10 };
    const res = await request(app).get('/f/proj-1/img.png');
    expect(res.status).toBe(200);
    expect(queue.addJob).not.toHaveBeenCalled();
  });
});
