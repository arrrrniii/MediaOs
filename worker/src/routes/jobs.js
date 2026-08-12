/**
 * Dashboard-facing job visibility + retry.
 *
 * Reads the job_attempts ledger (the DB mirror of BullMQ state) so the
 * dashboard can list failed background jobs and retry them without touching
 * Redis. Every query is scoped through the caller's account via the job's
 * file → project → account chain; a job in another tenant is reported as 404.
 */

const { Router } = require('express');
const { sessionScope, requireRole } = require('../middleware/sessionAuth');
const loadProject = require('../middleware/loadProject');
const { query } = require('../db');
const { getQueue, recordJobActive } = require('../queue');

const router = Router();

const LISTABLE_STATUSES = ['active', 'completed', 'failed', 'stalled', 'dead'];

// GET /api/v1/projects/:id/jobs?status=failed — list this project's jobs.
router.get('/api/v1/projects/:id/jobs', ...sessionScope, requireRole('viewer'), loadProject, async (req, res, next) => {
  try {
    const params = [req.project.id];
    let statusClause = '';
    if (req.query.status) {
      const requested = String(req.query.status);
      if (!LISTABLE_STATUSES.includes(requested)) {
        return res.status(400).json({ error: 'Invalid status filter', code: 'INVALID_STATUS' });
      }
      params.push(requested);
      statusClause = `AND ja.status = $${params.length}`;
    }

    const { rows } = await query(
      `SELECT ja.id, ja.queue, ja.job_id, ja.file_id, ja.status, ja.attempt,
              ja.error, ja.created_at, ja.finished_at,
              f.filename, f.type, f.status AS file_status
         FROM job_attempts ja
         JOIN files f ON f.id = ja.file_id
        WHERE f.project_id = $1 ${statusClause}
        ORDER BY ja.created_at DESC
        LIMIT 200`,
      params
    );

    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/jobs/:jobId/retry — re-enqueue a job (admin only).
router.post('/api/v1/jobs/:jobId/retry', ...sessionScope, requireRole('admin'), async (req, res, next) => {
  try {
    const jobId = req.params.jobId;

    // Ownership: the job's file must belong to a project in the caller's
    // account. A job in another tenant is indistinguishable from a missing one.
    const { rows } = await query(
      `SELECT ja.queue, ja.job_id, ja.file_id
         FROM job_attempts ja
         JOIN files f ON f.id = ja.file_id
         JOIN projects p ON p.id = f.project_id
        WHERE ja.job_id = $1 AND p.account_id = $2`,
      [jobId, req.account.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Job not found', code: 'NOT_FOUND' });
    }

    const { queue: queueName, file_id: fileId } = rows[0];

    // BullMQ retains failed jobs (removeOnFail:false), so the original job —
    // with its data — is usually still in Redis; retry() moves it back to
    // waiting to run with the exact same payload.
    let retried = false;
    try {
      const { Job } = require('bullmq');
      const queue = getQueue(queueName);
      const job = await Job.fromId(queue, jobId);
      if (job) {
        await job.retry();
        retried = true;
      }
    } catch (err) {
      // Fall through to the "expired" response below.
      console.error(`Retry via BullMQ failed for ${queueName}/${jobId}:`, err.message);
    }

    if (!retried) {
      return res.status(409).json({
        error: 'Live job state has expired and cannot be retried automatically',
        code: 'JOB_STATE_EXPIRED',
      });
    }

    // Reflect the retry in the ledger so the dashboard shows it active again.
    await recordJobActive(queueName, jobId, fileId);

    res.json({ retried: true, job_id: jobId, queue: queueName });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
