/**
 * BullMQ workers + the transactional-outbox poller.
 *
 * Responsibilities:
 *   - MEDIA   : run the durable video processor (queue/processors/media.js)
 *   - WEBHOOK : deliver one webhook via webhookService.deliverOnce; BullMQ
 *               owns retries/backoff/DLQ, so a non-permanent failure just
 *               throws and BullMQ reschedules it.
 *   - OUTBOX  : a repeatable (~2s) job that drains outbox_events into durable
 *               WEBHOOK jobs using FOR UPDATE SKIP LOCKED so multiple worker
 *               nodes never double-deliver.
 *   - LIFECYCLE/ARCHIVE/RESTORE/RECONCILIATION/CLEANUP: scaffolded no-op
 *               workers whose processors are filled in by later phases.
 *
 * Every worker mirrors BullMQ job lifecycle into the job_attempts ledger so
 * the dashboard can list and retry failures without reaching into Redis. A
 * job that exhausts its attempts is marked 'dead' — that plus BullMQ's failed
 * set is the dead-letter surface.
 */

const { query } = require('../db');
const config = require('../config');
const { QUEUES, DEFAULT_JOB_OPTIONS, getConnection, getQueue, addJob } = require('./index');
const { processMediaJob } = require('./processors/media');
const { processArchiveJob } = require('./processors/archive');
const { processRestoreJob } = require('./processors/restore');
const webhookService = require('../services/webhookService');

// Video HLS transcodes are slow; default the media job timeout to the generous
// video knob (30 min) unless MEDIA_JOB_TIMEOUT_MS is set explicitly.
const MEDIA_TIMEOUT_MS = parseInt(process.env.MEDIA_JOB_TIMEOUT_MS || String(config.videoJobTimeoutMs), 10);
const OUTBOX_POLL_MS = parseInt(process.env.OUTBOX_POLL_MS || '2000', 10);
// Daily lifecycle scan. Cron pattern; default 03:00 every day.
const LIFECYCLE_SCAN_CRON = process.env.LIFECYCLE_SCAN_CRON || '0 3 * * *';
const OUTBOX_BATCH = parseInt(process.env.OUTBOX_BATCH || '50', 10);
const OUTBOX_MAX_ATTEMPTS = parseInt(process.env.OUTBOX_MAX_ATTEMPTS || '10', 10);

const workers = [];

// ── job_attempts ledger updates ─────────────────────────
async function markJobAttempt(queueName, jobId, status, { attempt, error } = {}) {
  if (!jobId) return;
  const terminal = ['completed', 'failed', 'dead'].includes(status);
  try {
    await query(
      `UPDATE job_attempts
         SET status = $3,
             attempt = COALESCE($4, attempt),
             error = $5,
             finished_at = CASE WHEN $6 THEN NOW() ELSE finished_at END
       WHERE queue = $1 AND job_id = $2`,
      [queueName, String(jobId), status, attempt || null, error || null, terminal]
    );
  } catch (err) {
    console.error(`Failed to update job_attempts ${queueName}/${jobId}:`, err.message);
  }
}

// A job has exhausted its attempts when attemptsMade reaches the configured
// attempts ceiling — at that point it is dead-lettered.
function isFinalFailure(job) {
  const ceiling = (job && job.opts && job.opts.attempts) || DEFAULT_JOB_OPTIONS.attempts;
  return job && job.attemptsMade >= ceiling;
}

/**
 * Wrap a processor with a hard timeout. BullMQ has no built-in per-job wall
 * clock, so a hung transcode would hold a worker slot forever; Promise.race
 * fails it instead, and BullMQ retries it.
 */
function withTimeout(processor, timeoutMs) {
  if (!timeoutMs) return processor;
  return (job) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`job timed out after ${timeoutMs}ms`)), timeoutMs);
      if (timer.unref) timer.unref();
    });
    return Promise.race([Promise.resolve().then(() => processor(job)), timeout])
      .finally(() => clearTimeout(timer));
  };
}

/**
 * Create a Worker and wire its lifecycle events into the job_attempts ledger.
 */
