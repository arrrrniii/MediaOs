const { Router } = require('express');
const { pool } = require('../db');
const { minioClient } = require('../minio');
const config = require('../config');

const router = Router();

router.get('/health', async (req, res) => {
  const services = {
    postgres: 'error',
    minio: 'error',
    redis: 'error',
    imgproxy: 'error',
  };

  // Check PostgreSQL
  try {
    await pool.query('SELECT 1');
    services.postgres = 'ok';
  } catch (_) { /* noop */ }

  // Check MinIO
  try {
    await minioClient.bucketExists(config.bucket);
    services.minio = 'ok';
  } catch (_) { /* noop */ }

  // Check Redis
  try {
    if (req.app.locals.redis) {
      await req.app.locals.redis.ping();
      services.redis = 'ok';
    } else {
      services.redis = 'not_configured';
    }
  } catch (_) { /* noop */ }

  // Check imgproxy
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`${config.imgproxyUrl}/health`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (resp.ok) services.imgproxy = 'ok';
  } catch (_) { /* noop */ }

  const queue = req.app.locals.queue
    ? { pending: req.app.locals.queue.pending, active: req.app.locals.queue.active }
    : { pending: 0, active: 0 };

  const allOk = services.postgres === 'ok' && services.minio === 'ok';
  const status = allOk ? 200 : 503;

  res.status(status).json({
    status: allOk ? 'ok' : 'degraded',
    version: '1.0.0',
    uptime: Math.floor(process.uptime()),
    queue,
    services,
  });
});

module.exports = router;
