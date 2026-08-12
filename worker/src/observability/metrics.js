/**
 * Prometheus metrics registry for the worker.
 *
 * Owns a private Registry (never the prom-client global default) so the module
 * can be required/reset in tests without cross-registration errors. Default
 * Node/process metrics plus the custom series below are exposed at GET /metrics.
 *
 * Increment points:
 *   http_requests_total / http_request_duration_seconds — requestId middleware
 *     (observeHttp) on every response.
 *   uploads_total            — fileService.uploadFile (recordUpload).
 *   media_jobs_total / job_duration_seconds — queue/workers makeWorker events
 *     (recordJob) on job completed/failed.
 *   queue_depth              — periodic sampler (setQueueDepth) via BullMQ
 *     getJobCounts; 0 when durable queue is disabled.
 *   storage_bytes / files_total — periodic sampler (setStorage) from health
 *     numbers.
 *   webhook_deliveries_total — webhookService.logDelivery (recordWebhook).
 *   reconcile_issues_total   — reconcileService.runAllChecks (recordReconcileIssues).
 *   alerts_total             — observability/alerts (recordAlert).
 *   restore_tests_total / restore_test_last_success_timestamp_seconds —
 *     observability/restoreSelftest (recordRestoreTest).
 */

const client = require('prom-client');

const register = new client.Registry();
register.setDefaultLabels({ service: 'mediaos-worker' });
client.collectDefaultMetrics({ register });

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total HTTP requests handled.',
  labelNames: ['method', 'route', 'status'],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds.',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [register],
});

const uploadsTotal = new client.Counter({
  name: 'uploads_total',
  help: 'Uploads accepted, by asset type and result.',
  labelNames: ['type', 'result'],
  registers: [register],
});

const mediaJobsTotal = new client.Counter({
  name: 'media_jobs_total',
  help: 'Queue jobs processed, by queue and result.',
  labelNames: ['queue', 'result'],
  registers: [register],
});

const jobDuration = new client.Histogram({
  name: 'job_duration_seconds',
  help: 'Queue job processing duration in seconds.',
  labelNames: ['queue', 'result'],
  buckets: [0.05, 0.1, 0.5, 1, 5, 15, 60, 300, 900, 1800],
  registers: [register],
});

const queueDepth = new client.Gauge({
  name: 'queue_depth',
  help: 'Pending + active jobs per queue.',
  labelNames: ['queue'],
  registers: [register],
});

const storageBytes = new client.Gauge({
  name: 'storage_bytes',
  help: 'Total bytes stored across physical objects.',
  registers: [register],
});

const filesTotal = new client.Gauge({
  name: 'files_total',
  help: 'Total logical files (not soft-deleted).',
  registers: [register],
});

const webhookDeliveriesTotal = new client.Counter({
  name: 'webhook_deliveries_total',
  help: 'Webhook delivery attempts, by result.',
  labelNames: ['result'],
  registers: [register],
});

const reconcileIssuesTotal = new client.Counter({
  name: 'reconcile_issues_total',
  help: 'Reconciliation issues found, by category.',
  labelNames: ['category'],
  registers: [register],
});

const alertsTotal = new client.Counter({
  name: 'alerts_total',
  help: 'Alert conditions fired, by type and severity.',
  labelNames: ['type', 'severity'],
  registers: [register],
});

const restoreTestsTotal = new client.Counter({
  name: 'restore_tests_total',
  help: 'Scheduled restore self-tests, by result.',
  labelNames: ['result'],
  registers: [register],
});

const restoreTestLastSuccess = new client.Gauge({
  name: 'restore_test_last_success_timestamp_seconds',
  help: 'Unix timestamp of the last successful restore self-test.',
  registers: [register],
});

// Bound route-label cardinality: prefer the matched Express route pattern;
// otherwise bucket to the first two path segments with ids masked.
function routeLabel(req) {
  if (req.route && req.route.path) {
    const base = req.baseUrl || '';
    const p = typeof req.route.path === 'string' ? req.route.path : '';
    return (base + p) || 'unknown';
  }
  const path = (req.path || req.originalUrl || '/').split('?')[0];
  const segs = path.split('/').filter(Boolean).slice(0, 2)
    .map((s) => (/^[0-9a-f-]{8,}$/i.test(s) || /^\d+$/.test(s) ? ':id' : s));
  return '/' + segs.join('/');
}

function observeHttp(req, res, durationMs) {
  const labels = { method: req.method, route: routeLabel(req), status: String(res.statusCode) };
  httpRequestsTotal.inc(labels);
  httpRequestDuration.observe(labels, durationMs / 1000);
}

function recordUpload(type, result) {
  uploadsTotal.inc({ type: type || 'unknown', result: result || 'ok' });
}

function recordJob(queue, result, durationSec) {
  mediaJobsTotal.inc({ queue, result });
  if (typeof durationSec === 'number' && isFinite(durationSec) && durationSec >= 0) {
    jobDuration.observe({ queue, result }, durationSec);
  }
}

function setQueueDepth(queue, depth) {
  queueDepth.set({ queue }, Number(depth) || 0);
}

function setStorage(bytes, files) {
  if (bytes != null) storageBytes.set(Number(bytes) || 0);
  if (files != null) filesTotal.set(Number(files) || 0);
}

function recordWebhook(result) {
  webhookDeliveriesTotal.inc({ result });
}

function recordReconcileIssues(category, count) {
  const n = Number(count) || 0;
  if (n > 0) reconcileIssuesTotal.inc({ category }, n);
}

function recordAlert(type, severity) {
  alertsTotal.inc({ type, severity: severity || 'warning' });
}

function recordRestoreTest(result) {
  restoreTestsTotal.inc({ result });
  if (result === 'pass') restoreTestLastSuccess.set(Math.floor(Date.now() / 1000));
}

module.exports = {
  client,
  register,
  routeLabel,
  observeHttp,
  recordUpload,
  recordJob,
  setQueueDepth,
  setStorage,
  recordWebhook,
  recordReconcileIssues,
  recordAlert,
  recordRestoreTest,
  // exposed for tests
  _metrics: {
    httpRequestsTotal, httpRequestDuration, uploadsTotal, mediaJobsTotal,
    jobDuration, queueDepth, storageBytes, filesTotal, webhookDeliveriesTotal,
    reconcileIssuesTotal, alertsTotal, restoreTestsTotal, restoreTestLastSuccess,
  },
};
