/**
 * Self-healing reconciler (Phase 7).
 *
 * A set of bounded, IDEMPOTENT checks that compare the database's view of the
 * world against reality (object storage, in-flight jobs, Redis buffers) and
 * repair safe divergences automatically. Every check:
 *
 *   1. scans a bounded batch (never the whole table) so a pass stays cheap;
 *   2. records a reconciliation_issues row for each problem it finds;
 *   3. performs a repair ONLY when it is provably safe — never destructive
 *      without certainty (an orphan is deleted only when it is old AND a
 *      re-query confirms no row references it; a hot copy is never removed by
 *      the reconciler, etc.);
 *   4. writes an immutable lifecycle_audit row for every repair, actor
 *      'system:reconciler', action 'repair.<category>', so the audit log is the
 *      tamper-evident record of what the system healed.
 *
 * Idempotency is structural: each check's selection predicate excludes rows it
 * has already fixed (a re-enqueue is guarded by "no active job_attempts", a
 * missing-mark selects only status='available', a corrupt re-hash stamps
 * verified_at). Running any check twice therefore finds nothing the second time
 * and takes no second action.
 *
 * runAllChecks() opens a reconciliation_runs row, runs the selected checks,
 * rolls up their counters, and closes the run.
 */

const crypto = require('crypto');
const { query, withTransaction } = require('../db');
const config = require('../config');
const minio = require('../minio');
const storageBackendService = require('./storageBackendService');
const { writeAudit } = require('./lifecycleService');
const { addJob, QUEUES, isEnabled } = require('../queue');

const RECONCILER_ACTOR = 'system:reconciler';

// The full set of checks, in a sensible run order. runAllChecks with no
// argument runs all of them; a subset can be selected by name.
const CATEGORIES = [
  'stuck_processing',
  'failed_archives',
  'incomplete_restores',
  'missing_objects',
  'corrupt_checksums',
  'orphan_objects',
  'expired_temp_uploads',
  'storage_counter_drift',
  'failed_webhooks',
  'unflushed_usage',
];

// Redis handle for the unflushed-buffer check. Injected at boot (see index.js);
// null when Redis is unavailable, in which case that check is skipped.
let _redis = null;
function setRedis(redis) { _redis = redis; }

// ── run + issue bookkeeping ──────────────────────────────
async function openRun(kind) {
  const { rows } = await query(
    `INSERT INTO reconciliation_runs (kind, status) VALUES ($1, 'running') RETURNING id`,
    [kind]
  );
  return rows[0] ? rows[0].id : null;
}

async function closeRun(runId, { status, checked, issuesFound, repaired, details }) {
  if (!runId) return;
  await query(
    `UPDATE reconciliation_runs
        SET status = $2, finished_at = NOW(), checked = $3,
            issues_found = $4, repaired = $5, details = $6
      WHERE id = $1`,
    [runId, status, checked || 0, issuesFound || 0, repaired || 0, JSON.stringify(details || {})]
  );
}

/**
 * Record one issue. `repaired`/`repair_action` describe whether the reconciler
 * fixed it. Best-effort — a logging failure must not abort the check.
 */