function makeWorker(queueName, processor, { concurrency = 1, timeoutMs = 0 } = {}) {
  const { Worker } = require('bullmq');
  const worker = new Worker(queueName, withTimeout(processor, timeoutMs), {
    connection: getConnection(),
    concurrency,
  });

  worker.on('completed', (job) => {
    markJobAttempt(queueName, job && job.id, 'completed', { attempt: job && (job.attemptsMade + 1) });
  });

  worker.on('failed', (job, err) => {
    const status = isFinalFailure(job) ? 'dead' : 'failed';
    markJobAttempt(queueName, job && job.id, status, {
      attempt: job && job.attemptsMade,
      error: err && err.message,
    });
  });

  worker.on('stalled', (jobId) => {
    markJobAttempt(queueName, jobId, 'stalled');
  });

  worker.on('error', (err) => {
    console.error(`Worker error on ${queueName}:`, err.message);
  });

  workers.push(worker);
  return worker;
}

// ── Outbox drain ────────────────────────────────────────
/**
 * Turn one pending outbox event into durable delivery jobs. For file.* events
 * that means a WEBHOOK job per subscribed webhook, with an idempotent jobId
 * (`<webhookId>:<outboxEventId>`) so a re-drained event never double-delivers.
 * Extensible: add cases here as new event families gain durable consumers.
 */
async function routeOutboxEvent(client, evt) {
  const payload = evt.payload || {};
  if (typeof evt.event_type === 'string' && evt.event_type.startsWith('file.')) {
    // Resolve the project: prefer the payload, fall back to the file row.
    let projectId = payload.project_id;
    if (!projectId && evt.aggregate_id) {
      const { rows } = await client.query('SELECT project_id FROM files WHERE id = $1', [evt.aggregate_id]);
      projectId = rows[0] && rows[0].project_id;
    }
    if (!projectId) return; // nothing to deliver to

    const { rows: webhooks } = await client.query(
      "SELECT * FROM webhooks WHERE project_id = $1 AND status = 'active' AND $2 = ANY(events)",
      [projectId, evt.event_type]
    );

    for (const webhook of webhooks) {
      await addJob(
        QUEUES.WEBHOOK,
        'deliver',
        {
          webhook: { id: webhook.id, url: webhook.url, secret: webhook.secret },
          event: evt.event_type,
          data: payload,
          projectId,
          outboxEventId: evt.id,
          fileId: evt.aggregate_id || null,
        },
        { jobId: `wh:${webhook.id}:${evt.id}` }
      );
    }
  }
  // Other aggregate types (lifecycle, archive, …) route here in later phases.
}

/**
 * Drain a batch of due outbox events inside one transaction. FOR UPDATE SKIP
 * LOCKED means concurrent pollers each grab a disjoint set — no double work.
 */
