/**
 * Nginx access-log importer for cache-served requests.
 *
 * When nginx serves a /f/ or /img/ response from its edge cache, the request
 * never reaches the worker, so accessTrackingService never sees it and the
 * file would look colder than it is. This importer closes that gap: it parses
 * the `mediaos_access` log (see deploy/nginx.conf), maps each request path back
 * to a file via files.storage_key, and records the access through the exact
 * same UPSERT path the Redis flush uses (lifecycleFlushService.applyAccessDeltas).
 *
 * Idempotent + incremental: the last byte offset read from each log is stored
 * in lifecycle_kv, so re-runs pick up only new lines. Log rotation (file now
 * smaller than the stored offset) resets to 0. A missing log file is a clean
 * no-op.
 *
 * Log line format (tab-separated), matching the nginx log_format:
 *   $time_iso8601 \t $status \t $body_bytes_sent \t $request_method \t $uri
 */

const fs = require('fs');
const { query } = require('../db');
const { applyAccessDeltas } = require('./lifecycleFlushService');

const DEFAULT_LOG_PATH = '/var/log/nginx/mediaos_access.log';

/**
 * Parse one access-log line into an access record, or null if it is not a
 * countable successful media request. Exported for unit testing.
 *
 * @returns {{ kind:'download'|'transform', storageKey:string, day:string, lastSeenMs:number } | null}
 */
function parseAccessLine(line) {
  if (!line) return null;
  const parts = line.split('\t');
  if (parts.length < 5) return null;

  const time = parts[0];
  const code = parseInt(parts[1], 10);
  const method = parts[3];
  const uri = parts[4];

  // Only successful reads count (200 full, 206 ranged/partial).
  if (code !== 200 && code !== 206) return null;
  if (method && method !== 'GET' && method !== 'HEAD') return null;

  let kind;
  let rawKey;
  if (uri.startsWith('/f/')) {
    kind = 'download';
    rawKey = uri.slice('/f/'.length);
  } else if (uri.startsWith('/img/')) {
    const marker = uri.indexOf('/f/');
    if (marker < 0) return null;
    kind = 'transform';
    rawKey = uri.slice(marker + '/f/'.length);
  } else {
    return null;
  }
  if (!rawKey) return null;

  let storageKey;
  try {
    storageKey = decodeURIComponent(rawKey);
  } catch {
    storageKey = rawKey;
  }
  if (!storageKey) return null;

  const ts = Date.parse(time);
  const lastSeenMs = Number.isNaN(ts) ? Date.now() : ts;
  const day = new Date(lastSeenMs).toISOString().split('T')[0];

  return { kind, storageKey, day, lastSeenMs };
}

async function readOffset(kvKey) {
  const { rows } = await query('SELECT value FROM lifecycle_kv WHERE key = $1', [kvKey]);
  const v = rows[0] && rows[0].value;
  return v && Number.isFinite(v.offset) ? v.offset : 0;
}

async function writeOffset(kvKey, offset) {
  await query(
    `INSERT INTO lifecycle_kv (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [kvKey, JSON.stringify({ offset })]
  );
}

/**
 * Resolve a batch of storage keys to file ids.
 * @returns {Promise<Map<string,string>>} storageKey → fileId
 */
async function resolveKeys(storageKeys) {
  const map = new Map();
  if (storageKeys.length === 0) return map;
  const { rows } = await query(
    'SELECT id, storage_key FROM files WHERE storage_key = ANY($1)',
    [storageKeys]
  );
  for (const r of rows) map.set(r.storage_key, r.id);
  return map;
}

/**
 * Import new lines from an nginx access log into access_daily + files.
 * @returns {Promise<{ imported:number, lines:number, offset:number, skipped?:boolean }>}
 */
async function importAccessLog(logPath = DEFAULT_LOG_PATH) {
  if (!fs.existsSync(logPath)) {
    return { imported: 0, lines: 0, offset: 0, skipped: true };
  }

  const kvKey = `access_log_offset:${logPath}`;
  const stat = fs.statSync(logPath);
  let offset = await readOffset(kvKey);
  if (offset > stat.size) offset = 0; // rotated / truncated
  if (offset >= stat.size) return { imported: 0, lines: 0, offset };

  const length = stat.size - offset;
  const buf = Buffer.alloc(length);
  const fd = fs.openSync(logPath, 'r');
  try {
    fs.readSync(fd, buf, 0, length, offset);
  } finally {
    fs.closeSync(fd);
  }

  // Only consume up to the last complete line; a trailing partial line stays
  // for the next run. Newline detection is on the raw bytes so a multibyte
  // character split across the read boundary can't corrupt the offset.
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return { imported: 0, lines: 0, offset }; // no complete line yet
  const consumed = offset + lastNl + 1;

  const text = buf.slice(0, lastNl).toString('utf8');
  const lines = text.split('\n').filter((l) => l.length > 0);

  // Parse, then resolve keys in one batch.
  const parsed = [];
  const keySet = new Set();
  for (const line of lines) {
    const rec = parseAccessLine(line);
    if (rec) {
      parsed.push(rec);
      keySet.add(rec.storageKey);
    }
  }

  const keyToFile = await resolveKeys([...keySet]);

  const deltas = [];
  let imported = 0;
  for (const rec of parsed) {
    const fileId = keyToFile.get(rec.storageKey);
    if (!fileId) continue;
    deltas.push({
      fileId,
      day: rec.day,
      downloads: rec.kind === 'download' ? 1 : 0,
      transforms: rec.kind === 'transform' ? 1 : 0,
      lastSeenMs: rec.lastSeenMs,
    });
    imported++;
  }

  await applyAccessDeltas(deltas);
  await writeOffset(kvKey, consumed);

  return { imported, lines: lines.length, offset: consumed };
}

module.exports = {
  parseAccessLine,
  importAccessLog,
  DEFAULT_LOG_PATH,
};

// CLI: node src/services/accessLogImporter.js [logpath]
if (require.main === module) {
  const logPath = process.argv[2] || DEFAULT_LOG_PATH;
  const { pool } = require('../db');
  importAccessLog(logPath)
    .then((r) => {
      console.log(`Access log import: ${JSON.stringify(r)}`);
    })
    .catch((err) => {
      console.error('Access log import failed:', err.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
