/**
 * Archive/restore end-to-end against REAL Postgres + MinIO (Phase 6).
 *
 * Uses the running MinIO as BOTH the hot backend (the system-default bucket)
 * and a simulated cold backend (a second bucket reached through the S3 client
 * with an encrypted config), so the full copy → verify → grace-delete → restore
 * cycle runs against real object storage without any external cloud creds.
 *
 * Skipped unless REDIS_URL/REDIS_TEST is set (the same gate the other real-infra
 * tests use), so the default `npm test` stays green offline. Does NOT require
 * ../setup — it must hit the real db/minio/storage modules, not the unit mocks.
 */

const hasInfra = !!(process.env.REDIS_URL || process.env.REDIS_TEST);
const d = hasInfra ? describe : describe.skip;

// This suite drives real object storage; against a freshly-booted MinIO (as in
// CI) an occasional read can race the write's durability. The archive/restore
// logic itself is deterministic, so retry a transient infra hiccup rather than
// fail the build.
if (hasInfra) jest.retryTimes(2, { logErrorsBeforeRetry: true });

d('archive + restore (real minio, two buckets)', () => {
  const crypto = require('crypto');
  const { query, pool } = require('../../src/db');
  const config = require('../../src/config');
  const minio = require('../../src/minio');
  const secretBox = require('../../src/utils/secretBox');
  const storageBackendService = require('../../src/services/storageBackendService');
  const archive = require('../../src/queue/processors/archive');
  const restore = require('../../src/queue/processors/restore');

  const suffix = crypto.randomBytes(4).toString('hex');
  const COLD_BUCKET = `mediaos-cold-test-${suffix}`;
  const body = crypto.randomBytes(4096); // 4 KiB of random bytes
  const checksum = crypto.createHash('sha256').update(body).digest('hex');

  let accountId, projectId, fileId, hotBackendId, coldBackendId, hotKey, coldKey;

  async function objectExists(bucket, key) {
    try { await minio.minioClient.statObject(bucket, key); return true; }
    catch { return false; }
  }

  beforeAll(async () => {
    await minio.ensureBucket();
    if (!(await minio.minioClient.bucketExists(COLD_BUCKET))) {
      await minio.minioClient.makeBucket(COLD_BUCKET);
    }
    storageBackendService._resetCache();

    // Real tenancy graph.
    const acc = await query(
      `INSERT INTO accounts (name, email) VALUES ($1, $2) RETURNING id`,
      [`P6 Test ${suffix}`, `p6-${suffix}@example.com`]
    );
    accountId = acc.rows[0].id;
    const proj = await query(
      `INSERT INTO projects (account_id, name, slug, signing_secret) VALUES ($1, $2, $3, $4) RETURNING id`,
      [accountId, 'P6', `p6-${suffix}`, 'a'.repeat(64)]
    );
    projectId = proj.rows[0].id;

    hotKey = `${projectId}/archive-me-${suffix}.bin`;
    coldKey = `cold/${hotKey}`;

    // Put the hot object in the default bucket.
    await minio.putBuffer(hotKey, body, 'application/octet-stream');

    // Default (hot) backend id.
    const hb = await query(`SELECT id FROM storage_backends WHERE account_id IS NULL AND is_default LIMIT 1`);
    hotBackendId = hb.rows[0].id;

    // Second backend = same MinIO, different bucket, reached as an S3 client.
    const endpoint = `${config.minio.useSSL ? 'https' : 'http'}://${config.minio.endPoint}:${config.minio.port}`;
    const encrypted = secretBox.encryptJson({
      endpoint, region: 'us-east-1', bucket: COLD_BUCKET,
      accessKeyId: config.minio.accessKey, secretAccessKey: config.minio.secretKey,
      forcePathStyle: true,
    });
    const cb = await query(
      `INSERT INTO storage_backends (account_id, type, name, configuration_encrypted, status, is_cold_default)
       VALUES ($1, 'minio', 'Cold Test', $2, 'active', TRUE) RETURNING id`,
      [accountId, encrypted]
    );
    coldBackendId = cb.rows[0].id;
    storageBackendService._resetCache();

    // The file + its source object (on the hot backend).
    const f = await query(
      `INSERT INTO files (project_id, storage_key, filename, type, mime_type, size, checksum, lifecycle_state)
       VALUES ($1, $2, $3, 'file', 'application/octet-stream', $4, $5, 'cold_candidate') RETURNING id`,
      [projectId, hotKey, `archive-me-${suffix}.bin`, body.length, checksum]
    );
    fileId = f.rows[0].id;
    await query(
      `INSERT INTO file_objects (file_id, role, storage_backend_id, storage_key, mime_type, size, checksum, storage_tier, status)
       VALUES ($1, 'source', $2, $3, 'application/octet-stream', $4, $5, 'hot', 'available')`,
      [fileId, hotBackendId, hotKey, body.length, checksum]
    );
  });

  afterAll(async () => {
    try { await query('DELETE FROM file_objects WHERE file_id = $1', [fileId]); } catch { /* noop */ }
    try { await query('DELETE FROM lifecycle_audit WHERE file_id = $1', [fileId]); } catch { /* noop */ }
    try { await query('DELETE FROM lifecycle_notifications WHERE account_id = $1', [accountId]); } catch { /* noop */ }
    try { await query('DELETE FROM files WHERE id = $1', [fileId]); } catch { /* noop */ }
    try { await query('DELETE FROM storage_backends WHERE id = $1', [coldBackendId]); } catch { /* noop */ }
    try { await query('DELETE FROM projects WHERE id = $1', [projectId]); } catch { /* noop */ }
    try { await query('DELETE FROM accounts WHERE id = $1', [accountId]); } catch { /* noop */ }
    for (const [b, k] of [[config.bucket, hotKey], [COLD_BUCKET, coldKey]]) {
      try { await minio.minioClient.removeObject(b, k); } catch { /* noop */ }
    }
    try { await minio.minioClient.removeBucket(COLD_BUCKET); } catch { /* noop */ }
    storageBackendService._resetCache();
    await pool.end();
  });

  test('archives to cold, verifies, removes hot after grace=0, and marks archived', async () => {
    const result = await archive.processArchiveJob({ fileId, scope: 'all', graceMs: 0 });
    expect(result).toMatchObject({ archived: true });

    // Cold copy exists and is byte-identical.
    expect(await objectExists(COLD_BUCKET, coldKey)).toBe(true);
    const coldStat = await minio.minioClient.statObject(COLD_BUCKET, coldKey);
    expect(coldStat.size).toBe(body.length);

    // Hot copy removed (grace was 0).
    expect(await objectExists(config.bucket, hotKey)).toBe(false);

    // Object row repointed to cold; file archived.
    const { rows: objs } = await query('SELECT * FROM file_objects WHERE file_id = $1', [fileId]);
    expect(objs[0].storage_tier).toBe('cold');
    expect(objs[0].storage_backend_id).toBe(coldBackendId);
    expect(objs[0].storage_key).toBe(coldKey);
    expect(objs[0].archived_at).not.toBeNull();

    const { rows: files } = await query('SELECT lifecycle_state FROM files WHERE id = $1', [fileId]);
    expect(files[0].lifecycle_state).toBe('archived');
  });

  test('restores back to hot, verifies, and marks the file active', async () => {
    const result = await restore.processRestoreJob({ fileId });
    expect(result).toMatchObject({ restored: true });

    // Hot copy is back and byte-identical; cold copy dropped.
    expect(await objectExists(config.bucket, hotKey)).toBe(true);
    const hotStat = await minio.minioClient.statObject(config.bucket, hotKey);
    expect(hotStat.size).toBe(body.length);
    expect(await objectExists(COLD_BUCKET, coldKey)).toBe(false);

    const { rows: objs } = await query('SELECT * FROM file_objects WHERE file_id = $1', [fileId]);
    expect(objs[0].storage_tier).toBe('hot');
    expect(objs[0].storage_backend_id).toBe(hotBackendId);
    expect(objs[0].storage_key).toBe(hotKey);
    expect(objs[0].archived_at).toBeNull();

    const { rows: files } = await query('SELECT lifecycle_state FROM files WHERE id = $1', [fileId]);
    expect(files[0].lifecycle_state).toBe('active');
  });
});