async function drainOutbox() {
  const { withTransaction } = require('../db');
  return withTransaction(async (client) => {
    const { rows: events } = await client.query(
      `SELECT * FROM outbox_events
        WHERE status = 'pending' AND available_at <= NOW()
        ORDER BY available_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [OUTBOX_BATCH]
    );

    for (const evt of events) {
      try {
        await routeOutboxEvent(client, evt);
        await client.query(
          "UPDATE outbox_events SET status = 'delivered', delivered_at = NOW() WHERE id = $1",
          [evt.id]
        );
      } catch (err) {
        const attempts = (evt.attempts || 0) + 1;
        if (attempts >= OUTBOX_MAX_ATTEMPTS) {
          await client.query(
            "UPDATE outbox_events SET status = 'failed', attempts = $2, last_error = $3 WHERE id = $1",
            [evt.id, attempts, err.message]
          );
        } else {
          const backoffMs = Math.min(60000, 2000 * Math.pow(2, attempts));
          await client.query(
            `UPDATE outbox_events
               SET attempts = $2, last_error = $3,
                   available_at = NOW() + ($4 || ' milliseconds')::interval
             WHERE id = $1`,
            [evt.id, attempts, err.message, String(backoffMs)]
          );
        }
      }
    }
    return events.length;
  });
}

// ── Lifecycle scan processor ────────────────────────────
/**
 * Run the cold-file scanner. A payload with a projectId scans just that
 * project (e.g. an on-demand rescan); the repeatable daily job carries no
 * payload and scans every active project.
 */
async function processLifecycleJob(job) {
  const lifecycleService = require('../services/lifecycleService');
  const projectId = (job.data && job.data.projectId) || null;
  const summary = await lifecycleService.scanAll({ projectId });
  console.log(`[lifecycle] scan complete: ${JSON.stringify(summary)}`);
  return summary;
}

// ── Reconciliation processor (Phase 7) ──────────────────
/**
 * Self-healing reconciler. Job kinds:
 *   'reconcile.all'      — run every check (the repeatable pass).
 *   'reconcile.category' — run one category ({ category } in the payload).
 *   'health.snapshot'    — compute + persist a health snapshot.
 */
async function processReconciliationJob(job) {
  const name = job.name;
  if (name === 'health.snapshot') {
    const healthService = require('../services/healthService');
    const r = await healthService.computeHealth();
    console.log(`[health] snapshot ${r.snapshotId}: ${JSON.stringify(r.metrics)}`);
    return { snapshotId: r.snapshotId };
  }

  const reconcileService = require('../services/reconcileService');
  const categories = name === 'reconcile.category' && job.data && job.data.category
    ? [job.data.category]
    : undefined;
  const summary = await reconcileService.runAllChecks({ categories });
  console.log(`[reconcile] ${summary.kind} run ${summary.runId}: checked=${summary.checked} issues=${summary.issuesFound} repaired=${summary.repaired}`);
  return summary;
}

// ── Cleanup processor (Phase 7) ─────────────────────────
/**
 * Housekeeping: prune data the system accumulates but does not need forever.
 *   - health_snapshots  keep the latest HEALTH_SNAPSHOT_KEEP rows.
 *   - outbox_events     delete 'delivered' rows older than the retention window.
 *   - job_attempts      delete terminal (completed/dead) rows older than it.
 *   - reconciliation    delete runs older than the retention window (issues
 *                       cascade).
 *   - temp uploads      delegate to the reconciler's expired_temp_uploads check.
 * Every statement is idempotent; running the job twice deletes nothing extra.
 */
async function processCleanupJob() {
  const retentionMs = config.cleanupRetentionMs;
  const keepSnapshots = config.healthSnapshotKeep;
  const result = {};

  const snap = await query(
    `DELETE FROM health_snapshots
      WHERE id NOT IN (
        SELECT id FROM health_snapshots ORDER BY captured_at DESC LIMIT $1)`,
    [keepSnapshots]
  );
  result.health_snapshots_pruned = snap.rowCount || 0;

  const outbox = await query(
    `DELETE FROM outbox_events
      WHERE status = 'delivered'
        AND COALESCE(delivered_at, created_at) < NOW() - ($1 || ' milliseconds')::interval`,
    [String(retentionMs)]
  );
  result.outbox_events_pruned = outbox.rowCount || 0;

  const jobs = await query(
    `DELETE FROM job_attempts
      WHERE status IN ('completed', 'dead')
        AND COALESCE(finished_at, created_at) < NOW() - ($1 || ' milliseconds')::interval`,
    [String(retentionMs)]
  );
  result.job_attempts_pruned = jobs.rowCount || 0;

  const runs = await query(
    `DELETE FROM reconciliation_runs
      WHERE started_at < NOW() - ($1 || ' milliseconds')::interval`,
    [String(retentionMs)]
  );
  result.reconciliation_runs_pruned = runs.rowCount || 0;

  // Expired temp uploads — reuse the reconciler check so the logic lives once.
  try {
    const reconcileService = require('../services/reconcileService');
    const r = await reconcileService.runAllChecks({ categories: ['expired_temp_uploads'] });
    result.temp_uploads_deleted = r.repaired;
  } catch (err) {
    console.error('[cleanup] temp-upload sweep failed:', err.message);
  }

  console.log(`[cleanup] ${JSON.stringify(result)}`);
  return result;
}

// ── Boot / shutdown ─────────────────────────────────────
let outboxSchedulerStarted = false;
let lifecycleSchedulerStarted = false;
let controlPlaneSchedulerStarted = false;

/**
 * Start every worker and the outbox poller. Idempotent-ish: intended to be
 * called once after Redis connects.
 */
async function startWorkers() {
  // Live workers
  makeWorker(QUEUES.MEDIA, (job) => processMediaJob(job.data, job), {
    concurrency: config.concurrency,
    timeoutMs: MEDIA_TIMEOUT_MS,
  });

  makeWorker(QUEUES.WEBHOOK, async (job) => {
    const { webhook, event, data, projectId } = job.data;
    const result = await webhookService.deliverOnce(webhook, event, data, projectId, job.attemptsMade + 1);
    if (!result.delivered && !result.permanent) {
      // Transient — throw so BullMQ retries with the queue's backoff policy.
      throw new Error(result.error || `webhook delivery failed (status ${result.statusCode})`);
    }
    // Delivered, or a permanent failure we must not retry: complete the job.
    return result;
  }, { concurrency: config.concurrency });

  // Outbox: a Worker that runs the drain, fed by a repeatable ~2s job.
  makeWorker(QUEUES.OUTBOX, () => drainOutbox(), { concurrency: 1 });

  // Lifecycle scanner (Phase 5) — live. Archive/restore processors (Phase 6)
  // are now live; the ARCHIVE worker handles both the initial 'archive' job and
  // the delayed 'archive-finalize' grace step (same processor, idempotent).
  makeWorker(QUEUES.LIFECYCLE, (job) => processLifecycleJob(job), { concurrency: 1 });
  makeWorker(QUEUES.ARCHIVE, (job) => processArchiveJob(job.data), { concurrency: 1 });
  makeWorker(QUEUES.RESTORE, (job) => processRestoreJob(job.data), { concurrency: 1 });
  makeWorker(QUEUES.RECONCILIATION, (job) => processReconciliationJob(job), { concurrency: 1 });
  makeWorker(QUEUES.CLEANUP, () => processCleanupJob(), { concurrency: 1 });

  // Repeatable outbox drain. A fixed repeat jobId means only one schedule
  // exists no matter how many nodes call startWorkers.
  if (!outboxSchedulerStarted) {
    const outboxQueue = getQueue(QUEUES.OUTBOX);
    await outboxQueue.add('drain', {}, {
      repeat: { every: OUTBOX_POLL_MS },
      jobId: 'outbox-drain',
      removeOnComplete: true,
      removeOnFail: 1000,
    });
    outboxSchedulerStarted = true;
  }

  // Repeatable daily lifecycle scan. A fixed repeat jobId keeps a single
  // schedule no matter how many nodes call startWorkers.
  if (!lifecycleSchedulerStarted) {
    const lifecycleQueue = getQueue(QUEUES.LIFECYCLE);
    await lifecycleQueue.add('daily-scan', {}, {
      repeat: { pattern: LIFECYCLE_SCAN_CRON },
      jobId: 'lifecycle-daily-scan',
      removeOnComplete: true,
      removeOnFail: 100,
    });
    lifecycleSchedulerStarted = true;
  }

  // Repeatable self-healing schedules (Phase 7). Fixed repeat jobIds keep one
  // schedule per queue regardless of how many nodes boot.
  if (!controlPlaneSchedulerStarted) {
    const reconcileQueue = getQueue(QUEUES.RECONCILIATION);
    await reconcileQueue.add('reconcile.all', {}, {
      repeat: { pattern: config.reconcileScanCron },
      jobId: 'reconcile-all', removeOnComplete: true, removeOnFail: 100,
    });
    await reconcileQueue.add('health.snapshot', {}, {
      repeat: { every: config.healthSnapshotEveryMs },
      jobId: 'health-snapshot', removeOnComplete: true, removeOnFail: 100,
    });
    const cleanupQueue = getQueue(QUEUES.CLEANUP);
    await cleanupQueue.add('cleanup', {}, {
      repeat: { pattern: config.cleanupCron },
      jobId: 'cleanup-daily', removeOnComplete: true, removeOnFail: 100,
    });
    controlPlaneSchedulerStarted = true;
  }

  console.log('BullMQ workers started (media, webhook, outbox, lifecycle scan, archive, restore, reconciliation, cleanup)');
}

/** Close every worker. Queues are closed separately via queue.closeAll(). */
async function stopWorkers() {
  await Promise.all(workers.map((w) => w.close().catch(() => {})));
  workers.length = 0;
  outboxSchedulerStarted = false;
  lifecycleSchedulerStarted = false;
  controlPlaneSchedulerStarted = false;
}

module.exports = {
  startWorkers,
  stopWorkers,
  drainOutbox,
  routeOutboxEvent,
  markJobAttempt,
  processLifecycleJob,
  processReconciliationJob,
  processCleanupJob,
};
