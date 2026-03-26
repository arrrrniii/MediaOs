const { query } = require('../db');
const { increment } = require('./usageFlushService');

// --- Bandwidth log buffer (stays in-memory, batched to DB) ---

const bandwidthBuffer = [];
let flushTimer = null;

function startFlushTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(() => {
    flushBandwidthBuffer();
  }, 5000);
  flushTimer.unref();
}

async function flushBandwidthBuffer() {
  if (bandwidthBuffer.length === 0) return;

  const batch = bandwidthBuffer.splice(0, bandwidthBuffer.length);

  const values = [];
  const placeholders = [];
  let idx = 1;

  for (const entry of batch) {
    placeholders.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3})`);
    values.push(entry.projectId, entry.fileId, entry.bytesServed, entry.isTransform);
    idx += 4;
  }

  await query(
    `INSERT INTO bandwidth_log (project_id, file_id, bytes_served, is_transform) VALUES ${placeholders.join(', ')}`,
    values
  ).catch((err) => {
    console.error('Failed to flush bandwidth buffer:', err.message);
  });
}

function trackBandwidth(projectId, fileId, bytesServed, isTransform = false) {
  bandwidthBuffer.push({ projectId, fileId, bytesServed, isTransform });
  if (bandwidthBuffer.length >= 100) {
    flushBandwidthBuffer();
  }
  startFlushTimer();
}

// --- Usage counters (Redis-first, DB fallback) ---

// Redis ref is injected via setRedis() at boot
let _redis = null;

function setRedis(redis) {
  _redis = redis;
}

function trackUpload(projectId, originalSize) {
  if (_redis) {
    increment(_redis, projectId, 'uploads');
    increment(_redis, projectId, 'upload_bytes', originalSize);
    increment(_redis, projectId, 'api_requests');
    return Promise.resolve();
  }
  // Fallback: direct DB upsert
  const today = new Date().toISOString().split('T')[0];
  return query(
    `INSERT INTO usage_daily (project_id, date, uploads, upload_bytes, api_requests)
     VALUES ($1, $2, 1, $3, 1)
     ON CONFLICT (project_id, date) DO UPDATE
     SET uploads = usage_daily.uploads + 1,
         upload_bytes = usage_daily.upload_bytes + $3,
         api_requests = usage_daily.api_requests + 1`,
    [projectId, today, originalSize]
  ).catch(() => {});
}

function trackDownload(projectId, bytesServed) {
  if (_redis) {
    increment(_redis, projectId, 'downloads');
    increment(_redis, projectId, 'download_bytes', bytesServed);
    increment(_redis, projectId, 'api_requests');
    return Promise.resolve();
  }
  const today = new Date().toISOString().split('T')[0];
  return query(
    `INSERT INTO usage_daily (project_id, date, downloads, download_bytes, api_requests)
     VALUES ($1, $2, 1, $3, 1)
     ON CONFLICT (project_id, date) DO UPDATE
     SET downloads = usage_daily.downloads + 1,
         download_bytes = usage_daily.download_bytes + $3,
         api_requests = usage_daily.api_requests + 1`,
    [projectId, today, bytesServed]
  ).catch(() => {});
}

function trackTransform(projectId) {
  if (_redis) {
    increment(_redis, projectId, 'transforms');
    increment(_redis, projectId, 'api_requests');
    return Promise.resolve();
  }
  const today = new Date().toISOString().split('T')[0];
  return query(
    `INSERT INTO usage_daily (project_id, date, transforms, api_requests)
     VALUES ($1, $2, 1, 1)
     ON CONFLICT (project_id, date) DO UPDATE
     SET transforms = usage_daily.transforms + 1,
         api_requests = usage_daily.api_requests + 1`,
    [projectId, today]
  ).catch(() => {});
}

function trackDelete(projectId) {
  if (_redis) {
    increment(_redis, projectId, 'deletes');
    increment(_redis, projectId, 'api_requests');
    return Promise.resolve();
  }
  const today = new Date().toISOString().split('T')[0];
  return query(
    `INSERT INTO usage_daily (project_id, date, deletes, api_requests)
     VALUES ($1, $2, 1, 1)
     ON CONFLICT (project_id, date) DO UPDATE
     SET deletes = usage_daily.deletes + 1,
         api_requests = usage_daily.api_requests + 1`,
    [projectId, today]
  ).catch(() => {});
}

function trackApiRequest(projectId) {
  if (_redis) {
    increment(_redis, projectId, 'api_requests');
    return Promise.resolve();
  }
  const today = new Date().toISOString().split('T')[0];
  return query(
    `INSERT INTO usage_daily (project_id, date, api_requests)
     VALUES ($1, $2, 1)
     ON CONFLICT (project_id, date) DO UPDATE
     SET api_requests = usage_daily.api_requests + 1`,
    [projectId, today]
  ).catch(() => {});
}

// --- Read-only queries (always hit Postgres — these are not hot-path) ---

async function getCurrentUsage(project) {
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const monthStart = `${period}-01`;

  const { rows: usageRows } = await query(
    `SELECT COALESCE(SUM(uploads), 0) as uploads,
            COALESCE(SUM(downloads), 0) as downloads,
            COALESCE(SUM(transforms), 0) as transforms,
            COALESCE(SUM(upload_bytes), 0) as upload_bytes,
            COALESCE(SUM(download_bytes), 0) as download_bytes
     FROM usage_daily
     WHERE project_id = $1 AND date >= $2`,
    [project.id, monthStart]
  );

  const { rows: fileCounts } = await query(
    `SELECT type, COUNT(*) as count
     FROM files
     WHERE project_id = $1 AND deleted_at IS NULL
     GROUP BY type`,
    [project.id]
  );

  const filesByType = { images: 0, videos: 0, other: 0 };
  let totalFiles = 0;
  for (const row of fileCounts) {
    totalFiles += parseInt(row.count);
    if (row.type === 'image') filesByType.images = parseInt(row.count);
    else if (row.type === 'video') filesByType.videos = parseInt(row.count);
    else filesByType.other += parseInt(row.count);
  }

  let storageLimit = null;
  let bandwidthLimit = null;
  try {
    const { rows: planRows } = await query(
      `SELECT p.* FROM plans p
       JOIN accounts a ON a.plan = p.id
       JOIN projects pr ON pr.account_id = a.id
       WHERE pr.id = $1`,
      [project.id]
    );
    if (planRows[0]) {
      storageLimit = planRows[0].max_storage || null;
      bandwidthLimit = planRows[0].max_bandwidth || null;
    }
  } catch {
    // plans table may not exist — self-hosted has no limits
  }

  const usage = usageRows[0];
  const storageUsed = parseInt(project.storage_used) || 0;
  const bandwidthUsed = parseInt(usage.download_bytes) || 0;

  return {
    project_id: project.id,
    period,
    storage: {
      used: storageUsed,
      limit: storageLimit,
      percent: storageLimit ? Math.round((storageUsed / storageLimit) * 1000) / 10 : null,
    },
    bandwidth: {
      used: bandwidthUsed,
      limit: bandwidthLimit,
      percent: bandwidthLimit ? Math.round((bandwidthUsed / bandwidthLimit) * 1000) / 10 : null,
    },
    uploads: parseInt(usage.uploads) || 0,
    downloads: parseInt(usage.downloads) || 0,
    transforms: parseInt(usage.transforms) || 0,
    files: {
      total: totalFiles,
      ...filesByType,
    },
  };
}

async function getUsageHistory(projectId, days = 30) {
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startStr = startDate.toISOString().split('T')[0];

  const { rows } = await query(
    `SELECT date, uploads, upload_bytes, downloads, download_bytes,
            transforms, deletes, api_requests, storage_bytes, file_count
     FROM usage_daily
     WHERE project_id = $1 AND date >= $2
     ORDER BY date ASC`,
    [projectId, startStr]
  );

  return { data: rows };
}

module.exports = {
  setRedis,
  trackUpload, trackDownload, trackTransform, trackDelete, trackApiRequest,
  trackBandwidth, getCurrentUsage, getUsageHistory, flushBandwidthBuffer,
};
