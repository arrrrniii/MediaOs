/**
 * Intelligent lifecycle management (Phase 5).
 *
 * Two responsibilities:
 *   1. The daily SCANNER (scanProject / scanAll): finds files that have gone
 *      cold — active, unprotected, not on legal hold, and untouched for longer
 *      than the project's inactive_days policy — flags them 'cold_candidate',
 *      records an immutable audit row, and raises ONE review notification per
 *      project per run that produced new candidates. It NEVER deletes anything.
 *
 *   2. The inbox ACTIONS (applyAction): the operator-driven transitions from
 *      the review inbox — keep, protect, archive, mark for deletion, delete
 *      after grace, restore. Every action writes an audit row; deletion is
 *      blocked for protected or legal-hold files.
 *
 * Archive/restore only transition state + enqueue a job here; the ARCHIVE and
 * RESTORE processors themselves land in Phase 6/7.
 */

const { query, withTransaction } = require('../db');
const { addJob, QUEUES, isEnabled } = require('../queue');
const fileService = require('./fileService');

const SCANNER_ACTOR = 'system:scanner';

const DEFAULT_POLICY = {
  enabled: true,
  inactiveDays: 90,
  inactiveAction: 'review',
  deleteGraceDays: 30,
  autoDelete: false,
  restoreOnAccess: true,
};

// Which membership role an inbox action requires. Destructive/protective
// actions need admin+, the rest editor+.
const ACTION_MIN_ROLE = {
  keep: 'editor',
  archive_source: 'editor',
  archive_all: 'editor',
  restore: 'editor',
  protect: 'admin',
  mark_delete: 'admin',
  delete_after_grace: 'admin',
};

const KNOWN_ACTIONS = Object.keys(ACTION_MIN_ROLE);

function actionError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * Read a project's lifecycle policy from project.settings.lifecycle_policy,
 * falling back to defaults for any missing/invalid field.
 */
function getLifecyclePolicy(project) {
  const raw = (project && project.settings && project.settings.lifecycle_policy) || {};
  return {
    enabled: raw.enabled !== false,
    inactiveDays: Number.isFinite(raw.inactive_days) ? raw.inactive_days : DEFAULT_POLICY.inactiveDays,
    inactiveAction: typeof raw.inactive_action === 'string' ? raw.inactive_action : DEFAULT_POLICY.inactiveAction,
    deleteGraceDays: Number.isFinite(raw.delete_grace_days) ? raw.delete_grace_days : DEFAULT_POLICY.deleteGraceDays,
    autoDelete: raw.auto_delete === true,
    restoreOnAccess: raw.restore_on_access !== false,
  };
}

/**
 * Append one immutable lifecycle_audit row. `exec` is db.query or a pg
 * transaction client's query, so the audit can commit atomically with the
 * state change that produced it.
 */
