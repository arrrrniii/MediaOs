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

  // Initial admin (created on first boot if no accounts exist)
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
};
