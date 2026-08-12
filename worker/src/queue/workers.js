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
const webhookService = require('../services/webhookService');

const MEDIA_TIMEOUT_MS = parseInt(process.env.MEDIA_JOB_TIMEOUT_MS || '900000', 10); // 15 min
const OUTBOX_POLL_MS = parseInt(process.env.OUTBOX_POLL_MS || '2000', 10);
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

// ── Stub processors (filled by later phases) ────────────
function stubProcessor(name, phase) {
  return async (job) => {
    // TODO(phase-${phase}): implement ${name}. For now this is a durable
    // no-op so the queue exists and jobs are accepted without error.
    console.log(`[${name}] stub processed job ${job.id} (see Phase ${phase})`);
    return { stub: true };
  };
}

// ── Boot / shutdown ─────────────────────────────────────
let outboxSchedulerStarted = false;

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

  // Scaffolded workers for later phases.
  makeWorker(QUEUES.LIFECYCLE, stubProcessor('lifecycle', 5), { concurrency: 1 });
  makeWorker(QUEUES.ARCHIVE, stubProcessor('archive', 6), { concurrency: 1 });
  makeWorker(QUEUES.RESTORE, stubProcessor('restore', 6), { concurrency: 1 });
  makeWorker(QUEUES.RECONCILIATION, stubProcessor('reconciliation', 7), { concurrency: 1 });
  makeWorker(QUEUES.CLEANUP, stubProcessor('cleanup', 5), { concurrency: 1 });

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

  console.log('BullMQ workers started (media, webhook, outbox + lifecycle stubs)');
}

/** Close every worker. Queues are closed separately via queue.closeAll(). */
async function stopWorkers() {
  await Promise.all(workers.map((w) => w.close().catch(() => {})));
  workers.length = 0;
  outboxSchedulerStarted = false;
}

module.exports = {
  startWorkers,
  stopWorkers,
  drainOutbox,
  routeOutboxEvent,
  markJobAttempt,
};
