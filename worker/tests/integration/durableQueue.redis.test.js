/**
 * Durable-queue integration test — proves the Phase-4 guarantees against a
 * REAL Redis + Postgres. Skipped automatically when neither REDIS_URL nor
 * REDIS_TEST is set, so the default `npm test` run stays green without Redis;
 * the Phase-11 e2e job sets REDIS_URL and runs it.
 *
 * Uses the CLEANUP queue (a stub with no real side effects) as a neutral
 * carrier so we exercise the queue/ledger machinery without the ffmpeg media
 * pipeline.
 *
 * NOTE: this file does NOT require ../setup — it must hit the real db and
 * queue modules, not the unit mocks.
 */

const hasRedis = !!(process.env.REDIS_URL || process.env.REDIS_TEST);
const d = hasRedis ? describe : describe.skip;

d('durable queue (redis)', () => {
  const { QUEUES, addJob, getQueue, getConnection, closeAll } = require('../../src/queue');
  const { markJobAttempt } = require('../../src/queue/workers');
  const { query, pool } = require('../../src/db');
  const { Worker, Job } = require('bullmq');

  const Q = QUEUES.CLEANUP;
  const workers = [];

  async function ledgerRow(jobId) {
    const { rows } = await query(
      'SELECT * FROM job_attempts WHERE queue = $1 AND job_id = $2',
      [Q, jobId]
    );
    return rows[0] || null;
  }

  // Close any workers a test started so they don't compete for the next
  // test's jobs (a leftover success-worker would swallow a job meant to fail).
  afterEach(async () => {
    while (workers.length) {
      const w = workers.pop();
      try { await w.close(); } catch { /* noop */ }
    }
  });

  afterAll(async () => {
    for (const w of workers) { try { await w.close(); } catch { /* noop */ } }
    try { await getQueue(Q).obliterate({ force: true }); } catch { /* noop */ }
    await closeAll();
    // Clean up the ledger rows this test created.
    try { await query("DELETE FROM job_attempts WHERE job_id LIKE 'dq-%'"); } catch { /* noop */ }
    await pool.end();
  });

  test('enqueue writes a job_attempts ledger row', async () => {
    const id = `dq-ledger-${Date.now()}`;
    await addJob(Q, 'noop', { fileId: null, marker: id }, { jobId: id });
    const row = await ledgerRow(id);
    expect(row).not.toBeNull();
    expect(row.status).toBe('active');
    await getQueue(Q).remove(id).catch(() => {});
  });

  test('idempotency: adding the same jobId twice is a single job + single ledger row', async () => {
    const id = `dq-idem-${Date.now()}`;
    const j1 = await addJob(Q, 'noop', { marker: id }, { jobId: id });
    const j2 = await addJob(Q, 'noop', { marker: id }, { jobId: id });
    expect(String(j1.id)).toBe(String(j2.id));

    const { rows } = await query(
      'SELECT COUNT(*)::int AS n FROM job_attempts WHERE queue = $1 AND job_id = $2',
      [Q, id]
    );
    expect(rows[0].n).toBe(1);
    await getQueue(Q).remove(id).catch(() => {});
  });

  test('restart semantics: a job enqueued while no worker is running is picked up once a worker starts', async () => {
    const id = `dq-restart-${Date.now()}`;
    // Enqueue with NO worker consuming the queue yet — simulates a job that
    // was durably persisted in Redis while the worker was down.
    await addJob(Q, 'noop', { marker: id }, { jobId: id });

    // Now "restart": bring a worker up and confirm it processes the waiting job.
    const processed = new Promise((resolve) => {
      const w = new Worker(Q, async (job) => {
        if (job.data.marker === id) resolve(String(job.id));
        return {};
      }, { connection: getConnection(), concurrency: 1 });
      workers.push(w);
    });

    const jobId = await processed;
    expect(jobId).toBe(id);
  }, 20000);

  test('a job that keeps failing exhausts its retries and is marked dead in the ledger', async () => {
    const id = `dq-dead-${Date.now()}`;
    // Small attempts + fast backoff so the test finishes quickly.
    await addJob(Q, 'always-fails', { marker: id }, {
      jobId: id,
      attempts: 2,
      backoff: { type: 'fixed', delay: 100 },
    });

    const done = new Promise((resolve) => {
      const w = new Worker(Q, async () => {
        throw new Error('intentional failure');
      }, { connection: getConnection(), concurrency: 1 });
      workers.push(w);

      w.on('failed', async (job) => {
        const ceiling = (job.opts && job.opts.attempts) || 1;
        const status = job.attemptsMade >= ceiling ? 'dead' : 'failed';
        await markJobAttempt(Q, job.id, status, { attempt: job.attemptsMade, error: 'intentional failure' });
        if (status === 'dead') resolve();
      });
    });

    await done;
    const row = await ledgerRow(id);
    expect(row.status).toBe('dead');
    expect(row.error).toMatch(/intentional failure/);
  }, 20000);
});
