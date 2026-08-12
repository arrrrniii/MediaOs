/**
 * Alert signals.
 *
 * evaluateAlerts() runs a set of cheap threshold checks and, for each breach,
 * logs a structured warn/error line and increments alerts_total{type,severity}
 * so an external alertmanager or log pipeline can trigger on either surface. It
 * returns a snapshot the health endpoint folds in, so /health always shows the
 * same numbers the alerter evaluated.
 *
 * startAlertMonitor() runs the evaluation on an unref'd timer (ALERT_INTERVAL_MS,
 * default 60s) so it never keeps the process alive on its own.
 *
 * Thresholds (env / default):
 *   QUEUE_DEPTH_ALERT    1000   pending+active jobs across all queues
 *   DISK_FREE_ALERT_PCT  10     warn when the work dir has less free space
 *   DB pool saturation          warn when connections are queued (waitingCount>0)
 *   Redis down                  error when a ping fails / not reachable
 */

const os = require('os');
const fs = require('fs');
const logger = require('../utils/logger');
const metrics = require('./metrics');

const QUEUE_DEPTH_ALERT = parseInt(process.env.QUEUE_DEPTH_ALERT || '1000', 10);
const DISK_FREE_ALERT_PCT = parseFloat(process.env.DISK_FREE_ALERT_PCT || '10');
const ALERT_INTERVAL_MS = parseInt(process.env.ALERT_INTERVAL_MS || '60000', 10);
const WORK_DIR = process.env.WORK_DIR || os.tmpdir();

let timer = null;

function fire(alerts, type, severity, message, fields) {
  metrics.recordAlert(type, severity);
  const log = severity === 'critical' ? logger.error : logger.warn;
  log.call(logger, `alert.${type}`, { alert: type, severity, ...fields });
  alerts.push({ type, severity, message, ...fields });
}

/** Free-space check on the work dir. Tolerates statfs being unavailable. */
async function checkDisk() {
  if (typeof fs.statfs !== 'function') return null;
  try {
    const st = await new Promise((resolve, reject) => {
      fs.statfs(WORK_DIR, (err, s) => (err ? reject(err) : resolve(s)));
    });
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    const freePct = total > 0 ? (free / total) * 100 : 100;
    return { path: WORK_DIR, free_bytes: free, total_bytes: total, free_pct: Math.round(freePct * 100) / 100 };
  } catch {
    return null;
  }
}

/** Sum pending+active across every known queue (durable mode only). */
async function queueDepths() {
  const queueModule = require('../queue');
  const out = { total: 0, byQueue: {} };
  if (!queueModule.isEnabled || !queueModule.isEnabled()) return out;
  for (const name of Object.values(queueModule.QUEUES)) {
    try {
      const q = queueModule.getQueue(name);
      const counts = await q.getJobCounts('waiting', 'active', 'delayed');
      const depth = (counts.waiting || 0) + (counts.active || 0) + (counts.delayed || 0);
      out.byQueue[name] = depth;
      out.total += depth;
      metrics.setQueueDepth(name, depth);
    } catch {
      /* queue not reachable — skip; redis check covers the outage */
    }
  }
  return out;
}

/**
 * Evaluate every alert condition once. Dependencies are injectable for tests.
 * @param {object} [deps]
 * @param {object} [deps.redis]  redis client (for the reachability check)
 * @param {object} [deps.pool]   pg pool (for saturation)
 * @param {Function} [deps.getQueueDepths] override queue sampling
 * @param {Function} [deps.getDisk] override disk sampling
 * @returns {Promise<object>} snapshot { alerts, queue, db_pool, redis, disk }
 */
async function evaluateAlerts(deps = {}) {
  const redis = deps.redis;
  const pool = deps.pool || require('../db').pool;
  const getQueueDepths = deps.getQueueDepths || queueDepths;
  const getDisk = deps.getDisk || checkDisk;

  const alerts = [];

  // Queue depth
  let queue = { total: 0, byQueue: {} };
  try {
    queue = await getQueueDepths();
  } catch { /* ignore */ }
  if (queue.total > QUEUE_DEPTH_ALERT) {
    fire(alerts, 'queue_depth', 'warning',
      `queue depth ${queue.total} over ${QUEUE_DEPTH_ALERT}`,
      { depth: queue.total, threshold: QUEUE_DEPTH_ALERT });
  }

  // DB pool saturation — connections queued means the pool is exhausted.
  const dbPool = {
    total: pool && pool.totalCount,
    idle: pool && pool.idleCount,
    waiting: pool && pool.waitingCount,
  };
  if (pool && pool.waitingCount > 0) {
    fire(alerts, 'db_pool_saturation', 'warning',
      `${pool.waitingCount} connection request(s) queued`,
      { waiting: pool.waitingCount, total: pool.totalCount, idle: pool.idleCount });
  }

  // Redis reachability
  let redisState = 'not_configured';
  if (redis) {
    try {
      await redis.ping();
      redisState = 'ok';
    } catch (err) {
      redisState = 'down';
      fire(alerts, 'redis_down', 'critical', 'redis ping failed', { error: err.message });
    }
  }

  // Disk capacity
  const disk = await getDisk();
  if (disk && disk.free_pct < DISK_FREE_ALERT_PCT) {
    fire(alerts, 'disk_low', 'warning',
      `disk free ${disk.free_pct}% under ${DISK_FREE_ALERT_PCT}%`,
      { free_pct: disk.free_pct, path: disk.path });
  }

  return { alerts, queue, db_pool: dbPool, redis: redisState, disk };
}

function startAlertMonitor(deps = {}) {
  if (timer) return timer;
  timer = setInterval(() => {
    evaluateAlerts(deps).catch((err) => logger.error('alert.evaluate_failed', { error: err.message }));
  }, ALERT_INTERVAL_MS);
  if (timer.unref) timer.unref();
  logger.info('alert.monitor_started', { interval_ms: ALERT_INTERVAL_MS });
  return timer;
}

function stopAlertMonitor() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  evaluateAlerts,
  startAlertMonitor,
  stopAlertMonitor,
  checkDisk,
  queueDepths,
  thresholds: { QUEUE_DEPTH_ALERT, DISK_FREE_ALERT_PCT, ALERT_INTERVAL_MS, WORK_DIR },
};
