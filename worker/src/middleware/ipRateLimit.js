/**
 * Distributed fixed-window rate limiter keyed by prefix + identifier.
 *
 * Uses the Redis client the app exposes on req.app.locals.redis (INCR +
 * EXPIRE, so all worker replicas share one counter) and falls back to an
 * in-process Map when Redis is absent or erroring.
 *
 * Unlike middleware/rateLimit.js — which limits an authenticated API key —
 * this runs before authentication, so it protects login, setup, and the
 * MASTER_KEY admin surface from brute force by unauthenticated callers.
 */

const inMemoryStore = new Map();

const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, data] of inMemoryStore) {
    if (data.resetAt < now) inMemoryStore.delete(key);
  }
}, 60000);
cleanupTimer.unref();

function clientIp(req) {
  return req.ip || (req.connection && req.connection.remoteAddress) || 'unknown';
}

function tooMany(res, resetAt, now) {
  const retryAfter = Math.max(1, Math.ceil((resetAt - now) / 1000));
  res.set('Retry-After', String(retryAfter));
  return res.status(429).json({
    error: 'Too many requests',
    code: 'RATE_LIMITED',
    retry_after: retryAfter,
  });
}

function bumpInMemory(bucketKey, resetAt, now) {
  let data = inMemoryStore.get(bucketKey);
  if (!data || data.resetAt < now) {
    data = { count: 0, resetAt };
    inMemoryStore.set(bucketKey, data);
  }
  data.count++;
  return data.count;
}

/**
 * @param {string} prefix    namespace for the counter, e.g. 'login'
 * @param {number} limit     max requests per window
 * @param {object} [options]
 * @param {number} [options.windowMs=60000]
 * @param {(req, ip) => Array<string|null>} [options.identifiers]  the buckets a
 *        request counts against. Defaults to the client IP alone; a request
 *        is rejected as soon as any one of its buckets is over the limit.
 */
function ipRateLimit(prefix, limit, options = {}) {
  const windowMs = options.windowMs || 60000;
  const identifiers = options.identifiers || ((req, ip) => [ip]);

  return function ipRateLimitMiddleware(req, res, next) {
    const now = Date.now();
    const bucket = Math.floor(now / windowMs);
    const resetAt = (bucket + 1) * windowMs;

    const ip = clientIp(req);
    let ids;
    try {
      ids = identifiers(req, ip).filter(Boolean);
    } catch {
      // A malformed body must not disable the limit.
      ids = [ip];
    }
    if (ids.length === 0) ids = [ip];

    const keys = ids.map((id) => `iprate:${prefix}:${id}:${bucket}`);
    const redis = req.app.locals.redis;

    if (!redis) {
      const exceeded = keys
        .map((key) => bumpInMemory(key, resetAt, now))
        .some((count) => count > limit);
      return exceeded ? tooMany(res, resetAt, now) : next();
    }

    Promise.all(
      keys.map((key) =>
        redis.incr(key).then((count) => {
          if (count === 1) redis.expire(key, Math.ceil(windowMs / 1000) + 60);
          return count;
        })
      )
    )
      .then((counts) => {
        if (counts.some((count) => count > limit)) return tooMany(res, resetAt, now);
        next();
      })
      .catch(() => {
        const exceeded = keys
          .map((key) => bumpInMemory(key, resetAt, now))
          .some((count) => count > limit);
        return exceeded ? tooMany(res, resetAt, now) : next();
      });
  };
}

// Tests share one module instance across cases; let them start from zero.
ipRateLimit.reset = function reset() {
  inMemoryStore.clear();
};

module.exports = ipRateLimit;
