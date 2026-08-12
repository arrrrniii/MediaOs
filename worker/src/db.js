const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  host: config.pg.host,
  port: config.pg.port,
  database: config.pg.database,
  user: config.pg.user,
  password: config.pg.password,
  max: config.pg.poolMax,
  idleTimeoutMillis: config.pg.poolIdleTimeoutMs,
  connectionTimeoutMillis: config.pg.poolConnectionTimeoutMs,
});

pool.on('error', (err) => {
  console.error('Unexpected PG pool error:', err.message);
});

const query = (text, params) => pool.query(text, params);

/**
 * Run `fn` inside a single transaction on a dedicated client.
 *
 * `fn` receives that client and MUST run its queries on it (client.query),
 * so every statement — and any outbox_events insert — commits atomically
 * with the state change. Commits and returns fn's result on success;
 * rolls back and rethrows on any error. The client is always released.
 */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch { /* connection may already be broken; original error wins */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, withTransaction };
