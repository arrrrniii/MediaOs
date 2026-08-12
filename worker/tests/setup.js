/**
 * Test setup — mocks for db, minio, and shared test helpers.
 *
 * Usage in tests:
 *   const { createTestApp, mockDb, mockMinio, MASTER_KEY } = require('./setup');
 */

// Jest requires mock variables to be prefixed with "mock"
const mockMasterKey = 'test-master-key-12345';
const mockInternalSecret = 'test-internal-secret-67890';

// ── Mock DB ──────────────────────────────────────────────
const mockDb = {
  queryResults: [],
  queryCalls: [],

  reset() {
    this.queryResults = [];
    this.queryCalls = [];
  },

  onQuery(matcher, result) {
    this.queryResults.push({ matcher, result });
  },

  _findResult(text) {
    for (let i = 0; i < this.queryResults.length; i++) {
      const { matcher, result } = this.queryResults[i];
      const matches = typeof matcher === 'string'
        ? text.includes(matcher)
        : matcher.test(text);
      if (matches) {
        this.queryResults.splice(i, 1);
        return result;
      }
    }
    return { rows: [], rowCount: 0 };
  },
};

const mockQuery = jest.fn(async (text, params) => {
  mockDb.queryCalls.push({ text, params });
  return mockDb._findResult(text);
});

// A transaction client whose query delegates to the same recorder, so
// onQuery matchers and queryCalls work identically inside withTransaction.
const mockClient = { query: mockQuery, release: jest.fn() };
const mockPool = {
  query: mockQuery,
  end: jest.fn(),
  connect: jest.fn(async () => mockClient),
};

// withTransaction runs fn against the mock client (no real BEGIN/COMMIT).
const mockWithTransaction = jest.fn(async (fn) => fn(mockClient));

jest.mock('../src/db', () => ({
  pool: mockPool,
  query: mockQuery,
  withTransaction: mockWithTransaction,
}));

// ── Mock queue (BullMQ) — no Redis in unit/integration ───
const mockAddJob = jest.fn(async () => ({ id: 'job-mock-id' }));
jest.mock('../src/queue', () => ({
  QUEUES: {
    MEDIA: 'media-processing', WEBHOOK: 'webhook-delivery', LIFECYCLE: 'lifecycle',
    ARCHIVE: 'archive', RESTORE: 'restore', RECONCILIATION: 'reconciliation',
    CLEANUP: 'cleanup', OUTBOX: 'outbox',
  },
  DEFAULT_JOB_OPTIONS: {},
  addJob: mockAddJob,
  getQueue: jest.fn(),
  getConnection: jest.fn(),
  recordJobActive: jest.fn(async () => {}),
  closeAll: jest.fn(async () => {}),
  isEnabled: jest.fn(() => true),
  setEnabled: jest.fn(),
}));

// ── Mock outbox service (durable event emit) ─────────────
jest.mock('../src/services/outboxService', () => ({
  emitEvent: jest.fn(async () => ({ id: 'outbox-mock-id' })),
  emitEventStandalone: jest.fn(async () => ({ id: 'outbox-mock-id' })),
}));

// ── Mock MinIO ───────────────────────────────────────────
const mockMinio = {
  putBufferCalls: [],
  putFileCalls: [],
  removedKeys: [],
  objects: {},

  reset() {
    this.putBufferCalls = [];
    this.putFileCalls = [];
    this.removedKeys = [];
    this.objects = {};
  },
};

