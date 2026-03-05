const crypto = require('crypto');
const { sha256, constantTimeCompare, encrypt, decrypt } = require('../utils/crypto');
const { query } = require('../db');
const config = require('../config');

function generateKey(mode = 'live') {
  const prefix = `mv_${mode}_`;
  const random = crypto.randomBytes(16).toString('hex'); // 32 hex chars
  const fullKey = prefix + random;
  const keyPrefix = fullKey.substring(0, 12);
  const keyHash = sha256(fullKey);
  return { fullKey, prefix: keyPrefix, hash: keyHash };
}

async function validateKey(providedKey) {
  if (!providedKey || providedKey.length < 12) return null;

  const prefix = providedKey.substring(0, 12);
  const { rows } = await query(
    'SELECT * FROM api_keys WHERE key_prefix = $1 AND status = $2',
    [prefix, 'active']
  );

  if (rows.length === 0) return null;

  const hash = sha256(providedKey);

  for (const row of rows) {
    if (constantTimeCompare(hash, row.key_hash)) {
      // Check expiry
      if (row.expires_at && new Date(row.expires_at) < new Date()) {
        return null;
      }
      return row;
    }
  }

  return null;
}

async function createKey(projectId, name = 'Default Key', scopes = ['upload', 'read'], options = {}) {
  const { fullKey, prefix, hash } = generateKey(options.mode || 'live');
  const encryptedKey = encrypt(fullKey, config.masterKey);

  const { rows } = await query(
    `INSERT INTO api_keys (project_id, name, key_prefix, key_hash, encrypted_key, scopes, rate_limit, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, key_prefix, scopes, status, rate_limit, expires_at, created_at`,
    [
      projectId,
      name,
      prefix,
      hash,
      encryptedKey,
      scopes,
      options.rate_limit || 100,
      options.expires_at || null,
    ]
  );

  return {
    ...rows[0],
    key: fullKey,
  };
}

async function revokeKey(keyId) {
  const { rowCount } = await query(
    "UPDATE api_keys SET status = 'revoked' WHERE id = $1 AND status = 'active'",
    [keyId]
  );
  return rowCount > 0;
}

async function listKeys(projectId) {
  const { rows } = await query(
    `SELECT id, name, key_prefix, scopes, status, rate_limit, last_used_at, expires_at, created_at
     FROM api_keys
     WHERE project_id = $1
     ORDER BY created_at DESC`,
    [projectId]
  );
  return rows;
}

async function revealKey(keyId) {
  const { rows } = await query(
    "SELECT encrypted_key FROM api_keys WHERE id = $1 AND status = 'active'",
    [keyId]
  );
  if (rows.length === 0 || !rows[0].encrypted_key) return null;
  return decrypt(rows[0].encrypted_key, config.masterKey);
}

module.exports = { generateKey, validateKey, createKey, revokeKey, listKeys, revealKey };
