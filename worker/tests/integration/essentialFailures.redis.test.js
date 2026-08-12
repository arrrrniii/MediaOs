/**
 * Essential failure 3 (real-infra half) — worker restart during video
 * processing.
 *
 * The mock half (essentialFailures.test.js) proves the media processor is
 * idempotent in-process. This half proves the guarantee that only holds
 * against a REAL Redis: a media job survives a worker restart (BullMQ
 * persistence) and a duplicate enqueue with the same jobId is a single job
 * with a single ledger row — so a restart never double-processes.
 *
 * Skipped automatically when neither REDIS_URL nor REDIS_TEST is set, matching
 * the other *.redis.test.js files, so the default `npm test` run stays green
 * without Redis. It enqueues to the MEDIA queue but never starts a media
 * Worker, so no ffmpeg pipeline runs; it inspects the queue + job_attempts
 * ledger directly and removes only the specific jobs it created.
 *
 * NOTE: does NOT require ../setup — it must hit the real db + queue modules.
 */

const hasRedis = !!(process.env.REDIS_URL || process.env.REDIS_TEST);
const d = hasRedis ? describe : describe.skip;

d('essential failure 3 — media job durability (redis)', () => {
  const { QUEUES, addJob, getQueue, closeAll } = require('../../src/queue');
  const { query, pool } = require('../../src/db');

  const Q = QUEUES.MEDIA;
  const createdIds = [];

  async function ledgerRow(jobId) {
    const { rows } = await query(
      'SELECT * FROM job_attempts WHERE queue = $1 AND job_id = $2',
      [Q, jobId]
    );
    return rows[0] || null;
  }

  afterAll(async () => {
    const q = getQueue(Q);
    for (const id of createdIds) {
      try { await q.remove(id); } catch { /* noop */ }
    }
    try { await query("DELETE FROM job_attempts WHERE job_id LIKE 'ef3-media-%'"); } catch { /* noop */ }
    await closeAll();
    await pool.end();
  });

  test('a media job enqueued while no worker runs persists in Redis (survives restart)', async () => {
    const id = `ef3-media-persist-${Date.now()}`;
    createdIds.push(id);

    // No media Worker is running in the test process, so this simulates a job
    // enqueued right before / during a worker restart. fileId is null so the
    // job_attempts ledger's FK to files is not violated by a synthetic id.
    await addJob(Q, 'process', { fileId: null, marker: id, projectId: 'p', tempKey: 't', finalKey: 'f' }, { jobId: id });

    // The job is still waiting in Redis to be picked up once a worker returns.
    const job = await getQueue(Q).getJob(id);
    expect(job).not.toBeNull();
    expect(job.data.marker).toBe(id);

    // And a durable ledger row records the attempt.
    const row = await ledgerRow(id);
    expect(row).not.toBeNull();
    expect(row.status).toBe('active');
  });

  test('a duplicate enqueue with the same jobId is a single job + single ledger row (no double-process)', async () => {
    const id = `ef3-media-dedup-${Date.now()}`;
    createdIds.push(id);

    const j1 = await addJob(Q, 'process', { fileId: null, marker: id }, { jobId: id });
    const j2 = await addJob(Q, 'process', { fileId: null, marker: id }, { jobId: id });

    // BullMQ coalesces on jobId → same job identity, not two.
    expect(j1.id).toBe(id);
    expect(j2.id).toBe(id);

    const { rows } = await query(
      'SELECT COUNT(*)::int AS n FROM job_attempts WHERE queue = $1 AND job_id = $2',
      [Q, id]
    );
    expect(rows[0].n).toBe(1);
  });
});
