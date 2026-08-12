const config = require('./config');
const { pool } = require('./db');
const { migrate } = require('../migrations/migrate');
const { seedAdmin } = require('./seed');
const { ensureBucket } = require('./minio');
const createApp = require('./app');

async function boot() {
  console.log('MediaOS worker starting...');

  // 1. Validate config
  if (!config.pg.password) {
    console.warn('Warning: PG_PASSWORD is empty');
  }

  // 2. Connect to PostgreSQL
  try {
    await pool.query('SELECT 1');
    console.log('PostgreSQL connected');
  } catch (err) {
    console.error('PostgreSQL connection failed:', err.message);
    process.exit(1);
  }

  // 3. Run migrations
  try {
    await migrate(pool);
  } catch (err) {
    console.error('Migration failed:', err.message);
    process.exit(1);
  }

  // 4. Seed first admin account if none exist
  try {
    await seedAdmin();
  } catch (err) {
    console.error('Admin seed failed:', err.message);
  }

  // 5. Connect to MinIO, ensure bucket exists
  try {
    await ensureBucket();
    console.log('MinIO connected, bucket ready');
  } catch (err) {
    console.error('MinIO connection failed:', err.message);
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
    console.log('Redis connected');
  } catch (err) {
    console.warn('Redis not available, falling back to in-memory:', err.message);
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

  // 8. Start durable BullMQ workers + the outbox poller. With Redis present
  //    this is the default path: media processing and webhooks survive a
  //    restart. Without Redis we log clearly and fall back to the in-memory
  //    queue (single-node, no durability) for media.
  const queueModule = require('./queue');
  if (redis) {
    try {
      const { startWorkers } = require('./queue/workers');
      await startWorkers();
      queueModule.setEnabled(true);
      console.log('Durable queue mode: BullMQ workers + outbox poller running');
    } catch (err) {
      queueModule.setEnabled(false);
      console.error('Failed to start BullMQ workers, falling back to in-memory queue:', err.message);
    }
  } else {
    queueModule.setEnabled(false);
    console.warn('Redis unavailable: media processing runs in-memory (no durability guarantees)');
  }

  // 9. Create Express app
  const app = createApp();
  app.locals.redis = redis;

  // 10. Start listening
  const server = app.listen(config.port, () => {
    console.log(`MediaOS worker listening on port ${config.port}`);
    console.log(`Environment: ${config.nodeEnv}`);
    console.log(`Public URL: ${config.publicUrl}`);
  });

  // 11. Graceful shutdown: stop accepting new work, drain the queue workers,
  //     flush buffered usage counters, then close the DB pool. (Fuller
  //     graceful-shutdown lands in Phase 10; this covers the Phase-4
  //     queue-drain + usage-flush needed so nothing in flight is lost.)
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down gracefully...`);

    // Stop taking new HTTP requests.
    await new Promise((resolve) => server.close(resolve));

    // Drain BullMQ workers and close queues so in-flight jobs finish/return
    // to the queue rather than being killed mid-write.
    try {
      const { stopWorkers } = require('./queue/workers');
      await stopWorkers();
      await queueModule.closeAll();
    } catch (err) {
      console.error('Error stopping queue workers:', err.message);
    }

    // Flush any buffered usage counters from Redis to Postgres.
    try {
      const { stopFlushInterval, flush } = require('./services/usageFlushService');
      stopFlushInterval();
      if (redis) await flush(redis);
    } catch (err) {
      console.error('Error flushing usage on shutdown:', err.message);
    }

    // Flush buffered per-file access ticks (lifecycle) from Redis to Postgres.
    try {
      const { stopAccessFlush, flushAccess } = require('./services/lifecycleFlushService');
      stopAccessFlush();
      if (redis) await flushAccess(redis);
    } catch (err) {
      console.error('Error flushing access on shutdown:', err.message);
    }

    // Close Redis + PG.
    try { if (redis) await redis.quit(); } catch { /* already closing */ }
    try { await pool.end(); } catch (err) { console.error('Error closing PG pool:', err.message); }

    console.log('Shutdown complete');
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

boot().catch((err) => {
  console.error('Fatal boot error:', err);
  process.exit(1);
});
