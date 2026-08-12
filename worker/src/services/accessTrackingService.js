/**
 * Per-file access tracking — the hot path.
 *
 * Every original stream and every image transform records a cheap,
 * fire-and-forget access "tick" into Redis. Nothing here touches Postgres:
 * counts accumulate in a per-day hash and the file's last-seen time in a
 * single hash, and a batch flush (lifecycleFlushService) drains them into
 * access_daily + files.last_accessed_at on an interval.
 *
 * Redis shape:
 *   access:{YYYY-MM-DD}  hash, field `{fileId}:{kind}`   → count for that day
 *   access:last          hash, field `{fileId}`          → last-seen epoch ms
 *
 * kind ∈ ('download', 'transform', 'video_play'), mapped to the access_daily
 * columns (downloads, transforms, video_plays) at flush time.
 */

const KIND_TO_COLUMN = {
  download: 'downloads',
  transform: 'transforms',
  video_play: 'video_plays',
};

const DAY_HASH_PREFIX = 'access:';
const LAST_HASH_KEY = 'access:last';
// 3-day TTL on the per-day hashes so a flush outage self-heals rather than
// leaking Redis memory forever.
const DAY_HASH_TTL_SECONDS = 3 * 24 * 60 * 60;

let _redis = null;

function setRedis(redis) {
  _redis = redis;
}

function todayStr() {
  return new Date().toISOString().split('T')[0];
}

function dayHashKey(day) {
  return `${DAY_HASH_PREFIX}${day}`;
}

/**
 * Record one access against a file. Cheap, non-blocking, never throws — a
 * Redis hiccup must never break serving. Unknown kinds are ignored.
 */
function recordAccess(fileId, kind) {
  if (!_redis || !fileId) return;
  if (!KIND_TO_COLUMN[kind]) return;
  try {
    const day = todayStr();
    const key = dayHashKey(day);
    _redis.hincrby(key, `${fileId}:${kind}`, 1).catch(() => {});
    _redis.expire(key, DAY_HASH_TTL_SECONDS).catch(() => {});
    _redis.hset(LAST_HASH_KEY, fileId, Date.now()).catch(() => {});
  } catch {
    // fire-and-forget: swallow everything
  }
}

module.exports = {
  setRedis,
  recordAccess,
  KIND_TO_COLUMN,
  LAST_HASH_KEY,
  DAY_HASH_PREFIX,
  dayHashKey,
  todayStr,
};
