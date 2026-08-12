/**
 * Access-tracking integration test against a REAL Redis + Postgres. Skipped
 * automatically unless REDIS_URL (or REDIS_TEST) is set, so the default
 * `npm test` run stays green without Redis.
 *
 * Proves the full hot-path → flush → durable-store loop:
 *   recordAccess() (Redis only) → flushAccess() → access_daily rows +
 *   files.last_accessed_at / access_count updated, and a second flush is a
 *   no-op (nothing double-counted).
 *
 * Does NOT require ../setup — it must hit the real db/redis, not the unit mocks.
 */

const hasRedis = !!(process.env.REDIS_URL || process.env.REDIS_TEST);
const d = hasRedis ? describe : describe.skip;

d('access tracking (redis)', () => {
  const Redis = require('ioredis');
  const { query, pool } = require('../../src/db');
  const accessTracking = require('../../src/services/accessTrackingService');
  const { flushAccess } = require('../../src/services/lifecycleFlushService');

  let redis;
  let accountId;
  let projectId;
  let fileId;
  const today = new Date().toISOString().split('T')[0];

  beforeAll(async () => {
    redis = new Redis(process.env.REDIS_URL || process.env.REDIS_TEST || 'redis://localhost:6379');
    accessTracking.setRedis(redis);

    // Minimal fixtures: account → project → file.
    const acc = await query(
      `INSERT INTO accounts (name, email) VALUES ('AccessTest', $1) RETURNING id`,
      [`accesstest-${Date.now()}@example.com`]
    );
    accountId = acc.rows[0].id;

    const proj = await query(
      `INSERT INTO projects (account_id, name, slug, signing_secret)
       VALUES ($1, 'AccessProj', $2, $3) RETURNING id`,
      [accountId, `access-${Date.now()}`, 'a'.repeat(64)]
    );
    projectId = proj.rows[0].id;

    const file = await query(
      `INSERT INTO files (project_id, storage_key, filename, type, mime_type, size)
       VALUES ($1, $2, 'clip.mp4', 'video', 'video/mp4', 500) RETURNING id`,
      [projectId, `${projectId}/clip-${Date.now()}.mp4`]
    );
    fileId = file.rows[0].id;
  });

  afterAll(async () => {
    try { await redis.del(accessTracking.dayHashKey(today)); } catch { /* noop */ }
    try { await redis.hdel(accessTracking.LAST_HASH_KEY, fileId); } catch { /* noop */ }
    try { await redis.quit(); } catch { /* noop */ }
    // Cascades to project, file, and access_daily.
    if (accountId) await query('DELETE FROM accounts WHERE id = $1', [accountId]);
    await pool.end();
  });

  test('recordAccess ticks flush into access_daily and update files', async () => {
    accessTracking.recordAccess(fileId, 'download');
    accessTracking.recordAccess(fileId, 'download');
    accessTracking.recordAccess(fileId, 'transform');
    accessTracking.recordAccess(fileId, 'video_play');

    // recordAccess is fire-and-forget; give the Redis writes a moment to land.
    await new Promise((r) => setTimeout(r, 150));

    const result = await flushAccess(redis);
    expect(result.files).toBe(1);

    const { rows } = await query(
      'SELECT downloads, transforms, video_plays FROM access_daily WHERE file_id = $1 AND day = $2',
      [fileId, today]
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].downloads)).toBe(2);
    expect(Number(rows[0].transforms)).toBe(1);
    expect(Number(rows[0].video_plays)).toBe(1);

    const { rows: fileRows } = await query(
      'SELECT access_count, last_accessed_at FROM files WHERE id = $1',
      [fileId]
    );
    expect(Number(fileRows[0].access_count)).toBe(4);
    expect(fileRows[0].last_accessed_at).not.toBeNull();
  });

  test('a second flush with no new ticks is a no-op (nothing double-counted)', async () => {
    const result = await flushAccess(redis);
    expect(result.rows).toBe(0);

    const { rows } = await query(
      'SELECT downloads, transforms, video_plays FROM access_daily WHERE file_id = $1 AND day = $2',
      [fileId, today]
    );
    expect(Number(rows[0].downloads)).toBe(2);
    expect(Number(rows[0].transforms)).toBe(1);
  });
});