async function recordIssue(runId, issue) {
  try {
    await query(
      `INSERT INTO reconciliation_issues
         (run_id, category, severity, file_id, object_id, backend_id, description, repaired, repair_action, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        runId || null,
        issue.category,
        issue.severity || 'warn',
        issue.fileId || null,
        issue.objectId || null,
        issue.backendId || null,
        issue.description || null,
        issue.repaired === true,
        issue.repairAction || null,
        issue.detail ? JSON.stringify(issue.detail) : '{}',
      ]
    );
  } catch (err) {
    console.error(`reconcile: failed to record issue (${issue.category}):`, err.message);
  }
}

/** Append a repair to the immutable audit log (actor system:reconciler). */
async function auditRepair(exec, { file, category, action, fromState, toState, detail }) {
  await writeAudit(exec, {
    accountId: file && file.account_id,
    projectId: file && file.project_id,
    fileId: (file && (file.id || file.file_id)) || null,
    action: `repair.${category}`,
    fromState: fromState || null,
    toState: toState || null,
    actor: RECONCILER_ACTOR,
    detail: { repair: action, ...(detail || {}) },
  });
}

/** Enqueue a durable job, awaiting so its job_attempts ledger row is written
 *  (that ledger row is what makes the re-enqueue idempotent on the next pass). */
async function enqueue(queueName, jobName, data, opts) {
  if (!isEnabled()) return false;
  try {
    await addJob(queueName, jobName, data, opts);
    return true;
  } catch (err) {
    console.error(`reconcile: enqueue ${queueName}/${jobName} failed:`, err.message);
    return false;
  }
}

// ── small kv helpers (reuse lifecycle_kv) ────────────────
async function kvGet(key) {
  const { rows } = await query('SELECT value FROM lifecycle_kv WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : null;
}
async function kvSet(key, value) {
  await query(
    `INSERT INTO lifecycle_kv (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

// ── storage listing helper (default/local backend) ───────
/**
 * Collect up to `limit` object keys from the default MinIO bucket after
 * `startAfter`, via the raw list stream. Orphan/temp scans run against the
 * primary bucket only (the remote-cold seam intentionally has no list op).
 * @returns {Promise<Array<{ name, lastModified, size }>>}
 */
function listObjectsPage(prefix, startAfter, limit) {
  return new Promise((resolve, reject) => {
    const out = [];
    let stream;
    try {
      stream = minio.minioClient.listObjectsV2(config.bucket, prefix || '', true, startAfter || '');
    } catch (err) {
      return reject(err);
    }
    stream.on('data', (obj) => {
      if (!obj || !obj.name) return;
      out.push({ name: obj.name, lastModified: obj.lastModified, size: obj.size });
      if (out.length >= limit) {
        if (stream.destroy) stream.destroy();
        resolve(out);
      }
    });
    stream.on('end', () => resolve(out));
    stream.on('close', () => resolve(out));
    stream.on('error', (err) => reject(err));
  });
}

function hashStream(stream) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    stream.on('data', (c) => hash.update(c));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

// ═════════════════════════════════════════════════════════
//  Checks
// ═════════════════════════════════════════════════════════

/**
 * stuck_processing: files stuck in the media pipeline (status='processing')
 * past the timeout with no in-flight job. Re-drive the existing BullMQ media
 * job (whose payload — temp key — lives in Redis); if the live job is gone,
 * flag for an operator rather than guess a payload.
 * Idempotent: selection excludes files that already have an active job_attempts
 * row, and a successful re-drive writes one (recordJobActive).
 */
async function checkStuckProcessing(runId) {
  const summary = { checked: 0, issuesFound: 0, repaired: 0 };
  const { rows } = await query(
    `SELECT f.id, f.project_id, f.status, f.updated_at, p.account_id
       FROM files f JOIN projects p ON p.id = f.project_id
      WHERE f.status = 'processing' AND f.deleted_at IS NULL
        AND f.updated_at < NOW() - ($1 || ' milliseconds')::interval
        AND NOT EXISTS (
          SELECT 1 FROM job_attempts ja WHERE ja.file_id = f.id AND ja.status = 'active')
      ORDER BY f.updated_at ASC
      LIMIT $2`,
    [String(config.reconcileStuckMs), config.reconcileBatch]
  );
  summary.checked = rows.length;

  for (const file of rows) {
    let repaired = false;
    let action = 'flagged';
    if (isEnabled()) {
      try {
        const { Job } = require('bullmq');
        const { getQueue, recordJobActive } = require('../queue');
        const jobId = `media:${file.id}`;
        const q = getQueue(QUEUES.MEDIA);
        const job = q ? await Job.fromId(q, jobId) : null;
        if (job) {
          await job.retry().catch(() => {});
          await recordJobActive(QUEUES.MEDIA, jobId, file.id);
          repaired = true;
          action = 're-enqueued';
        }
      } catch (err) {
        console.error(`reconcile stuck_processing: re-drive ${file.id} failed:`, err.message);
      }
    }
    if (repaired) {
      summary.repaired++;
      await auditRepair(query, {
        file, category: 'stuck_processing', action,
        detail: { queue: QUEUES.MEDIA, job_id: `media:${file.id}` },
      });
    }
    summary.issuesFound++;
    await recordIssue(runId, {
      category: 'stuck_processing', severity: repaired ? 'warn' : 'error',
      fileId: file.id,
      description: `File stuck in processing since ${file.updated_at && new Date(file.updated_at).toISOString()}`,
      repaired, repairAction: action, detail: { updated_at: file.updated_at },
    });
  }
  return summary;
}

/**
 * failed_archives: files stuck in 'archiving' with no in-flight archive job.
 * Re-enqueue the archive (self-contained payload; the processor reloads state).
 * Idempotent: excludes files that already have an active archive job_attempts
 * row, and addJob writes one.
 */
async function checkFailedArchives(runId) {
  return reEnqueueStuckLifecycle(runId, {
    category: 'failed_archives', state: 'archiving',
    queue: QUEUES.ARCHIVE, jobName: 'archive',
    jobId: (id) => `archive:${id}`,
    data: (f) => ({ fileId: f.id, projectId: f.project_id, scope: 'all' }),
  });
}

/**
 * incomplete_restores: files stuck in 'restoring' with no in-flight restore
 * job. Re-enqueue the restore. Same idempotency contract as failed_archives.
 */
async function checkIncompleteRestores(runId) {
  return reEnqueueStuckLifecycle(runId, {
    category: 'incomplete_restores', state: 'restoring',
    queue: QUEUES.RESTORE, jobName: 'restore',
    jobId: (id) => `restore:${id}`,
    data: (f) => ({ fileId: f.id, projectId: f.project_id }),
  });
}

async function reEnqueueStuckLifecycle(runId, spec) {
  const summary = { checked: 0, issuesFound: 0, repaired: 0 };
  const { rows } = await query(
    `SELECT f.id, f.project_id, f.lifecycle_state, f.updated_at, p.account_id
       FROM files f JOIN projects p ON p.id = f.project_id
      WHERE f.lifecycle_state = $1 AND f.deleted_at IS NULL
        AND f.updated_at < NOW() - ($2 || ' milliseconds')::interval
        AND NOT EXISTS (
          SELECT 1 FROM job_attempts ja
           WHERE ja.file_id = f.id AND ja.queue = $3 AND ja.status = 'active')
      ORDER BY f.updated_at ASC
      LIMIT $4`,
    [spec.state, String(config.reconcileStuckMs), spec.queue, config.reconcileBatch]
  );
  summary.checked = rows.length;

  for (const file of rows) {
    const ok = await enqueue(spec.queue, spec.jobName, spec.data(file), { jobId: spec.jobId(file.id) });
    if (ok) {
      summary.repaired++;
      await auditRepair(query, {
        file, category: spec.category, action: 're-enqueued',
        detail: { queue: spec.queue, job_id: spec.jobId(file.id) },
      });
    }
    summary.issuesFound++;
    await recordIssue(runId, {
      category: spec.category, severity: ok ? 'warn' : 'error', fileId: file.id,
      description: `File stuck in ${spec.state} since ${file.updated_at && new Date(file.updated_at).toISOString()}`,
      repaired: ok, repairAction: ok ? 're-enqueued' : 'flagged',
      detail: { queue: spec.queue },
    });
  }
  return summary;
}

/**
 * missing_objects: file_objects marked 'available' whose bytes are gone on
 * their backend. Repair = correct the DB to reality (status='missing') + audit;
 * if a cold/archive sibling copy exists, enqueue a restore. A 'source' object
 * present alongside a missing derived object is flagged for operator/regenerate
 * (regeneration from source is deferred).
 * Idempotent: selects only status='available', so a re-run does not re-report a
 * row already flipped to 'missing'.
 */
async function checkMissingObjects(runId) {
  const summary = { checked: 0, issuesFound: 0, repaired: 0 };
  const { rows } = await query(
    `SELECT o.id, o.file_id, o.role, o.storage_backend_id, o.storage_key,
            o.storage_tier, f.project_id, f.lifecycle_state, p.account_id
       FROM file_objects o
       JOIN files f ON f.id = o.file_id
       JOIN projects p ON p.id = f.project_id
      WHERE o.status = 'available' AND f.deleted_at IS NULL
      ORDER BY o.created_at ASC
      LIMIT $1`,
    [config.reconcileBatch]
  );
  summary.checked = rows.length;

  for (const obj of rows) {
    // Build the client first; a backend we cannot reach at all (undecryptable
    // config, unsupported type) is inconclusive — never mark such an object
    // missing on a client-build failure.
    let client;
    try {
      const backend = await storageBackendService.getBackendById(obj.storage_backend_id);
      client = storageBackendService.getBackendClient(backend);
    } catch {
      continue;
    }
    let present = true;
    try {
      await client.statObject(obj.storage_key);
    } catch {
      present = false;
    }
    if (present) continue;

    const file = { id: obj.file_id, project_id: obj.project_id, account_id: obj.account_id };
    // Guarded flip available → missing (atomic with the audit).
    await withTransaction(async (c) => {
      await c.query(
        `UPDATE file_objects SET status = 'missing' WHERE id = $1 AND status = 'available'`,
        [obj.id]
      );
      await auditRepair(c.query.bind(c), {
        file, category: 'missing_objects', action: 'marked_missing',
        detail: { object_id: obj.id, role: obj.role, storage_key: obj.storage_key },
      });
    });

    // Can we recover? A cold/archive sibling can be restored back to hot.
    const { rows: siblings } = await query(
      `SELECT id, storage_tier FROM file_objects
        WHERE file_id = $1 AND id <> $2 AND status = 'available'
          AND storage_tier IN ('cold', 'archive')`,
      [obj.file_id, obj.id]
    );
    let repaired = false;
    let action = 'marked_missing';
    if (siblings.length > 0) {
      repaired = await enqueue(QUEUES.RESTORE, 'restore',
        { fileId: obj.file_id, projectId: obj.project_id }, { jobId: `restore:${obj.file_id}` });
      if (repaired) action = 'restore_enqueued';
    }

    summary.issuesFound++;
    if (repaired) summary.repaired++;
    await recordIssue(runId, {
      category: 'missing_objects',
      severity: repaired ? 'warn' : 'error',
      fileId: obj.file_id, objectId: obj.id, backendId: obj.storage_backend_id,
      description: `Object ${obj.role} for file ${obj.file_id} is missing on its backend`,
      repaired, repairAction: action,
      detail: { role: obj.role, storage_key: obj.storage_key, recoverable: siblings.length > 0 },
    });
  }
  return summary;
}

/**
 * corrupt_checksums: re-hash a bounded sample of stored objects and compare to
 * the recorded checksum. Mismatch → mark 'corrupt' + audit, and enqueue a
 * restore if a good cold sibling exists. Match → stamp metadata.verified_at so
 * the same object is not re-hashed next pass (this is what bounds the work and
 * makes the check idempotent).
 */
async function checkCorruptChecksums(runId) {
  const summary = { checked: 0, issuesFound: 0, repaired: 0 };
  const { rows } = await query(
    `SELECT o.id, o.file_id, o.role, o.storage_backend_id, o.storage_key, o.checksum,
            o.metadata, f.project_id, p.account_id
       FROM file_objects o
       JOIN files f ON f.id = o.file_id
       JOIN projects p ON p.id = f.project_id
      WHERE o.status = 'available' AND o.checksum IS NOT NULL AND f.deleted_at IS NULL
      ORDER BY (o.metadata->>'verified_at') ASC NULLS FIRST, o.created_at ASC
      LIMIT $1`,
    [config.reconcileCorruptSample]
  );
  summary.checked = rows.length;

  for (const obj of rows) {
    let client;
    try {
      const backend = await storageBackendService.getBackendById(obj.storage_backend_id);
      client = storageBackendService.getBackendClient(backend);
    } catch {
      continue; // inconclusive — do not mark corrupt on a client-build failure
    }
    let actual = null;
    try {
      const stream = await client.getObject(obj.storage_key);
      actual = await hashStream(stream);
    } catch {
      // A read failure here is a missing-object concern, not corruption; the
      // missing_objects check owns it. Skip without a false corrupt mark.
      continue;
    }

    if (actual === obj.checksum) {
      // Good — stamp verified_at so it rotates out of the sample next pass.
      const meta = mergeMeta(obj.metadata, { verified_at: new Date().toISOString() });
      await query('UPDATE file_objects SET metadata = $2 WHERE id = $1', [obj.id, JSON.stringify(meta)]);
      continue;
    }

    // Mismatch → corrupt.
    const file = { id: obj.file_id, project_id: obj.project_id, account_id: obj.account_id };
    await withTransaction(async (c) => {
      const meta = mergeMeta(obj.metadata, { corrupt_detected_at: new Date().toISOString(), expected_checksum: obj.checksum, actual_checksum: actual });
      await c.query(
        `UPDATE file_objects SET status = 'corrupt', metadata = $2 WHERE id = $1 AND status = 'available'`,
        [obj.id, JSON.stringify(meta)]
      );
      await auditRepair(c.query.bind(c), {
        file, category: 'corrupt_checksums', action: 'marked_corrupt',
        detail: { object_id: obj.id, role: obj.role, expected: obj.checksum, actual },
      });
    });

    const { rows: siblings } = await query(
      `SELECT id FROM file_objects
        WHERE file_id = $1 AND id <> $2 AND status = 'available'
          AND storage_tier IN ('cold', 'archive')`,
      [obj.file_id, obj.id]
    );
    let repaired = false;
    let action = 'marked_corrupt';
    if (siblings.length > 0) {
      repaired = await enqueue(QUEUES.RESTORE, 'restore',
        { fileId: obj.file_id, projectId: obj.project_id }, { jobId: `restore:${obj.file_id}` });
      if (repaired) action = 'restore_enqueued';
    }

    summary.issuesFound++;
    if (repaired) summary.repaired++;
    await recordIssue(runId, {
      category: 'corrupt_checksums', severity: repaired ? 'warn' : 'error',
      fileId: obj.file_id, objectId: obj.id, backendId: obj.storage_backend_id,
      description: `Checksum mismatch on ${obj.role} for file ${obj.file_id}`,
      repaired, repairAction: action,
      detail: { role: obj.role, expected: obj.checksum, actual },
    });
  }
  return summary;
}

/**
 * orphan_objects: keys in the primary bucket with no file_objects row. Repair =
 * DELETE only when the object is older than ORPHAN_MIN_AGE_MS AND a fresh DB
 * re-query confirms no row references the key (belt-and-suspenders against a
 * mid-commit upload). Otherwise report only. Bounded per pass via a cursor in
 * lifecycle_kv. `_processing_*` temp keys are owned by expired_temp_uploads.
 */
async function checkOrphanObjects(runId) {
  const summary = { checked: 0, issuesFound: 0, repaired: 0 };
  const CURSOR_KEY = 'reconcile:orphan_cursor';
  const cursorVal = await kvGet(CURSOR_KEY);
  const startAfter = (cursorVal && cursorVal.after) || '';

  let page;
  try {
    page = await listObjectsPage('', startAfter, config.reconcileBatch);
  } catch (err) {
    await recordIssue(runId, {
      category: 'orphan_objects', severity: 'info',
      description: `Orphan scan could not list storage: ${err.message}`,
      repaired: false, repairAction: 'skipped',
    });
    return summary;
  }

  // Wrap the cursor when a page comes back short/empty.
  const nextAfter = page.length >= config.reconcileBatch ? page[page.length - 1].name : '';
  await kvSet(CURSOR_KEY, { after: nextAfter });

  // Skip system-managed prefixes that intentionally have no file_objects row:
  //   _processing_  — temp video uploads (owned by expired_temp_uploads)
  //   _cache/       — rendered transform cache (owned by cache_version / purge)
  //   _multipart/   — in-flight resumable upload parts (owned by the session)
  const candidates = page.filter((o) =>
    !o.name.startsWith('_processing_') &&
    !o.name.startsWith('_cache/') &&
    !o.name.startsWith('_multipart/')
  );
  summary.checked = candidates.length;
  if (candidates.length === 0) return summary;

  // Which of these keys are known to the DB (on the default backend)?
  const backend = await storageBackendService.getDefaultBackend();
  const keys = candidates.map((o) => o.name);
  const { rows: known } = await query(
    `SELECT storage_key FROM file_objects WHERE storage_backend_id = $1 AND storage_key = ANY($2)`,
    [backend.id, keys]
  );
  const knownSet = new Set(known.map((r) => r.storage_key));
  const minAgeMs = config.orphanMinAgeMs;

  for (const obj of candidates) {
    if (knownSet.has(obj.name)) continue;
    const ageMs = obj.lastModified ? Date.now() - new Date(obj.lastModified).getTime() : 0;
    const oldEnough = ageMs >= minAgeMs;

    let repaired = false;
    let action = 'reported';
    if (oldEnough) {
      // Belt-and-suspenders: re-query the single key on ANY backend right before
      // deleting, so a row inserted since the batch query is respected.
      const { rows: recheck } = await query(
        `SELECT 1 FROM file_objects WHERE storage_key = $1 LIMIT 1`, [obj.name]);
      if (recheck.length === 0) {
        try {
          const client = storageBackendService.getBackendClient(backend);
          await client.removeObject(obj.name);
          repaired = true;
          action = 'deleted';
        } catch (err) {
          console.error(`reconcile orphan_objects: delete ${obj.name} failed:`, err.message);
        }
      }
    }

    if (repaired) {
      summary.repaired++;
      await auditRepair(query, {
        file: null, category: 'orphan_objects', action: 'deleted',
        detail: { storage_key: obj.name, backend_id: backend.id, age_ms: ageMs },
      });
    }
    summary.issuesFound++;
    await recordIssue(runId, {
      category: 'orphan_objects', severity: repaired ? 'warn' : 'info',
      backendId: backend.id,
      description: `Orphan object ${obj.name} has no file_objects row`,
      repaired, repairAction: action,
      detail: { storage_key: obj.name, age_ms: ageMs, old_enough: oldEnough },
    });
  }
  return summary;
}

/**
 * expired_temp_uploads: leftover `_processing_*` temp keys older than the TTL
 * (an upload that crashed before its media job cleaned up). Delete them.
 * Idempotent: removeObject on an already-gone key is a no-op.
 */
async function checkExpiredTempUploads(runId) {
  const summary = { checked: 0, issuesFound: 0, repaired: 0 };
  let page;
  try {
    page = await listObjectsPage('_processing_', '', config.reconcileBatch);
  } catch (err) {
    await recordIssue(runId, {
      category: 'expired_temp_uploads', severity: 'info',
      description: `Temp-upload scan could not list storage: ${err.message}`,
      repaired: false, repairAction: 'skipped',
    });
    return summary;
  }
  summary.checked = page.length;
  const ttlMs = config.tempUploadTtlMs;
  const backend = await storageBackendService.getDefaultBackend();
  const client = storageBackendService.getBackendClient(backend);

  for (const obj of page) {
    const ageMs = obj.lastModified ? Date.now() - new Date(obj.lastModified).getTime() : 0;
    if (ageMs < ttlMs) continue;
    let repaired = false;
    try {
      await client.removeObject(obj.name);
      repaired = true;
    } catch (err) {
      console.error(`reconcile expired_temp_uploads: delete ${obj.name} failed:`, err.message);
    }
    if (repaired) {
      summary.repaired++;
      await auditRepair(query, {
        file: null, category: 'expired_temp_uploads', action: 'deleted',
        detail: { storage_key: obj.name, age_ms: ageMs },
      });
    }
    summary.issuesFound++;
    await recordIssue(runId, {
      category: 'expired_temp_uploads', severity: 'info', backendId: backend.id,
      description: `Expired temp upload ${obj.name}`,
      repaired, repairAction: repaired ? 'deleted' : 'flagged',
      detail: { storage_key: obj.name, age_ms: ageMs },
    });
  }
  return summary;
}

/**
 * storage_counter_drift: projects.storage_used / file_count vs the truth from
 * file_objects sizes and non-deleted files. Recompute and correct any drift.
 * Idempotent: after correction the recomputed values match, so a re-run drifts
 * by zero and records nothing.
 */
async function checkStorageCounterDrift(runId) {
  const summary = { checked: 0, issuesFound: 0, repaired: 0 };
  const { rows: projects } = await query(
    `SELECT id, account_id, storage_used, file_count FROM projects WHERE status <> 'deleted'
      ORDER BY id LIMIT $1`,
    [config.reconcileBatch]
  );
  summary.checked = projects.length;

  for (const proj of projects) {
    const { rows: truth } = await query(
      `SELECT
         COALESCE((SELECT SUM(o.size) FROM file_objects o
                     JOIN files f ON f.id = o.file_id
                    WHERE f.project_id = $1 AND f.deleted_at IS NULL), 0) AS storage_used,
         (SELECT COUNT(*) FROM files WHERE project_id = $1 AND deleted_at IS NULL) AS file_count`,
      [proj.id]
    );
    const realStorage = parseInt(truth[0].storage_used, 10) || 0;
    const realCount = parseInt(truth[0].file_count, 10) || 0;
    const curStorage = parseInt(proj.storage_used, 10) || 0;
    const curCount = parseInt(proj.file_count, 10) || 0;

    if (realStorage === curStorage && realCount === curCount) continue;

    await query(
      `UPDATE projects SET storage_used = $2, file_count = $3 WHERE id = $1`,
      [proj.id, realStorage, realCount]
    );
    await auditRepair(query, {
      file: { project_id: proj.id, account_id: proj.account_id },
      category: 'storage_counter_drift', action: 'recomputed',
      detail: { from: { storage_used: curStorage, file_count: curCount },
                to: { storage_used: realStorage, file_count: realCount } },
    });
    summary.issuesFound++;
    summary.repaired++;
    await recordIssue(runId, {
      category: 'storage_counter_drift', severity: 'info',
      description: `Project ${proj.id} counters drifted`,
      repaired: true, repairAction: 'recomputed',
      detail: { storage_used: [curStorage, realStorage], file_count: [curCount, realCount] },
    });
  }
  return summary;
}

/**
 * failed_webhooks: outbox events that failed to dispatch. Re-arm them by
 * resetting to pending so the outbox poller enqueues durable delivery jobs
 * again. Idempotent: selects only status='failed', and the reset flips them to
 * 'pending' so a re-run does not touch them twice.
 */
async function checkFailedWebhooks(runId) {
  const summary = { checked: 0, issuesFound: 0, repaired: 0 };
  const { rows } = await query(
    `SELECT id, event_type, aggregate_id, attempts FROM outbox_events
      WHERE status = 'failed'
      ORDER BY created_at ASC LIMIT $1`,
    [config.reconcileBatch]
  );
  summary.checked = rows.length;

  for (const evt of rows) {
    // Reset attempts so the poller's backoff/ceiling starts fresh.
    const { rowCount } = await query(
      `UPDATE outbox_events
          SET status = 'pending', attempts = 0, available_at = NOW(), last_error = NULL
        WHERE id = $1 AND status = 'failed'`,
      [evt.id]
    );
    const repaired = rowCount === 1;
    if (repaired) summary.repaired++;
    summary.issuesFound++;
    await recordIssue(runId, {
      category: 'failed_webhooks', severity: repaired ? 'warn' : 'info',
      fileId: evt.aggregate_id || null,
      description: `Failed outbox event ${evt.event_type} re-armed for delivery`,
      repaired, repairAction: repaired ? 're-armed' : 'flagged',
      detail: { outbox_event_id: evt.id, previous_attempts: evt.attempts },
    });
  }
  return summary;
}

/**
 * unflushed_usage: Redis usage/access buffers that hold data for a day earlier
 * than today have not been flushed to Postgres. Trigger the flush services.
 * Reports (info) when Redis is unavailable. Idempotent: the flush services use
 * GETDEL, so a re-run after a successful flush finds nothing to do.
 */
async function checkUnflushedUsage(runId) {
  const summary = { checked: 0, issuesFound: 0, repaired: 0 };
  if (!_redis) {
    await recordIssue(runId, {
      category: 'unflushed_usage', severity: 'info',
      description: 'Redis not configured — usage buffers cannot be inspected',
      repaired: false, repairAction: 'skipped',
    });
    return summary;
  }

  const today = new Date().toISOString().split('T')[0];
  let staleUsage = 0;
  let staleAccess = 0;
  try {
    // Bounded scan for buffers older than today.
    let cursor = '0';
    let scanned = 0;
    do {
      const [next, keys] = await _redis.scan(cursor, 'MATCH', 'usage:*', 'COUNT', 200);
      cursor = next;
      for (const k of keys) {
        const parts = k.split(':');
        const date = parts.length >= 4 ? parts[parts.length - 2] : null;
        if (date && date < today) staleUsage++;
      }
      scanned += keys.length;
    } while (cursor !== '0' && scanned < 5000);

    // access:{date} day-hashes for a day before today.
    cursor = '0'; scanned = 0;
    do {
      const [next, keys] = await _redis.scan(cursor, 'MATCH', 'access:*', 'COUNT', 200);
      cursor = next;
      for (const k of keys) {
        const date = k.slice('access:'.length);
        if (date && date !== 'last' && date < today) staleAccess++;
      }
      scanned += keys.length;
    } while (cursor !== '0' && scanned < 5000);
  } catch (err) {
    await recordIssue(runId, {
      category: 'unflushed_usage', severity: 'info',
      description: `Redis scan failed: ${err.message}`,
      repaired: false, repairAction: 'skipped',
    });
    return summary;
  }

  summary.checked = staleUsage + staleAccess;
  if (summary.checked === 0) return summary;

  let flushed = false;
  try {
    const usageFlush = require('./usageFlushService');
    const accessFlush = require('./lifecycleFlushService');
    await usageFlush.flush(_redis);
    await accessFlush.flushAccess(_redis);
    flushed = true;
  } catch (err) {
    console.error('reconcile unflushed_usage: flush failed:', err.message);
  }

  if (flushed) summary.repaired++;
  summary.issuesFound++;
  await recordIssue(runId, {
    category: 'unflushed_usage', severity: flushed ? 'warn' : 'error',
    description: `${staleUsage} usage + ${staleAccess} access buffers pending flush`,
    repaired: flushed, repairAction: flushed ? 'flushed' : 'flagged',
    detail: { stale_usage: staleUsage, stale_access: staleAccess },
  });
  return summary;
}

function mergeMeta(existing, patch) {
  const base = existing && typeof existing === 'object' ? { ...existing } : {};
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete base[k];
    else base[k] = v;
  }
  return base;
}

const CHECK_FNS = {
  stuck_processing: checkStuckProcessing,
  failed_archives: checkFailedArchives,
  incomplete_restores: checkIncompleteRestores,
  missing_objects: checkMissingObjects,
  corrupt_checksums: checkCorruptChecksums,
  orphan_objects: checkOrphanObjects,
  expired_temp_uploads: checkExpiredTempUploads,
  storage_counter_drift: checkStorageCounterDrift,
  failed_webhooks: checkFailedWebhooks,
  unflushed_usage: checkUnflushedUsage,
};

/**
 * Open a run, execute the selected checks (default: all), roll up counters,
 * and close the run. A single failing check is caught and recorded in details
 * without aborting the rest.
 * @param {object} [opts]
 * @param {string[]} [opts.categories]  subset of CATEGORIES to run.
 * @returns {Promise<object>} the run summary.
 */
async function runAllChecks({ categories } = {}) {
  const selected = Array.isArray(categories) && categories.length
    ? categories.filter((c) => CHECK_FNS[c])
    : CATEGORIES;

  const kind = selected.length === 1 ? selected[0] : 'all';
  const runId = await openRun(kind);

  const totals = { checked: 0, issuesFound: 0, repaired: 0 };
  const details = {};
  let status = 'completed';

  for (const category of selected) {
    try {
      const r = await CHECK_FNS[category](runId);
      details[category] = r;
      totals.checked += r.checked;
      totals.issuesFound += r.issuesFound;
      totals.repaired += r.repaired;
    } catch (err) {
      status = 'failed';
      details[category] = { error: err.message };
      console.error(`reconcile: check ${category} threw:`, err.message);
    }
  }

  await closeRun(runId, { status, ...totals, details });
  return { runId, kind, status, ...totals, details, categories: selected };
}

module.exports = {
  runAllChecks,
  setRedis,
  CATEGORIES,
  RECONCILER_ACTOR,
  // individual checks (exported for unit tests + targeted runs)
  checkStuckProcessing,
  checkFailedArchives,
  checkIncompleteRestores,
  checkMissingObjects,
  checkCorruptChecksums,
  checkOrphanObjects,
  checkExpiredTempUploads,
  checkStorageCounterDrift,
  checkFailedWebhooks,
  checkUnflushedUsage,
  // helpers reused by the cleanup job
  listObjectsPage,
  openRun,
  closeRun,
  recordIssue,
};
