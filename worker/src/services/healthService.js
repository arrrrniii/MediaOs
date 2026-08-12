/**
 * System health snapshot (Phase 7).
 *
 * computeHealth() aggregates the current health-dashboard numbers with a set of
 * cheap COUNTs (each backed by an existing index) and persists them as a
 * health_snapshots row. The counts are allowed to be approximate — they are an
 * operational gauge, not a billing ledger — so nothing here takes a lock or
 * scans a large table without a bound.
 *
 * last_backup_at / last_restore_test_at are not derivable from the app tables;
 * they are read from lifecycle_kv keys that a backup/restore-drill hook stamps
 * via the exported setters (default null until something writes them).
 */

const { query } = require('../db');
const config = require('../config');

const KV_LAST_BACKUP = 'ops:last_backup_at';
const KV_LAST_RESTORE_TEST = 'ops:last_restore_test_at';

async function kvGet(key) {
  const { rows } = await query('SELECT value FROM lifecycle_kv WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : null;
}
async function kvSetTimestamp(key, when) {
  const iso = (when instanceof Date ? when : new Date(when || Date.now())).toISOString();
  await query(
    `INSERT INTO lifecycle_kv (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify({ at: iso })]
  );
  return iso;
}

/** Ops hook: record that a backup just completed. */
function setLastBackupAt(when) { return kvSetTimestamp(KV_LAST_BACKUP, when); }
/** Ops hook: record that a restore drill just passed. */
function setLastRestoreTestAt(when) { return kvSetTimestamp(KV_LAST_RESTORE_TEST, when); }

async function scalar(sql, params = []) {
  const { rows } = await query(sql, params);
  return parseInt(rows[0] && rows[0].n, 10) || 0;
}

/**
 * Compute the current health metrics and persist a snapshot.
 * @param {object} [opts]
 * @param {boolean} [opts.persist=true]  write a health_snapshots row.
 * @returns {Promise<object>} { metrics, snapshotId, captured_at }
 */
async function computeHealth({ persist = true } = {}) {
  const stuckMs = config.reconcileStuckMs;

  const [
    healthyAssets,
    missingObjects,
    corruptObjects,
    pendingRestores,
    pendingArchives,
    stuckJobs,
    deadJobs,
    failedWebhooks,
    totalFiles,
    totalObjects,
  ] = await Promise.all([
    scalar(`SELECT COUNT(*) AS n FROM files WHERE status = 'done' AND deleted_at IS NULL AND lifecycle_state NOT IN ('deleted', 'delete_candidate')`),
    scalar(`SELECT COUNT(*) AS n FROM file_objects WHERE status = 'missing'`),
    scalar(`SELECT COUNT(*) AS n FROM file_objects WHERE status = 'corrupt'`),
    scalar(`SELECT COUNT(*) AS n FROM files WHERE lifecycle_state = 'restoring' AND deleted_at IS NULL`),
    scalar(`SELECT COUNT(*) AS n FROM files WHERE lifecycle_state = 'archiving' AND deleted_at IS NULL`),
    scalar(`SELECT COUNT(*) AS n FROM job_attempts WHERE status = 'active' AND created_at < NOW() - ($1 || ' milliseconds')::interval`, [String(stuckMs)]),
    scalar(`SELECT COUNT(*) AS n FROM job_attempts WHERE status = 'dead'`),
    scalar(`SELECT COUNT(*) AS n FROM outbox_events WHERE status = 'failed'`),
    scalar(`SELECT COUNT(*) AS n FROM files WHERE deleted_at IS NULL`),
    scalar(`SELECT COUNT(*) AS n FROM file_objects`),
  ]);

  // Orphan objects: read from the most recent completed reconciliation run's
  // roll-up rather than re-listing storage on every snapshot.
  let orphanObjects = 0;
  try {
    const { rows } = await query(
      `SELECT COALESCE((details->'orphan_objects'->>'issuesFound')::int, 0) AS n
         FROM reconciliation_runs
        WHERE status = 'completed' AND details ? 'orphan_objects'
        ORDER BY started_at DESC LIMIT 1`
    );
    orphanObjects = parseInt(rows[0] && rows[0].n, 10) || 0;
  } catch {
    orphanObjects = 0;
  }

  const lastBackup = await kvGet(KV_LAST_BACKUP);
  const lastRestoreTest = await kvGet(KV_LAST_RESTORE_TEST);

  const metrics = {
    healthy_assets: healthyAssets,
    missing_objects: missingObjects,
    orphan_objects: orphanObjects,
    corrupt_objects: corruptObjects,
    stuck_jobs: stuckJobs,
    dead_jobs: deadJobs,
    failed_webhooks: failedWebhooks,
    pending_restores: pendingRestores,
    pending_archives: pendingArchives,
    total_files: totalFiles,
    total_objects: totalObjects,
    last_backup_at: (lastBackup && lastBackup.at) || null,
    last_restore_test_at: (lastRestoreTest && lastRestoreTest.at) || null,
  };

  let snapshotId = null;
  const capturedAt = new Date().toISOString();
  if (persist) {
    const { rows } = await query(
      `INSERT INTO health_snapshots (metrics) VALUES ($1) RETURNING id, captured_at`,
      [JSON.stringify(metrics)]
    );
    snapshotId = rows[0] ? rows[0].id : null;
  }

  return { metrics, snapshotId, captured_at: capturedAt };
}

/** The latest persisted snapshot, or null. */
async function latestSnapshot() {
  const { rows } = await query(
    `SELECT id, captured_at, metrics FROM health_snapshots ORDER BY captured_at DESC LIMIT 1`
  );
  return rows[0] || null;
}

module.exports = {
  computeHealth,
  latestSnapshot,
  setLastBackupAt,
  setLastRestoreTestAt,
  KV_LAST_BACKUP,
  KV_LAST_RESTORE_TEST,
};
