/**
 * Redis connection options for BullMQ.
 *
 * BullMQ blocks on Redis (BRPOPLPUSH etc.) and REQUIRES maxRetriesPerRequest
 * to be null on the connection its Workers and Queues use — otherwise ioredis
 * aborts the long-lived blocking command after N retries and BullMQ throws.
 * This is deliberately different from the app.locals.redis client (which uses
 * maxRetriesPerRequest: 3 for ordinary GET/SET usage tracking).
 */

const config = require('../config');

// Shared base options. enableReadyCheck is fine for BullMQ; the critical
// setting is maxRetriesPerRequest: null.
const bullConnectionOptions = {
  maxRetriesPerRequest: null,
};

/**
 * Create a fresh ioredis connection configured for BullMQ. Each Worker/Queue
 * can be given its own connection, or share one; BullMQ duplicates as needed.
 * Lazy-requires ioredis so unit tests without Redis never construct a client.
 */
function createConnection(overrides = {}) {
  const Redis = require('ioredis');
  return new Redis(config.redis.url, { ...bullConnectionOptions, ...overrides });
}

module.exports = { bullConnectionOptions, createConnection };
