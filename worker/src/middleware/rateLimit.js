const inMemoryStore = new Map();

// Periodic cleanup of expired entries
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of inMemoryStore) {
    if (data.resetAt < now) {
      inMemoryStore.delete(key);
    }
  }
}, 60000).unref();

function rateLimit(req, res, next) {
  if (!req.apiKey) return next();

  const limit = req.apiKey.rate_limit || 100;
  const keyId = req.apiKey.id;
  const now = Date.now();
  const minuteBucket = Math.floor(now / 60000);
  const bucketKey = `ratelimit:${keyId}:${minuteBucket}`;
  const resetAt = (minuteBucket + 1) * 60000;

  const redis = req.app.locals.redis;

  if (redis) {
    // Redis-based sliding window
    const redisKey = bucketKey;
    redis.incr(redisKey).then((count) => {
      if (count === 1) {
        redis.expire(redisKey, 120);
      }

      const remaining = Math.max(0, limit - count);
      const resetTimestamp = Math.floor(resetAt / 1000);

      res.set('X-RateLimit-Limit', String(limit));
      res.set('X-RateLimit-Remaining', String(remaining));
      res.set('X-RateLimit-Reset', String(resetTimestamp));

      if (count > limit) {
        const retryAfter = Math.ceil((resetAt - now) / 1000);
        return res.status(429).json({
          error: 'Rate limit exceeded',
          code: 'RATE_LIMITED',
          retry_after: retryAfter,
        });
      }

      next();
    }).catch(() => {
      // Fallback to in-memory on Redis error
      handleInMemory(bucketKey, limit, resetAt, now, res, next);
    });
  } else {
    handleInMemory(bucketKey, limit, resetAt, now, res, next);
  }
}

function handleInMemory(bucketKey, limit, resetAt, now, res, next) {
  let data = inMemoryStore.get(bucketKey);
  if (!data || data.resetAt < now) {
    data = { count: 0, resetAt };
    inMemoryStore.set(bucketKey, data);
  }

  data.count++;
  const remaining = Math.max(0, limit - data.count);
  const resetTimestamp = Math.floor(resetAt / 1000);

  res.set('X-RateLimit-Limit', String(limit));
  res.set('X-RateLimit-Remaining', String(remaining));
  res.set('X-RateLimit-Reset', String(resetTimestamp));

  if (data.count > limit) {
    const retryAfter = Math.ceil((resetAt - now) / 1000);
    return res.status(429).json({
      error: 'Rate limit exceeded',
      code: 'RATE_LIMITED',
      retry_after: retryAfter,
    });
  }

  next();
}

module.exports = rateLimit;
