/**
 * Lifecycle inbox API (dashboard-facing, session-scoped).
 *
 * Surfaces the review queue the daily scanner fills, the account's review
 * notifications, and the per-file action + audit endpoints. Everything is
 * scoped to the caller's account: cross-tenant projects/files are reported as
 * 404 (via loadProject) or simply excluded from account-scoped lists.
 */

const { Router } = require('express');
const { sessionScope, requireRole, ROLE_RANK } = require('../middleware/sessionAuth');
const loadProject = require('../middleware/loadProject');
const { query } = require('../db');
const lifecycleService = require('../services/lifecycleService');

const router = Router();

function clampLimit(v) {
  return Math.min(100, Math.max(1, parseInt(v, 10) || 25));
}
function clampPage(v) {
  return Math.max(1, parseInt(v, 10) || 1);
}

/** The action we recommend for a row, from its state + grace timer. */
function suggestedAction(state, retentionUntil) {
  if (state === 'delete_candidate') {
    const passed = retentionUntil && new Date(retentionUntil).getTime() <= Date.now();
    return passed ? 'delete_after_grace' : 'awaiting_grace';
  }
  return 'archive_source';
}

// GET /api/v1/lifecycle/inbox — cold_candidate + delete_candidate files across
// every project in the caller's account.
router.get('/api/v1/lifecycle/inbox', ...sessionScope, requireRole('viewer'), async (req, res, next) => {
  try {
    const limit = clampLimit(req.query.limit);
    const page = clampPage(req.query.page);
    const offset = (page - 1) * limit;

    const { rows: countRows } = await query(
      `SELECT COUNT(*)::int AS total
         FROM files f
         JOIN projects p ON p.id = f.project_id
        WHERE p.account_id = $1
          AND f.deleted_at IS NULL
          AND f.lifecycle_state IN ('cold_candidate', 'delete_candidate')`,
      [req.account.id]
    );
    const total = countRows[0] ? countRows[0].total : 0;

    const { rows } = await query(
      `SELECT f.id, f.filename, f.lifecycle_state, f.last_accessed_at, f.access_count, f.updated_at,
              f.retention_until, f.size AS file_size, f.protected_from_delete,
              p.id AS project_id, p.name AS project_name,
              COALESCE(o.copies, 0) AS physical_copies,
              COALESCE(o.total_bytes, f.size, 0) AS total_bytes,
              COALESCE(o.cold_candidate_bytes, 0) AS cold_candidate_bytes,
              o.current_tier
         FROM files f
         JOIN projects p ON p.id = f.project_id
         LEFT JOIN LATERAL (
           SELECT COUNT(*) AS copies,
                  SUM(size) AS total_bytes,
                  SUM(size) FILTER (WHERE storage_tier IN ('hot', 'warm')) AS cold_candidate_bytes,
                  (ARRAY_AGG(storage_tier ORDER BY CASE storage_tier
                     WHEN 'hot' THEN 0 WHEN 'warm' THEN 1 WHEN 'cold' THEN 2 ELSE 3 END))[1] AS current_tier
             FROM file_objects WHERE file_id = f.id
         ) o ON TRUE
        WHERE p.account_id = $1
          AND f.deleted_at IS NULL
          AND f.lifecycle_state IN ('cold_candidate', 'delete_candidate')
        ORDER BY f.last_accessed_at ASC NULLS FIRST, f.id
        LIMIT $2 OFFSET $3`,
      [req.account.id, limit, offset]
    );

    const data = rows.map((r) => {
      const coldBytes = parseInt(r.cold_candidate_bytes, 10) || 0;
      return {
        file: { id: r.id, name: r.filename },
        project: { id: r.project_id, name: r.project_name },
        lifecycle_state: r.lifecycle_state,
        size: parseInt(r.total_bytes, 10) || 0,
        physical_copies: parseInt(r.physical_copies, 10) || 0,
        last_access: r.last_accessed_at,
        updated_at: r.updated_at,
        access_count: parseInt(r.access_count, 10) || 0,
        current_tier: r.current_tier || 'hot',
        estimated_savings: coldBytes,
        retention_until: r.retention_until,
        protected: r.protected_from_delete,
        suggested_action: suggestedAction(r.lifecycle_state, r.retention_until),
      };
    });

    res.json({ data, total, page, limit });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/lifecycle/notifications — account-scoped review notifications.
router.get('/api/v1/lifecycle/notifications', ...sessionScope, requireRole('viewer'), async (req, res, next) => {
  try {
    const status = req.query.status;
    const params = [req.account.id];
    let statusClause = '';
    if (status) {
      if (!['unread', 'read', 'dismissed'].includes(String(status))) {
        return res.status(400).json({ error: 'Invalid status filter', code: 'INVALID_STATUS' });
      }
      params.push(String(status));
      statusClause = `AND status = $${params.length}`;
    }

    const { rows } = await query(
      `SELECT id, project_id, type, title, body, data, status, created_at, read_at
         FROM lifecycle_notifications
        WHERE account_id = $1 ${statusClause}
        ORDER BY created_at DESC
        LIMIT 200`,
      params
    );

    const { rows: unread } = await query(
      `SELECT COUNT(*)::int AS n FROM lifecycle_notifications
        WHERE account_id = $1 AND status = 'unread'`,
      [req.account.id]
    );

    res.json({ data: rows, unread_count: unread[0] ? unread[0].n : 0 });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/lifecycle/notifications/:id/read | /dismiss
function notificationStatusRoute(suffix, newStatus) {
  router.post(`/api/v1/lifecycle/notifications/:id/${suffix}`, ...sessionScope, requireRole('viewer'), async (req, res, next) => {
    try {
      const { rowCount, rows } = await query(
        `UPDATE lifecycle_notifications
            SET status = $3,
                read_at = CASE WHEN $3 IN ('read', 'dismissed') THEN COALESCE(read_at, NOW()) ELSE read_at END
          WHERE id = $1 AND account_id = $2
        RETURNING id, status, read_at`,
        [req.params.id, req.account.id, newStatus]
      );
      if (rowCount === 0) {
        return res.status(404).json({ error: 'Notification not found', code: 'NOT_FOUND' });
      }
      res.json(rows[0]);
    } catch (err) {
      next(err);
    }
  });
}
notificationStatusRoute('read', 'read');
notificationStatusRoute('dismiss', 'dismissed');

// POST /api/v1/projects/:id/files/:fileId/lifecycle { action }
// Role is checked per-action (editor+ for keep/archive/restore, admin+ for
// protect/mark_delete/delete); requireRole('editor') keeps viewers out entirely.
router.post('/api/v1/projects/:id/files/:fileId/lifecycle', ...sessionScope, requireRole('editor'), loadProject, async (req, res, next) => {
  try {
    const action = req.body && req.body.action;
    if (!action || !lifecycleService.KNOWN_ACTIONS.includes(action)) {
      return res.status(400).json({
        error: `Invalid action. Use one of: ${lifecycleService.KNOWN_ACTIONS.join(', ')}`,
        code: 'INVALID_ACTION',
      });
    }

    // Per-action role gate.
    const needRole = lifecycleService.ACTION_MIN_ROLE[action];
    if ((ROLE_RANK[req.membershipRole] || 0) < (ROLE_RANK[needRole] || Infinity)) {
      return res.status(403).json({
        error: `Insufficient role. '${action}' requires ${needRole} or higher`,
        code: 'INSUFFICIENT_ROLE',
      });
    }

    // 'delete_after_grace' acts on a soft-deleted-in-progress file, so it must
    // still be loadable; every other action requires a live (non-deleted) file.
    const { rows } = await query(
      'SELECT * FROM files WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL',
      [req.params.fileId, req.project.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });
    }

    const updated = await lifecycleService.applyAction(rows[0], req.project, action, req.user.id);
    res.json({ data: updated });
  } catch (err) {
    if (err.status && err.code) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

// GET /api/v1/projects/:id/files/:fileId/lifecycle/audit — the file's trail.
router.get('/api/v1/projects/:id/files/:fileId/lifecycle/audit', ...sessionScope, requireRole('viewer'), loadProject, async (req, res, next) => {
  try {
    // Confirm the file belongs to the (already account-scoped) project. Include
    // soft-deleted files so their history stays visible.
    const { rows: fileRows } = await query(
      'SELECT id FROM files WHERE id = $1 AND project_id = $2',
      [req.params.fileId, req.project.id]
    );
    if (fileRows.length === 0) {
      return res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });
    }

    const { rows } = await query(
      `SELECT id, action, from_state, to_state, actor, detail, created_at
         FROM lifecycle_audit
        WHERE file_id = $1
        ORDER BY created_at DESC
        LIMIT 200`,
      [req.params.fileId]
    );

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
