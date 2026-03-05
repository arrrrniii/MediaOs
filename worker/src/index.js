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

  // 7. Create Express app
  const app = createApp();
  app.locals.redis = redis;

  // 8. Start listening
  app.listen(config.port, () => {
    console.log(`MediaOS worker listening on port ${config.port}`);
    console.log(`Environment: ${config.nodeEnv}`);
    console.log(`Public URL: ${config.publicUrl}`);
  });
}

boot().catch((err) => {
  console.error('Fatal boot error:', err);
  process.exit(1);
});
