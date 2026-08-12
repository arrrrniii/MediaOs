/**
 * Reconciler end-to-end against REAL Postgres + MinIO (Phase 7).
 *
 * Exercises the self-healing checks against real object storage: a genuinely
 * missing object is detected and marked, a real orphan key is reported/deleted
 * under the age rule, and a corrupted project counter is recomputed to the
 * truth from file_objects.
 *
 * Skipped unless REDIS_URL/REDIS_TEST is set — the same gate the other
 * real-infra tests use — so the default `npm test` stays green offline. Does
 * NOT require ../setup: it must hit the real db/minio modules, not the mocks.
 */

const hasInfra = !!(process.env.REDIS_URL || process.env.REDIS_TEST);
const d = hasInfra ? describe : describe.skip;

d('reconciler (real postgres + minio)', () => {
  const crypto = require('crypto');
  const { query, pool } = require('../../src/db');
  const config = require('../../src/config');
  const minio = require('../../src/minio');
  const storageBackendService = require('../../src/services/storageBackendService');
  const reconcile = require('../../src/services/reconcileService');

  const suffix = crypto.randomBytes(4).toString('hex');
  let accountId, projectId, backendId;
  const created = { files: [], keys: [] };

  async function makeFile({ key, size, checksum = null, status = 'available' }) {
    const f = await query(
      `INSERT INTO files (project_id, storage_key, filename, type, mime_type, size, status)
       VALUES ($1, $2, $3, 'image', 'image/webp', $4, 'done') RETURNING id`,
      [projectId, key, `f-${suffix}.webp`, size]
    );
    const fileId = f.rows[0].id;
    created.files.push(fileId);
    await query(
      `INSERT INTO file_objects (file_id, role, storage_backend_id, storage_key, mime_type, size, checksum, storage_tier, status)
       VALUES ($1, 'optimized', $2, $3, 'image/webp', $4, $5, 'hot', $6)`,
      [fileId, backendId, key, size, checksum, status]
    );
    return fileId;
  }

  beforeAll(async () => {
    await minio.ensureBucket();
    storageBackendService._resetCache();
    const backend = await storageBackendService.getDefaultBackend();
    backendId = backend.id;

    const acc = await query(
      `INSERT INTO accounts (name, email) VALUES ($1, $2) RETURNING id`,
      [`P7 ${suffix}`, `p7-${suffix}@example.com`]
    );
    accountId = acc.rows[0].id;
    const proj = await query(
      `INSERT INTO projects (account_id, name, slug, signing_secret) VALUES ($1, $2, $3, $4) RETURNING id`,
      [accountId, 'P7', `p7-${suffix}`, 'a'.repeat(64)]
    );
    projectId = proj.rows[0].id;
  });

  afterAll(async () => {
    for (const key of created.keys) {
      await minio.removeObject(key).catch(() => {});
    }
    if (accountId) await query('DELETE FROM accounts WHERE id = $1', [accountId]).catch(() => {});
    await pool.end().catch(() => {});
  });

  it('missing_objects: marks an available object missing after its bytes are deleted, and audits it', async () => {
    const key = `${projectId}/present-${suffix}.webp`;
    const body = crypto.randomBytes(256);
    await minio.putBuffer(key, body, 'image/webp');
    const fileId = await makeFile({ key, size: body.length });

    // Delete the bytes out-of-band — DB still says 'available'.
    await minio.removeObject(key);

    const r = await reconcile.checkMissingObjects('00000000-0000-0000-0000-000000000000');
    expect(r.issuesFound).toBeGreaterThanOrEqual(1);

    const { rows } = await query(
      `SELECT status FROM file_objects WHERE file_id = $1 AND role = 'optimized'`, [fileId]);
    expect(rows[0].status).toBe('missing');

    const { rows: audit } = await query(
      `SELECT 1 FROM lifecycle_audit WHERE file_id = $1 AND action = 'repair.missing_objects' AND actor = 'system:reconciler'`,
      [fileId]
    );
    expect(audit.length).toBeGreaterThanOrEqual(1);

    // Idempotent: a second pass does not re-flip it (selects only 'available').
    const before = await query(
      `SELECT COUNT(*) AS n FROM lifecycle_audit WHERE file_id = $1 AND action = 'repair.missing_objects'`, [fileId]);
    await reconcile.checkMissingObjects('00000000-0000-0000-0000-000000000000');
    const after = await query(
      `SELECT COUNT(*) AS n FROM lifecycle_audit WHERE file_id = $1 AND action = 'repair.missing_objects'`, [fileId]);
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('orphan_objects: deletes an unreferenced key once it is old enough, re-checking the DB first', async () => {
    const key = `${projectId}/orphan-${suffix}.bin`;
    await minio.putBuffer(key, crypto.randomBytes(128), 'application/octet-stream');
    // No file_objects row references this key → orphan.

    // Reset the shared orphan cursor so this key is in the scanned page, and
    // drop the age floor to 0 so the freshly-created key qualifies for delete.
    await query(`DELETE FROM lifecycle_kv WHERE key = 'reconcile:orphan_cursor'`);
    const savedAge = config.orphanMinAgeMs;
    config.orphanMinAgeMs = 0;
    try {
      const r = await reconcile.checkOrphanObjects('00000000-0000-0000-0000-000000000000');
      expect(r.checked).toBeGreaterThanOrEqual(1);
    } finally {
      config.orphanMinAgeMs = savedAge;
    }

    // The orphan key is gone from storage.
    let exists = true;
    try { await minio.statObject(key); } catch { exists = false; }
    expect(exists).toBe(false);

    const { rows } = await query(
      `SELECT 1 FROM lifecycle_audit WHERE action = 'repair.orphan_objects'
                AND detail->>'storage_key' = $1 AND actor = 'system:reconciler'`,
      [key]
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });

  it('orphan_objects: never deletes a key that has a file_objects row', async () => {
    const key = `${projectId}/kept-${suffix}.webp`;
    const body = crypto.randomBytes(64);
    await minio.putBuffer(key, body, 'image/webp');
    created.keys.push(key);
    await makeFile({ key, size: body.length });

    await query(`DELETE FROM lifecycle_kv WHERE key = 'reconcile:orphan_cursor'`);
    const savedAge = config.orphanMinAgeMs;
    config.orphanMinAgeMs = 0;
    try {
      await reconcile.checkOrphanObjects('00000000-0000-0000-0000-000000000000');
    } finally {
      config.orphanMinAgeMs = savedAge;
    }

    let exists = true;
    try { await minio.statObject(key); } catch { exists = false; }
    expect(exists).toBe(true); // referenced → never touched
  });

  it('storage_counter_drift: recomputes a corrupted project counter to the truth', async () => {
    const key = `${projectId}/sized-${suffix}.webp`;
    const body = crypto.randomBytes(1000);
    await minio.putBuffer(key, body, 'image/webp');
    created.keys.push(key);
    await makeFile({ key, size: body.length });

    // Corrupt the stored counters.
    await query(`UPDATE projects SET storage_used = 999999, file_count = 999 WHERE id = $1`, [projectId]);

    await reconcile.checkStorageCounterDrift('00000000-0000-0000-0000-000000000000');

    const { rows } = await query(`SELECT storage_used, file_count FROM projects WHERE id = $1`, [projectId]);
    // The truth is the SUM of non-deleted file_objects sizes / count of files.
    const { rows: truth } = await query(
      `SELECT COALESCE(SUM(o.size),0) AS s, (SELECT COUNT(*) FROM files WHERE project_id = $1 AND deleted_at IS NULL) AS c
         FROM file_objects o JOIN files f ON f.id = o.file_id
        WHERE f.project_id = $1 AND f.deleted_at IS NULL`,
      [projectId]
    );
    expect(String(rows[0].storage_used)).toBe(String(truth[0].s));
    expect(Number(rows[0].file_count)).toBe(Number(truth[0].c));

    const { rows: audit } = await query(
      `SELECT 1 FROM lifecycle_audit WHERE project_id = $1 AND action = 'repair.storage_counter_drift'`, [projectId]);
    expect(audit.length).toBeGreaterThanOrEqual(1);
  });
});
