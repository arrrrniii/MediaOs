/**
 * Operator-facing system health + reconciliation control (Phase 7).
 *
 * These endpoints are NOT per-tenant: they report and act on the whole install
 * (every account's assets, jobs, and storage). That is an operator concern, so
 * they authenticate with the MASTER_KEY via adminAuth — the same gate the
 * account-provisioning routes use — NOT sessionAuth (which is account-scoped).
 * They are rate-limited per IP like the other admin routes.
 */

const { Router } = require('express');
const adminAuth = require('../middleware/adminAuth');
const ipRateLimit = require('../middleware/ipRateLimit');
const config = require('../config');
const { query } = require('../db');
const healthService = require('../services/healthService');
const reconcileService = require('../services/reconcileService');
const { addJob, QUEUES, isEnabled } = require('../queue');

const router = Router();

// Same shape as accounts.js: per-IP admin limiter + master-key auth.
const systemAdmin = [ipRateLimit('admin', config.adminRateLimit), adminAuth];

// GET /api/v1/system/health — latest snapshot + a fresh live compute.
router.get('/api/v1/system/health', ...systemAdmin, async (req, res, next) => {
  try {
    const latest = await healthService.latestSnapshot();
    // Live compute without persisting (the repeatable job owns persistence).
    const live = await healthService.computeHealth({ persist: false });
    res.json({
      live: live.metrics,
      snapshot: latest
        ? { id: latest.id, captured_at: latest.captured_at, metrics: latest.metrics }
        : null,
    });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/system/reconciliation/runs — recent runs with issue-count roll-ups.
router.get('/api/v1/system/reconciliation/runs', ...systemAdmin, async (req, res, next) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const { rows } = await query(
      `SELECT r.id, r.kind, r.started_at, r.finished_at, r.checked, r.issues_found,
              r.repaired, r.status, r.details,
              COALESCE(e.error_count, 0) AS error_count
         FROM reconciliation_runs r
         LEFT JOIN (
           SELECT run_id, COUNT(*) FILTER (WHERE severity = 'error') AS error_count
             FROM reconciliation_issues GROUP BY run_id
         ) e ON e.run_id = r.id
        ORDER BY r.started_at DESC
        LIMIT $1`,
      [limit]
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/system/reconciliation/runs/:id/issues — issues for one run.
router.get('/api/v1/system/reconciliation/runs/:id/issues', ...systemAdmin, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, category, severity, file_id, object_id, backend_id, description,
              repaired, repair_action, detail, created_at
         FROM reconciliation_issues
        WHERE run_id = $1
        ORDER BY severity DESC, created_at ASC
        LIMIT 1000`,
      [req.params.id]
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/system/reconciliation/run — enqueue a reconcile pass.
// Body: { category?: string } — one category, or all when omitted. When the
// durable queue is unavailable the check runs inline so the operator still
// gets a result.
router.post('/api/v1/system/reconciliation/run', ...systemAdmin, async (req, res, next) => {
  try {
    const category = req.body && typeof req.body.category === 'string' ? req.body.category : null;
    if (category && !reconcileService.CATEGORIES.includes(category)) {
      return res.status(400).json({ error: `Unknown category "${category}"`, code: 'INVALID_CATEGORY' });
    }

    if (isEnabled()) {
      const jobName = category ? 'reconcile.category' : 'reconcile.all';
      const data = category ? { category } : {};
      const job = await addJob(QUEUES.RECONCILIATION, jobName, data);
      return res.status(202).json({ enqueued: true, job_id: job.id, category: category || 'all' });
    }

    // No durable queue — run it inline (bounded work) and return the summary.
    const summary = await reconcileService.runAllChecks({ categories: category ? [category] : undefined });
    res.json({ enqueued: false, ran_inline: true, summary });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
