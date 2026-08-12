module.exports = {
  port: parseInt(process.env.PORT || '3000'),
  nodeEnv: process.env.NODE_ENV || 'development',

  pg: {
    host: process.env.PG_HOST || 'localhost',
    port: parseInt(process.env.PG_PORT || '5432'),
    database: process.env.PG_DATABASE || 'mediaos',
    user: process.env.PG_USER || 'mediaos',
    password: process.env.PG_PASSWORD || '',
  },

  minio: {
    endPoint: process.env.MINIO_ENDPOINT || 'localhost',
    port: parseInt(process.env.MINIO_PORT || '9000'),
    useSSL: process.env.MINIO_USE_SSL === 'true',
    accessKey: process.env.MINIO_ACCESS_KEY || 'mvadmin',
    secretKey: process.env.MINIO_SECRET_KEY || '',
  },
  bucket: process.env.MINIO_BUCKET || 'mediaos',

  redis: {
    url: process.env.REDIS_URL || 'redis://localhost:6379',
  },

  imgproxyUrl: process.env.IMGPROXY_URL || 'http://localhost:8080',
  publicUrl: (process.env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),
  masterKey: process.env.MASTER_KEY || '',

  // 32-byte key (hex or base64) encrypting remote storage-backend credentials
  // in storage_backends.configuration_encrypted. Required only when a remote
  // (cold) backend is configured; the local MinIO default needs no key.
  storageEncryptionKey: process.env.STORAGE_ENCRYPTION_KEY || '',

  // Grace window between verifying a cold copy and deleting the hot original.
  // The archiver keeps the hot copy this long so a mistaken archive is
  // trivially reversible; a delayed finalize step deletes it afterwards.
  archiveHotGraceMs: parseInt(process.env.ARCHIVE_HOT_GRACE_MS || String(7 * 24 * 60 * 60 * 1000), 10),

  // Shared secret proving a request came from the dashboard server, not a browser.
  // Required by /api/v1/auth/login and every account-scoped route.
  internalApiSecret: process.env.INTERNAL_API_SECRET || '',

  // Initial admin (created on first boot if no accounts exist)
  adminName: process.env.ADMIN_NAME || 'Admin',
  adminEmail: process.env.ADMIN_EMAIL || '',
  adminPassword: process.env.ADMIN_PASSWORD || '',

  // Processing
  webpQuality: parseInt(process.env.WEBP_QUALITY || '80'),
  maxWidth: parseInt(process.env.MAX_WIDTH || '1600'),
  maxHeight: parseInt(process.env.MAX_HEIGHT || '1600'),
  videoCrf: process.env.VIDEO_CRF || '20',
  videoMaxHeight: parseInt(process.env.VIDEO_MAX_HEIGHT || '1080'),
  maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '104857600'),
  concurrency: parseInt(process.env.CONCURRENCY || '3'),

  // Usage flush (Redis → Postgres)
  usageFlushIntervalMs: parseInt(process.env.USAGE_FLUSH_INTERVAL_MS || '10000'),
  metadataCacheTtl: parseInt(process.env.METADATA_CACHE_TTL_SECONDS || '300'),

  // ── Self-healing reconciler (Phase 7) ─────────────────
  // A file stuck in a transient state (processing/archiving/restoring) with no
  // in-flight job for longer than this is considered stuck and re-driven.
  reconcileStuckMs: parseInt(process.env.RECONCILE_STUCK_MS || String(30 * 60 * 1000), 10),
  // An orphan object (in storage, no file_objects row) is only deleted once it
  // is older than this — a just-uploaded object whose DB row is mid-commit is
  // never mistaken for an orphan.
  orphanMinAgeMs: parseInt(process.env.ORPHAN_MIN_AGE_MS || String(24 * 60 * 60 * 1000), 10),
  // Leftover `_processing_*` temp uploads older than this are deleted.
  tempUploadTtlMs: parseInt(process.env.TEMP_UPLOAD_TTL_MS || String(24 * 60 * 60 * 1000), 10),
  // Per-check batch ceiling so a single reconcile pass stays bounded/cheap.
  reconcileBatch: parseInt(process.env.RECONCILE_BATCH || '500', 10),
  // How many objects the corrupt-checksum check re-hashes per pass.
  reconcileCorruptSample: parseInt(process.env.RECONCILE_CORRUPT_SAMPLE || '25', 10),
  // Retain at most this many health snapshots (cleanup prunes the rest).
  healthSnapshotKeep: parseInt(process.env.HEALTH_SNAPSHOT_KEEP || '500', 10),
  // Delivered outbox events + completed job_attempts older than this are pruned.
  cleanupRetentionMs: parseInt(process.env.CLEANUP_RETENTION_MS || String(30 * 24 * 60 * 60 * 1000), 10),
  // Repeatable schedules (cron patterns / intervals) for the control plane.
  reconcileScanCron: process.env.RECONCILE_SCAN_CRON || '0 */6 * * *',   // every 6h
  healthSnapshotEveryMs: parseInt(process.env.HEALTH_SNAPSHOT_EVERY_MS || String(5 * 60 * 1000), 10),
  cleanupCron: process.env.CLEANUP_CRON || '30 4 * * *',                 // daily 04:30

  // Rate limits (requests per minute)
  apiRateLimit: parseInt(process.env.API_RATE_LIMIT || '100'),      // per API key, fallback when api_keys.rate_limit is null
  loginRateLimit: parseInt(process.env.LOGIN_RATE_LIMIT || '10'),   // per IP and per email
  adminRateLimit: parseInt(process.env.ADMIN_RATE_LIMIT || '120'),  // per IP, MASTER_KEY routes
  sessionRateLimit: parseInt(process.env.SESSION_RATE_LIMIT || '300'), // per IP, account-scoped routes
  setupRateLimit: parseInt(process.env.SETUP_RATE_LIMIT || '5'),    // per IP, first-boot setup
};