jest.mock('../src/minio', () => ({
  minioClient: {
    bucketExists: jest.fn(async () => true),
    // Empty list stream by default; orphan/temp reconcile tests override this.
    listObjectsV2: jest.fn(() => {
      const { Readable } = require('stream');
      const r = new Readable({ objectMode: true });
      r.push(null);
      return r;
    }),
    statObject: jest.fn(async () => ({ size: 1000 })),
    removeObject: jest.fn(async () => {}),
  },
  ensureBucket: jest.fn(),
  putBuffer: jest.fn(async (key, buffer, contentType) => {
    mockMinio.putBufferCalls.push({ key, buffer, contentType });
    mockMinio.objects[key] = { buffer, contentType, size: buffer.length };
  }),
  putFile: jest.fn(async (key, filePath, contentType) => {
    mockMinio.putFileCalls.push({ key, filePath, contentType });
    mockMinio.objects[key] = { filePath, contentType, size: 0 };
  }),
  getObject: jest.fn(async (key) => {
    const { Readable } = require('stream');
    const obj = mockMinio.objects[key];
    const readable = new Readable();
    readable.push(obj ? obj.buffer : Buffer.from('fake'));
    readable.push(null);
    return readable;
  }),
  getPartialObject: jest.fn(async () => {
    const { Readable } = require('stream');
    const readable = new Readable();
    readable.push(Buffer.from('partial'));
    readable.push(null);
    return readable;
  }),
  statObject: jest.fn(async (key) => {
    const obj = mockMinio.objects[key];
    // Real object stores throw for a missing key; mirror that so code paths
    // that probe existence (e.g. the transform cache) behave realistically.
    // Unknown keys still resolve for the many callers that never store first,
    // UNLESS the key is a transform-cache probe (_cache/...).
    if (!obj && String(key).startsWith('_cache/')) {
      const err = new Error('NoSuchKey');
      err.code = 'NoSuchKey';
      throw err;
    }
    return { size: obj ? obj.size : 1000, metaData: {} };
  }),
  removeObject: jest.fn(async (key) => {
    mockMinio.removedKeys.push(key);
    delete mockMinio.objects[key];
  }),
}));

// ── Mock config ──────────────────────────────────────────
jest.mock('../src/config', () => ({
  port: 3000,
  nodeEnv: 'test',
  pg: { host: 'localhost', port: 5432, database: 'mediaos_test', user: 'test', password: 'test' },
  minio: { endPoint: 'localhost', port: 9000, useSSL: false, accessKey: 'test', secretKey: 'test' },
  bucket: 'test-bucket',
  redis: { url: 'redis://localhost:6379' },
  imgproxyUrl: 'http://localhost:8080',
  publicUrl: 'http://localhost:3000',
  masterKey: mockMasterKey,
  internalApiSecret: mockInternalSecret,
  // Fixed 32-byte hex key so secretBox round-trips in unit/integration tests.
  storageEncryptionKey: '0'.repeat(64),
  archiveHotGraceMs: 7 * 24 * 60 * 60 * 1000,
  // Phase 7 reconciler knobs.
  reconcileStuckMs: 30 * 60 * 1000,
  orphanMinAgeMs: 24 * 60 * 60 * 1000,
  tempUploadTtlMs: 24 * 60 * 60 * 1000,
  reconcileBatch: 500,
  reconcileCorruptSample: 25,
  healthSnapshotKeep: 500,
  cleanupRetentionMs: 30 * 24 * 60 * 60 * 1000,
  reconcileScanCron: '0 */6 * * *',
  healthSnapshotEveryMs: 5 * 60 * 1000,
  cleanupCron: '30 4 * * *',
  webpQuality: 80,
  maxWidth: 1600,
  maxHeight: 1600,
  videoCrf: '20',
  videoMaxHeight: 1080,
  maxFileSize: 104857600,
  concurrency: 3,
  apiRateLimit: 100,
  loginRateLimit: 10,
  adminRateLimit: 120,
  sessionRateLimit: 300,
  setupRateLimit: 5,
}));

// ── Mock Sharp (image processor) ─────────────────────────
jest.mock('sharp', () => {
  const mockSharpInstance = () => ({
    metadata: jest.fn(async () => ({
      format: 'png',
      width: 800,
      height: 600,
      pages: 1,
    })),
    resize: jest.fn().mockReturnThis(),
    rotate: jest.fn().mockReturnThis(),
    withMetadata: jest.fn().mockReturnThis(),
    webp: jest.fn().mockReturnThis(),
    toBuffer: jest.fn(async () => ({
      data: Buffer.from('webp-data'),
      info: { width: 800, height: 600, size: 9 },
    })),
  });
  const mockSharp = jest.fn(() => mockSharpInstance());
  return mockSharp;
});

