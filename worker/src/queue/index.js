/**
 * BullMQ queue registry + enqueue helper.
 *
 * Queues are created lazily (first getQueue) so merely requiring this module
 * never opens a Redis connection — important for unit tests that run without
 * Redis. Every enqueue also writes a `job_attempts` ledger row so the job is
 * visible to the dashboard and retryable from Postgres even though BullMQ
 * holds the live state in Redis.
 */

const { query } = require('../db');
const { createConnection } = require('./connection');

const QUEUES = {
  MEDIA: 'media-processing',
  WEBHOOK: 'webhook-delivery',
  LIFECYCLE: 'lifecycle',
  ARCHIVE: 'archive',
  RESTORE: 'restore',
  RECONCILIATION: 'reconciliation',
  CLEANUP: 'cleanup',
  OUTBOX: 'outbox',
};

const QUEUE_NAMES = new Set(Object.values(QUEUES));

// Applied to every job unless overridden. removeOnFail:false keeps failed
// jobs in Redis so they (and their DLQ 'dead' marker) stay inspectable.
const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { age: 86400, count: 1000 },
  removeOnFail: false,
};

// name → BullMQ Queue. Lazily populated; shares one connection.
const queues = new Map();
let sharedConnection = null;

// Whether durable (BullMQ/Redis) processing is active. Flipped on by
// startWorkers once Redis is confirmed; callers use it to decide between the
// durable path and the single-node in-memory fallback.
let enabled = false;
function isEnabled() { return enabled; }
function setEnabled(v) { enabled = !!v; }

function getConnection() {
  if (!sharedConnection) sharedConnection = createConnection();
  return sharedConnection;
}

/**
 * Get (creating on first use) the BullMQ Queue for a known queue name.
 * Throws on an unknown name so typos surface immediately.
 */
function getQueue(name) {
  if (!QUEUE_NAMES.has(name)) {
    throw new Error(`Unknown queue: ${name}`);
  }
  let q = queues.get(name);
  if (!q) {
    const { Queue } = require('bullmq');
    q = new Queue(name, {
      connection: getConnection(),
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
    queues.set(name, q);
  }
  return q;
}

/**
 * Record (or reset, on retry re-enqueue) the DB-visible ledger row for a job.
 * Upsert keyed on (queue, job_id): a re-added job resets to 'active' rather
 * than duplicating. Best-effort — a ledger failure must not lose the job.
 */
async function recordJobActive(queueName, jobId, fileId) {
  try {
    await query(
      `INSERT INTO job_attempts (queue, job_id, file_id, status, attempt, error, finished_at)
       VALUES ($1, $2, $3, 'active', 1, NULL, NULL)
       ON CONFLICT (queue, job_id) DO UPDATE
         SET status = 'active', attempt = 1, error = NULL, finished_at = NULL,
             file_id = COALESCE(EXCLUDED.file_id, job_attempts.file_id)`,
      [queueName, jobId, fileId || null]
    );
  } catch (err) {
    console.error(`Failed to record job_attempts for ${queueName}/${jobId}:`, err.message);
  }
}

/**
 * Enqueue a durable job and write its ledger row.
 * @param {string} name    queue name (QUEUES.*)
 * @param {string} jobName BullMQ job name
 * @param {object} data    job payload; data.fileId (if present) links the ledger
 * @param {object} [opts]  BullMQ job opts; opts.jobId gives idempotency
 * @returns the added BullMQ Job
 */
async function addJob(name, jobName, data = {}, opts = {}) {
  const queue = getQueue(name);
  const job = await queue.add(jobName, data, { ...opts });
  await recordJobActive(name, job.id, data.fileId);
  return job;
}

/** Close every created queue and the shared connection (graceful shutdown). */
async function closeAll() {
  const closes = [];
  for (const q of queues.values()) closes.push(q.close().catch(() => {}));
  await Promise.all(closes);
  queues.clear();
  if (sharedConnection) {
    try { await sharedConnection.quit(); } catch { /* already closing */ }
    sharedConnection = null;
  }
}

module.exports = {
  QUEUES,
  DEFAULT_JOB_OPTIONS,
  getConnection,
  getQueue,
  addJob,
  recordJobActive,
  closeAll,
  isEnabled,
  setEnabled,
};
