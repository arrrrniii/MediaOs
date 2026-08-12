const { Router } = require('express');
const { pool } = require('../db');
const { minioClient } = require('../minio');
const config = require('../config');
const alerts = require('../observability/alerts');

const router = Router();

async function checkPostgres() {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch { return false; }
}

async function checkMigrations() {
  try {
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM _migrations');
    return (rows[0] && rows[0].n) > 0;
  } catch { return false; }
}

async function checkMinio() {
  try {
    await minioClient.bucketExists(config.bucket);
    return true;
  } catch { return false; }
}

async function checkRedis(redis) {
  if (!redis) return 'not_configured';
  try {
    await redis.ping();
    return 'ok';
  } catch { return 'error'; }
}

async function checkImgproxy() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`${config.imgproxyUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    return resp.ok;
  } catch { return false; }
}

// ── Liveness: the process is up. Always 200 unless the event loop is dead. ──
router.get('/health/live', (_req, res) => {
  res.status(200).json({ status: 'alive', uptime: Math.floor(process.uptime()) });
});

// ── Readiness: can this instance serve traffic? PG + MinIO + Redis reachable
//    and migrations applied. 503 when any hard dependency is down. ──
router.get('/health/ready', async (req, res) => {
  const [postgres, migrations, minio] = await Promise.all([
    checkPostgres(), checkMigrations(), checkMinio(),
  ]);
  const redis = await checkRedis(req.app.locals.redis);

  const checks = {
    postgres,
    migrations_applied: migrations,
    minio,
    redis: redis === 'ok' ? true : (redis === 'not_configured' ? 'not_configured' : false),
  };

  // Redis is optional (in-memory fallback), so it does not gate readiness;
  // PG, migrations, and object storage do.
  const ready = postgres && migrations && minio;
  res.status(ready ? 200 : 503).json({
    status: ready ? 'ready' : 'not_ready',
    checks,
  });
});

// ── Full health: backward-compatible shape (status/version/uptime/queue/
//    services) plus the alert snapshot folded in. ──
router.get('/health', async (req, res) => {
  const services = { postgres: 'error', minio: 'error', redis: 'error', imgproxy: 'error' };

  const [pg, minioOk, redis, imgproxy] = await Promise.all([
    checkPostgres(),
    checkMinio(),
    checkRedis(req.app.locals.redis),
    checkImgproxy(),
  ]);
  services.postgres = pg ? 'ok' : 'error';
  services.minio = minioOk ? 'ok' : 'error';
  services.redis = redis;
  services.imgproxy = imgproxy ? 'ok' : 'error';

  const queue = req.app.locals.queue
    ? { pending: req.app.locals.queue.pending, active: req.app.locals.queue.active }
    : { pending: 0, active: 0 };

  // Fold in the alert snapshot (queue depth, db pool, disk). Best-effort — a
  // sampling failure must not fail the health probe itself.
  let signals = null;
  try {
    signals = await alerts.evaluateAlerts({ redis: req.app.locals.redis });
  } catch { /* leave signals null */ }

  const allOk = services.postgres === 'ok' && services.minio === 'ok';
  const status = allOk ? 200 : 503;

  res.status(status).json({
    status: allOk ? 'ok' : 'degraded',
    version: require('../../package.json').version,
    uptime: Math.floor(process.uptime()),
    queue,
    services,
    signals: signals ? {
      alerts: signals.alerts,
      queue_depth: signals.queue,
      db_pool: signals.db_pool,
      disk: signals.disk,
    } : undefined,
  });
});

module.exports = router;