// ── Mock video processor ─────────────────────────────────
jest.mock('../src/services/videoProcessor', () => ({
  transcodeVideo: jest.fn(async () => ({ path: '/tmp/out.mp4', size: 5000 })),
  extractThumbnail: jest.fn(async () => '/tmp/thumb.webp'),
  getVideoDuration: jest.fn(async () => 10.5),
  gifToMp4: jest.fn(async () => ({ path: '/tmp/gif.mp4', size: 3000 })),
  cleanup: jest.fn(),
  tmpPath: jest.fn((ext) => `/tmp/mv-test${ext}`),
  probeVideo: jest.fn(async () => ({ duration: 10.5, width: 1280, height: 720, hasAudio: true })),
  transcodeHls: jest.fn(async () => ({
    masterPath: '/tmp/hls/master.m3u8',
    posterPath: '/tmp/hls/poster.jpg',
    renditions: [
      { height: 360, width: 640, vbitrate: 800000, abitrate: 96000, bandwidth: 952000,
        codecs: 'avc1.4d401f,mp4a.40.2', dir: '/tmp/hls/360p', playlistName: 'index.m3u8',
        playlistPath: '/tmp/hls/360p/index.m3u8', segmentFiles: ['seg_000.ts'], bytes: 12000 },
      { height: 720, width: 1280, vbitrate: 2800000, abitrate: 128000, bandwidth: 3124000,
        codecs: 'avc1.4d401f,mp4a.40.2', dir: '/tmp/hls/720p', playlistName: 'index.m3u8',
        playlistPath: '/tmp/hls/720p/index.m3u8', segmentFiles: ['seg_000.ts'], bytes: 40000 },
    ],
    duration: 10.5, width: 1280, height: 720, hasAudio: true,
  })),
  selectRenditions: jest.requireActual('../src/services/videoProcessor').selectRenditions,
  HLS_LADDER: jest.requireActual('../src/services/videoProcessor').HLS_LADDER,
  HLS_SEGMENT_SECONDS: 6,
}));

// ── Mock usage service (fire-and-forget) ─────────────────
jest.mock('../src/services/usageService', () => ({
  trackUpload: jest.fn(async () => {}),
  trackDownload: jest.fn(async () => {}),
  trackTransform: jest.fn(async () => {}),
  trackDelete: jest.fn(async () => {}),
  trackApiRequest: jest.fn(async () => {}),
  trackBandwidth: jest.fn(),
  getCurrentUsage: jest.fn(async () => ({
    project_id: 'test-project-id',
    period: '2026-03',
    storage: { used: 0, limit: 1073741824, percent: 0 },
    bandwidth: { used: 0, limit: 5368709120, percent: 0 },
    uploads: 0, downloads: 0, transforms: 0,
    files: { total: 0, images: 0, videos: 0, other: 0 },
  })),
  getUsageHistory: jest.fn(async () => ({ data: [] })),
  flushBandwidthBuffer: jest.fn(),
}));

// ── Mock webhook service ─────────────────────────────────
jest.mock('../src/services/webhookService', () => ({
  createWebhook: jest.fn(async (projectId, url, events) => ({
    id: 'wh-test-id',
    project_id: projectId,
    url,
    secret: 'whsec_testsecret123',
    events: events || ['file.uploaded', 'file.processed', 'file.failed', 'file.deleted'],
    status: 'active',
    created_at: new Date().toISOString(),
  })),
  listWebhooks: jest.fn(async () => []),
  deleteWebhook: jest.fn(async () => true),
  dispatch: jest.fn(async () => {}),
}));

