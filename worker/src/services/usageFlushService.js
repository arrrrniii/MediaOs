const { query } = require('../db');
const config = require('../config');

// Redis key patterns:
//   usage:{projectId}:{date}:uploads        → count
//   usage:{projectId}:{date}:upload_bytes    → sum
//   usage:{projectId}:{date}:downloads       → count
//   usage:{projectId}:{date}:download_bytes  → sum
//   usage:{projectId}:{date}:transforms      → count
//   usage:{projectId}:{date}:deletes         → count
//   usage:{projectId}:{date}:api_requests    → count

const FIELDS = ['uploads', 'upload_bytes', 'downloads', 'download_bytes', 'transforms', 'deletes', 'api_requests'];
const KEY_PREFIX = 'usage:';

let flushInterval = null;

function usageKey(projectId, date, field) {
  return `${KEY_PREFIX}${projectId}:${date}:${field}`;
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

// Increment a usage counter in Redis (hot path — no DB)
function increment(redis, projectId, field, amount = 1) {
  if (!redis) return; // fallback: caller should use direct DB
  const key = usageKey(projectId, todayStr(), field);
  redis.incrby(key, amount).catch(() => {});
  // Set TTL of 48h so keys self-expire even if flush fails
  redis.expire(key, 172800).catch(() => {});
}

// Scan all usage keys and flush accumulated counters to Postgres
async function flush(redis) {
  if (!redis) return;

  let cursor = '0';
  const entries = new Map(); // "projectId:date" → { field: value }

  // Scan for all usage keys
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', `${KEY_PREFIX}*`, 'COUNT', 200);
    cursor = nextCursor;

    if (keys.length === 0) continue;

    // GETDEL each key atomically (get value and delete so it's not double-counted)
    const pipeline = redis.pipeline();
    for (const key of keys) {
      pipeline.getdel(key);
    }
    const results = await pipeline.exec();

    for (let i = 0; i < keys.length; i++) {
      const [err, val] = results[i];
      if (err || !val) continue;

      const amount = parseInt(val);
      if (!amount || amount <= 0) continue;

      // Parse key: usage:{projectId}:{date}:{field}
      const parts = keys[i].substring(KEY_PREFIX.length).split(':');
      if (parts.length < 3) continue;

      const field = parts.pop();
      const date = parts.pop();
      const projectId = parts.join(':'); // project IDs may contain colons (UUIDs don't, but be safe)

      const compositeKey = `${projectId}:${date}`;
      if (!entries.has(compositeKey)) {
        entries.set(compositeKey, { projectId, date, data: {} });
      }
      entries.get(compositeKey).data[field] = (entries.get(compositeKey).data[field] || 0) + amount;
    }
  } while (cursor !== '0');

  // Upsert each project+date into usage_daily
  for (const [, entry] of entries) {
    const { projectId, date, data } = entry;

    const setClauses = [];
    const values = [projectId, date];
    let idx = 3;

    const insertCols = ['project_id', 'date'];
    const insertVals = ['$1', '$2'];

    for (const field of FIELDS) {
      if (data[field]) {
        insertCols.push(field);
        insertVals.push(`$${idx}`);
        setClauses.push(`${field} = usage_daily.${field} + $${idx}`);
        values.push(data[field]);
        idx++;
      }
    }

    if (setClauses.length === 0) continue;

    await query(
      `INSERT INTO usage_daily (${insertCols.join(', ')})
       VALUES (${insertVals.join(', ')})
       ON CONFLICT (project_id, date) DO UPDATE
       SET ${setClauses.join(', ')}`,
      values
    ).catch((err) => {
      console.error(`Usage flush failed for project ${projectId}:`, err.message);
    });
  }
}

function startFlushInterval(redis) {
  if (flushInterval || !redis) return;
  const intervalMs = config.usageFlushIntervalMs || 10000;
  flushInterval = setInterval(() => {
    flush(redis).catch((err) => {
      console.error('Usage flush error:', err.message);
    });
  }, intervalMs);
  flushInterval.unref();
  console.log(`Usage flush interval started (${intervalMs}ms)`);
}

function stopFlushInterval() {
  if (flushInterval) {
    clearInterval(flushInterval);
    flushInterval = null;
  }
}

module.exports = { increment, flush, startFlushInterval, stopFlushInterval };