async function writeAudit(exec, a) {
  await exec(
    `INSERT INTO lifecycle_audit
       (account_id, project_id, file_id, action, from_state, to_state, actor, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      a.accountId || null,
      a.projectId || null,
      a.fileId || null,
      a.action,
      a.fromState || null,
      a.toState || null,
      a.actor || null,
      a.detail ? JSON.stringify(a.detail) : '{}',
    ]
  );
}

/**
 * Estimated storage that could be reclaimed per file for a set of candidates.
 * Returns a Map fileId → { totalBytes, coldCandidateBytes }, where totalBytes
 * is every physical copy and coldCandidateBytes is the subset currently on a
 * hot/warm tier (i.e. what would actually move to cold).
 */
async function savingsForFiles(fileIds) {
  const map = new Map();
  if (fileIds.length === 0) return map;
  const { rows } = await query(
    `SELECT file_id,
            COALESCE(SUM(size), 0) AS total_bytes,
            COALESCE(SUM(size) FILTER (WHERE storage_tier IN ('hot', 'warm')), 0) AS cold_candidate_bytes
       FROM file_objects
      WHERE file_id = ANY($1)
      GROUP BY file_id`,
    [fileIds]
  );
  for (const r of rows) {
    map.set(r.file_id, {
      totalBytes: parseInt(r.total_bytes, 10) || 0,
      coldCandidateBytes: parseInt(r.cold_candidate_bytes, 10) || 0,
    });
  }
  return map;
}

/**
 * Scan one project for newly-cold files. Idempotent: a file already in
 * cold_candidate is not selected again, so a second run makes no new audit
 * rows and raises no new notification.
 *
 * @returns {Promise<{ scanned:boolean, candidates:number, totalBytes:number,
 *                     coldCandidateBytes:number, notified:boolean }>}
 */
async function scanProject(project) {
  const policy = getLifecyclePolicy(project);
  if (!policy.enabled) {
    return { scanned: false, candidates: 0, totalBytes: 0, coldCandidateBytes: 0, notified: false };
  }

  // Cold = active, not deleted, not protected, not legal-hold (legal_hold is a
  // distinct lifecycle_state, excluded by the state='active' filter), and
  // never accessed or last accessed before the inactive-days cutoff.
  const { rows: candidates } = await query(
    `SELECT id, last_accessed_at
       FROM files
      WHERE project_id = $1
        AND lifecycle_state = 'active'
        AND deleted_at IS NULL
        AND protected_from_delete = FALSE
        AND (last_accessed_at IS NULL OR last_accessed_at < NOW() - ($2 || ' days')::interval)`,
    [project.id, String(policy.inactiveDays)]
  );

  if (candidates.length === 0) {
    return { scanned: true, candidates: 0, totalBytes: 0, coldCandidateBytes: 0, notified: false };
  }

  const ids = candidates.map((c) => c.id);
  const savings = await savingsForFiles(ids);

  let flagged = 0;
  let totalBytes = 0;
  let coldCandidateBytes = 0;

  for (const c of candidates) {
    const s = savings.get(c.id) || { totalBytes: 0, coldCandidateBytes: 0 };
    // Guarded transition: only flip a file that is STILL active, so a
    // concurrent scan or an operator action in flight can't double-flag it.
    const flipped = await withTransaction(async (client) => {
      const { rowCount } = await client.query(
        `UPDATE files SET lifecycle_state = 'cold_candidate'
          WHERE id = $1 AND lifecycle_state = 'active' AND deleted_at IS NULL`,
        [c.id]
      );
      if (rowCount !== 1) return false;
      await writeAudit(client.query.bind(client), {
        accountId: project.account_id,
        projectId: project.id,
        fileId: c.id,
        action: 'scan.cold_candidate',
        fromState: 'active',
        toState: 'cold_candidate',
        actor: SCANNER_ACTOR,
        detail: {
          last_accessed_at: c.last_accessed_at,
          inactive_days: policy.inactiveDays,
          total_bytes: s.totalBytes,
          cold_candidate_bytes: s.coldCandidateBytes,
        },
      });
      return true;
    });

    if (flipped) {
      flagged++;
      totalBytes += s.totalBytes;
      coldCandidateBytes += s.coldCandidateBytes;
    }
  }

  let notified = false;
  if (flagged > 0) {
    await query(
      `INSERT INTO lifecycle_notifications (account_id, project_id, type, title, body, data)
       VALUES ($1, $2, 'lifecycle_review', $3, $4, $5)`,
      [
        project.account_id,
        project.id,
        `${flagged} file${flagged === 1 ? '' : 's'} ready for review in ${project.name || 'a project'}`,
        `The lifecycle scanner flagged ${flagged} inactive file${flagged === 1 ? '' : 's'} as cold candidates. ` +
          `Reviewing them could reclaim up to ${coldCandidateBytes} bytes of hot storage.`,
        JSON.stringify({
          candidate_count: flagged,
          total_bytes: totalBytes,
          cold_candidate_bytes: coldCandidateBytes,
          project_id: project.id,
          project_name: project.name || null,
        }),
      ]
    );
    notified = true;
  }

  return { scanned: true, candidates: flagged, totalBytes, coldCandidateBytes, notified };
}

/**
 * Scan every active project. Optionally target a single projectId.
 * @returns {Promise<{ projects:number, candidates:number, totalBytes:number,
 *                     coldCandidateBytes:number, notifications:number }>}
 */
async function scanAll({ projectId = null } = {}) {
  const params = [];
  let where = "status != 'deleted'";
  if (projectId) {
    params.push(projectId);
    where = `id = $1 AND ${where}`;
  }
  const { rows: projects } = await query(
    `SELECT id, account_id, name, settings FROM projects WHERE ${where}`,
    params
  );

  const summary = { projects: 0, candidates: 0, totalBytes: 0, coldCandidateBytes: 0, notifications: 0 };
  for (const project of projects) {
    try {
      const r = await scanProject(project);
      summary.projects++;
      summary.candidates += r.candidates;
      summary.totalBytes += r.totalBytes;
      summary.coldCandidateBytes += r.coldCandidateBytes;
      if (r.notified) summary.notifications++;
    } catch (err) {
      console.error(`Lifecycle scan failed for project ${project.id}:`, err.message);
    }
  }
  return summary;
}

function assertDeletable(file) {
  if (file.protected_from_delete) {
    throw actionError(403, 'FILE_PROTECTED', 'This file is protected from deletion');
  }
  if (file.lifecycle_state === 'legal_hold') {
    throw actionError(403, 'LEGAL_HOLD', 'This file is under legal hold and cannot be deleted');
  }
}

/** Enqueue a durable job if the queue is live; otherwise no-op (best effort). */
function enqueue(queueName, jobName, data, opts) {
  if (!isEnabled()) return;
  addJob(queueName, jobName, data, opts).catch((err) => {
    console.error(`Failed to enqueue ${queueName}/${jobName} for ${data.fileId}:`, err.message);
  });
}

/**
 * Apply an inbox action to a file. `project` supplies the account id (for
 * audit) and the delete-grace policy. Returns the updated files row, or throws
 * an error carrying { status, code }.
 */
async function applyAction(file, project, action, actor) {
  if (!KNOWN_ACTIONS.includes(action)) {
    throw actionError(400, 'INVALID_ACTION', `Unknown lifecycle action: ${action}`);
  }
  const from = file.lifecycle_state;
  const policy = getLifecyclePolicy(project);
  const auditBase = {
    accountId: project.account_id,
    projectId: project.id,
    fileId: file.id,
    actor,
    fromState: from,
  };

  if (action === 'keep') {
    await withTransaction(async (client) => {
      await client.query(`UPDATE files SET lifecycle_state = 'active' WHERE id = $1`, [file.id]);
      await writeAudit(client.query.bind(client), { ...auditBase, action: 'action.keep', toState: 'active' });
    });
  } else if (action === 'protect') {
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE files SET lifecycle_state = 'active', protected_from_delete = TRUE WHERE id = $1`,
        [file.id]
      );
      await writeAudit(client.query.bind(client), {
        ...auditBase, action: 'action.protect', toState: 'active', detail: { protected: true },
      });
    });
  } else if (action === 'archive_source' || action === 'archive_all') {
    const scope = action === 'archive_source' ? 'source' : 'all';
    await withTransaction(async (client) => {
      await client.query(`UPDATE files SET lifecycle_state = 'archiving' WHERE id = $1`, [file.id]);
      // Record intent on the physical objects the Phase-6 archiver will move.
      if (scope === 'source') {
        await client.query(
          `UPDATE file_objects
              SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{archive_intent}', 'true')
            WHERE file_id = $1 AND role = 'source'`,
          [file.id]
        );
      } else {
        await client.query(
          `UPDATE file_objects
              SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{archive_intent}', 'true')
            WHERE file_id = $1`,
          [file.id]
        );
      }
      await writeAudit(client.query.bind(client), {
        ...auditBase, action: `action.${action}`, toState: 'archiving', detail: { scope },
      });
    });
    enqueue(QUEUES.ARCHIVE, 'archive', { fileId: file.id, projectId: project.id, scope }, { jobId: `archive:${file.id}` });
  } else if (action === 'mark_delete') {
    assertDeletable(file);
    const graceMs = policy.deleteGraceDays * 24 * 60 * 60 * 1000;
    const retentionUntil = new Date(Date.now() + graceMs);
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE files SET lifecycle_state = 'delete_candidate', retention_until = $2 WHERE id = $1`,
        [file.id, retentionUntil]
      );
      await writeAudit(client.query.bind(client), {
        ...auditBase, action: 'action.mark_delete', toState: 'delete_candidate',
        detail: { retention_until: retentionUntil.toISOString(), grace_days: policy.deleteGraceDays },
      });
    });
  } else if (action === 'delete_after_grace') {
    assertDeletable(file);
    const retention = file.retention_until ? new Date(file.retention_until) : null;
    if (!retention || retention.getTime() > Date.now()) {
      throw actionError(409, 'GRACE_NOT_ELAPSED', 'The deletion grace period has not elapsed yet');
    }
    // Soft delete via the canonical path (tombstone + file.deleted event +
    // storage cleanup + counter decrement), then record the terminal state.
    await fileService.deleteFile(file.id, project);
    await withTransaction(async (client) => {
      await client.query(`UPDATE files SET lifecycle_state = 'deleted' WHERE id = $1`, [file.id]);
      await writeAudit(client.query.bind(client), {
        ...auditBase, action: 'action.delete', toState: 'deleted',
      });
    });
  } else if (action === 'restore') {
    await withTransaction(async (client) => {
      await client.query(`UPDATE files SET lifecycle_state = 'restoring' WHERE id = $1`, [file.id]);
      await writeAudit(client.query.bind(client), {
        ...auditBase, action: 'action.restore', toState: 'restoring',
      });
    });
    enqueue(QUEUES.RESTORE, 'restore', { fileId: file.id, projectId: project.id }, { jobId: `restore:${file.id}` });
  }

  const { rows } = await query('SELECT * FROM files WHERE id = $1', [file.id]);
  return rows[0] || null;
}

module.exports = {
  getLifecyclePolicy,
  scanProject,
  scanAll,
  applyAction,
  writeAudit,
  savingsForFiles,
  ACTION_MIN_ROLE,
  KNOWN_ACTIONS,
  DEFAULT_POLICY,
  SCANNER_ACTOR,
};