// ── Create app helper ────────────────────────────────────
function createTestApp() {
  // Rate limiter buckets live in module scope, so a fresh app still shares
  // counters with earlier tests unless they are cleared here.
  require('../src/middleware/ipRateLimit').reset();
  require('../src/middleware/rateLimit').reset();

  const createApp = require('../src/app');
  return createApp();
}

// ── Test data factories ──────────────────────────────────
const testAccount = {
  id: 'acc-test-id',
  name: 'Test User',
  email: 'test@example.com',
  plan: 'pro',
  status: 'active',
  metadata: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const testProject = {
  id: 'proj-test-id',
  account_id: 'acc-test-id',
  name: 'Test Project',
  slug: 'test-project',
  description: 'A test project',
  status: 'active',
  signing_secret: 'a'.repeat(64),
  settings: {
    max_file_size: 104857600,
    allowed_types: ['image', 'video', 'file'],
    webp_quality: 80,
    max_width: 1600,
    max_height: 1600,
    default_access: 'public',
  },
  storage_used: 0,
  file_count: 0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const testApiKey = {
  id: 'key-test-id',
  project_id: 'proj-test-id',
  name: 'Test Key',
  key_prefix: 'mv_live_tes',
  key_hash: 'abc123hash',
  scopes: ['upload', 'read', 'delete', 'admin'],
  status: 'active',
  rate_limit: 100,
  last_used_at: null,
  expires_at: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const testFile = {
  id: 'file-test-id',
  project_id: 'proj-test-id',
  storage_key: 'proj-test-id/test-image-abc123.webp',
  filename: 'test-image-abc123.webp',
  original_name: 'test.png',
  folder: null,
  type: 'image',
  mime_type: 'image/webp',
  size: 5000,
  original_size: 10000,
  width: 800,
  height: 600,
  duration: null,
  thumbnail_key: null,
  status: 'done',
  processing_ms: 50,
  access: 'public',
  uploaded_by: 'key-test-id',
  metadata: {},
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  deleted_at: null,
};

// ── Session / tenancy factories ──────────────────────────
const testUser = {
  id: 'user-test-id',
  email: 'test@example.com',
  name: 'Test User',
  status: 'active',
};

// A second tenant, for cross-tenant isolation tests.
const otherAccount = {
  id: 'acc-other-id',
  name: 'Other Co',
  plan: 'free',
  status: 'active',
};

const otherUser = {
  id: 'user-other-id',
  email: 'other@example.com',
  name: 'Other User',
  status: 'active',
};

// Export MASTER_KEY as the same value
const MASTER_KEY = mockMasterKey;
const INTERNAL_SECRET = mockInternalSecret;

/**
 * Headers a dashboard-originated request carries. Pass overrides to simulate
 * a missing/wrong secret or a different user/account.
 */
function sessionHeaders({ user = testUser, account = testAccount, secret = INTERNAL_SECRET } = {}) {
  const headers = {};
  if (secret !== null) headers['x-internal-secret'] = secret;
  if (user !== null) headers['x-user-id'] = user.id;
  if (account !== null) headers['x-account-id'] = account.id;
  return headers;
}

/**
 * Prime the two queries sessionAuth runs: the user lookup and the
 * membership+account join. Pass membership: null to simulate a non-member.
 */
function mockSession({ user = testUser, account = testAccount, role = 'owner', membership = true } = {}) {
  mockDb.onQuery('SELECT id, email, name, status FROM users', {
    rows: [{ id: user.id, email: user.email, name: user.name, status: 'active' }],
  });
  mockDb.onQuery('FROM account_memberships m', {
    rows: membership
      ? [{
          role,
          account_id: account.id,
          account_name: account.name,
          plan: account.plan,
          status: 'active',
        }]
      : [],
  });
}

module.exports = {
  createTestApp,
  mockDb,
  mockQuery,
  mockMinio,
  MASTER_KEY,
  INTERNAL_SECRET,
  sessionHeaders,
  mockSession,
  testAccount,
  testProject,
  testApiKey,
  testFile,
  testUser,
  otherAccount,
  otherUser,
};
