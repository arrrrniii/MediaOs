// OpenTelemetry must initialize BEFORE any instrumented module is required, so
// its auto-instrumentations can patch http/express/pg/ioredis. It is a no-op
// unless OTEL is enabled (OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_ENABLED=true).
const tracing = require('./observability/tracing');
tracing.init();

const config = require('./config');
const logger = require('./utils/logger');
const metrics = require('./observability/metrics');
const alerts = require('./observability/alerts');
const { pool } = require('./db');
const { migrate } = require('../migrations/migrate');
const { seedAdmin } = require('./seed');
const { ensureBucket } = require('./minio');
const createApp = require('./app');

// Force-exit ceiling for graceful shutdown; a stuck drain must not hang forever.
const SHUTDOWN_TIMEOUT_MS = parseInt(process.env.SHUTDOWN_TIMEOUT_MS || '25000', 10);
// How often to refresh the queue-depth + storage gauges.
const METRICS_SAMPLE_MS = parseInt(process.env.METRICS_SAMPLE_MS || '30000', 10);

async function boot() {
  logger.info('boot.start', { env: config.nodeEnv, public_url: config.publicUrl });

  // 1. Validate config
  if (!config.pg.password) {
    logger.warn('boot.pg_password_empty');
  }

  // 2. Connect to PostgreSQL
  try {
    await pool.query('SELECT 1');
    logger.info('boot.pg_connected');
  } catch (err) {
    logger.error('boot.pg_failed', { error: err.message });
    process.exit(1);
  }

  // 3. Run migrations under the migration role (falls back to the runtime
  //    role when PG_MIGRATION_USER is unset), then close that pool. The
  //    runtime pool never needs DDL privileges.
  try {
    const { Pool } = require('pg');
    const migrationPool = new Pool({
      host: config.pg.host,
      port: config.pg.port,
      database: config.pg.database,
      user: config.pg.migrationUser,
      password: config.pg.migrationPassword,
      max: 2,
    });
    try {
      await migrate(migrationPool);
    } finally {
      await migrationPool.end();
    }
    logger.info('boot.migrations_applied');
  } catch (err) {
    logger.error('boot.migration_failed', { error: err.message });
    process.exit(1);
  }

  // 4. Seed first admin account if none exist
  try {
    await seedAdmin();
  } catch (err) {
    logger.error('boot.admin_seed_failed', { error: err.message });
  }

  // 5. Connect to MinIO, ensure bucket exists
  try {
    await ensureBucket();
    logger.info('boot.minio_ready', { bucket: config.bucket });
  } catch (err) {
    logger.error('boot.minio_failed', { error: err.message });
    process.exit(1);
  }

  // 6. Connect to Redis (optional, graceful fallback)
  let redis = null;
  try {
    const Redis = require('ioredis');
    redis = new Redis(config.redis.url, {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
    });
    await redis.connect();
    logger.info('boot.redis_connected');
  } catch (err) {
    logger.warn('boot.redis_unavailable', { error: err.message });
    redis = null;
  }

  // 7. Wire Redis into usage tracking + per-file access tracking, and start
  //    both flush intervals (project-level usage, per-asset lifecycle access).
  if (redis) {
    const { setRedis } = require('./services/usageService');
    const { startFlushInterval } = require('./services/usageFlushService');
    const { setRedis: setAccessRedis } = require('./services/accessTrackingService');
    const { startAccessFlush } = require('./services/lifecycleFlushService');
    const { setRedis: setReconcileRedis } = require('./services/reconcileService');
    setRedis(redis);
    startFlushInterval(redis);
    setAccessRedis(redis);
    startAccessFlush(redis);
    setReconcileRedis(redis);
  }

  // 8. Start durable BullMQ workers + the outbox poller.
  const queueModule = require('./queue');
  if (redis) {
    try {
      const { startWorkers } = require('./queue/workers');
      await startWorkers();
      queueModule.setEnabled(true);
      logger.info('boot.queue_mode', { mode: 'durable' });
    } catch (err) {
      queueModule.setEnabled(false);
      logger.error('boot.workers_failed', { error: err.message, mode: 'in-memory' });
    }
  } else {
    queueModule.setEnabled(false);
    logger.warn('boot.queue_mode', { mode: 'in-memory', reason: 'redis_unavailable' });
  }

  // 9. Create Express app
  const app = createApp();
  app.locals.redis = redis;

  // 10. Start listening
  const server = app.listen(config.port, () => {
    logger.info('boot.listening', { port: config.port, env: config.nodeEnv });
  });

  // 10b. Observability timers: alert monitor + metric sampler. Both unref'd so
  //      they never keep the process alive.
  alerts.startAlertMonitor({ redis, pool });
  const metricsTimer = startMetricsSampler();

  // 11. Graceful shutdown. Order: stop timers, stop accepting new HTTP
  //     connections (wait for in-flight), drain BullMQ workers, flush usage +
  //     access buffers, close Redis + PG, flush traces. A hard timer
  //     force-exits if any step hangs; a second signal exits immediately.
  const { createGracefulShutdown } = require('./gracefulShutdown');
  const shutdown = createGracefulShutdown({
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    logger,
    steps: [
      { name: 'timers', run: async () => {
        alerts.stopAlertMonitor();
        if (metricsTimer) clearInterval(metricsTimer);
      } },
      { name: 'http', run: () => new Promise((resolve) => server.close(resolve)) },
      { name: 'workers', run: async () => {
        const { stopWorkers } = require('./queue/workers');
        await stopWorkers();
        await queueModule.closeAll();
      } },
      { name: 'usage', run: async () => {
        const { stopFlushInterval, flush } = require('./services/usageFlushService');
        stopFlushInterval();
        if (redis) await flush(redis);
      } },
      { name: 'access', run: async () => {
        const { stopAccessFlush, flushAccess } = require('./services/lifecycleFlushService');
        stopAccessFlush();
        if (redis) await flushAccess(redis);
      } },
      { name: 'connections', run: async () => {
        try { if (redis) await redis.quit(); } catch { /* already closing */ }
        await pool.end();
      } },
      { name: 'tracing', run: () => tracing.shutdown() },
    ],
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

/**
 * Periodically refresh the queue-depth + storage/files gauges. Queue depths
 * come from BullMQ getJobCounts (via alerts.queueDepths, which sets the gauge);
 * storage numbers from two cheap aggregate queries. Unref'd so it never holds
 * the process open. Storage sampling is best-effort and skipped on error.
 */
function startMetricsSampler() {
  const sample = async () => {
    try { await alerts.queueDepths(); } catch { /* redis outage covered elsewhere */ }
    try {
      const { rows } = await pool.query(
        `SELECT (SELECT COUNT(*) FROM files WHERE deleted_at IS NULL) AS files,
                (SELECT COALESCE(SUM(size), 0) FROM file_objects) AS bytes`
      );
      if (rows[0]) metrics.setStorage(rows[0].bytes, rows[0].files);
    } catch { /* leave last gauge value in place */ }
  };
  sample();
  const timer = setInterval(sample, METRICS_SAMPLE_MS);
  if (timer.unref) timer.unref();
  return timer;
}

boot().catch((err) => {
  logger.error('boot.fatal', { error: err.message, stack: err.stack });
  process.exit(1);
});
