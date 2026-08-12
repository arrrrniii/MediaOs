/**
 * Storage-backend seam.
 *
 * A logical file's physical objects live on a storage backend. The system
 * default is the local MinIO bucket, configured from env/config
 * (storage_backends.configuration_encrypted is NULL). Phase 6 adds remote
 * cold backends — AWS S3, Cloudflare R2, Backblaze B2, or a secondary remote
 * MinIO — whose whole connection config lives ENCRYPTED in
 * configuration_encrypted. This module hides both behind one uniform client
 * interface so upload/serve/archive code never branches on backend type.
 *
 * Client interface (every backend implements):
 *   putBuffer(key, buffer, contentType) -> Promise<void>
 *   putFile(key, filePath, contentType) -> Promise<void>
 *   getObject(key)                       -> Promise<Readable>
 *   getPartialObject(key, offset, length)-> Promise<Readable>
 *   statObject(key)                      -> Promise<{ size, etag, ... }>
 *   removeObject(key)                    -> Promise<void>
 *
 * getBackendClient is synchronous: decrypting the config and constructing an
 * S3 client are both synchronous, so no call site had to become async.
 */

const { query } = require('../db');
const minio = require('../minio');
const secretBox = require('../utils/secretBox');
const { createS3Client } = require('../storage/s3Client');

// Sentinel used by the DB's partial-unique index for system-wide defaults.
const SYSTEM_SCOPE = '00000000-0000-0000-0000-000000000000';

// Fallback returned when the seeded default row cannot be read (fresh dev
// DB before migration 006, or a mocked DB in tests). Production always has
// the seeded row, so this only ever stands in for the env-configured MinIO.
const FALLBACK_DEFAULT_BACKEND = Object.freeze({
  id: SYSTEM_SCOPE,
  account_id: null,
  type: 'minio',
  name: 'Primary MinIO',
  configuration_encrypted: null,
  status: 'active',
  is_default: true,
});

let cachedDefault = null;
const backendByIdCache = new Map();
// backend id -> { client, configFingerprint }. A config change (re-verify /
// key rotation) busts the entry so we never keep a client on stale creds.
const clientCache = new Map();

// The local-MinIO uniform client. The system MinIO reads its credentials from
// config, so there is nothing to decrypt — it just forwards to the shared
// module. Shared singleton; no per-backend state.
const LOCAL_MINIO_CLIENT = Object.freeze({
  putBuffer: minio.putBuffer,
  putFile: minio.putFile,
  getObject: minio.getObject,
  getPartialObject: minio.getPartialObject,
  statObject: minio.statObject,
  removeObject: minio.removeObject,
});

/**
 * The system-wide default backend row. Cached after the first successful
 * read; falls back to the env-configured MinIO description if the row is
 * not present.
 */
async function getDefaultBackend() {
  if (cachedDefault) return cachedDefault;

  try {
    const { rows } = await query(
      `SELECT id, account_id, type, name, configuration_encrypted, status, is_default, is_cold_default, last_verified_at
       FROM storage_backends
       WHERE account_id IS NULL AND is_default AND status = 'active'
       LIMIT 1`
    );
    if (rows.length > 0) {
      cachedDefault = rows[0];
      backendByIdCache.set(cachedDefault.id, cachedDefault);
      return cachedDefault;
    }
  } catch {
    // DB unavailable / table missing — fall through to the env-configured default.
  }
  return FALLBACK_DEFAULT_BACKEND;
}

/**
 * Resolve a backend by id (used when streaming a specific object). Falls
 * back to the default backend when the id is unknown — safe today because
 * every object lives on the single MinIO backend.
 */
async function getBackendById(id) {
  if (!id) return getDefaultBackend();
  if (backendByIdCache.has(id)) return backendByIdCache.get(id);

  try {
    const { rows } = await query(
      `SELECT id, account_id, type, name, configuration_encrypted, status, is_default, is_cold_default, last_verified_at
       FROM storage_backends WHERE id = $1 LIMIT 1`,
      [id]
    );
    if (rows.length > 0) {
      backendByIdCache.set(id, rows[0]);
      return rows[0];
    }
  } catch {
    // fall through
  }
  return getDefaultBackend();
}

/**
 * Decrypt a backend's configuration_encrypted blob into its config object.
 * Throws (via secretBox) if the key is missing or the blob is tampered — a
 * mutated config must fail loudly, not build a client against forged creds.
 * Never logs the returned object; callers must not either.
 */
function decryptConfig(backend) {
  if (!backend || !backend.configuration_encrypted) return null;
  return secretBox.decryptJson(backend.configuration_encrypted);
}

/**
 * A uniform storage client for a backend row.
 *   - type 'minio' with NULL config  -> the local env-configured MinIO.
 *   - type 's3' | 'r2' | 'b2'         -> a decrypted-config S3 client.
 *   - type 'minio' with a config blob -> a remote MinIO via the S3 client
 *                                        (forcePathStyle defaults on).
 * Clients are cached by backend id and rebuilt when the encrypted config
 * changes. This function NEVER logs secrets.
 */
function getBackendClient(backend) {
  const type = (backend && backend.type) || 'minio';
  const hasConfig = !!(backend && backend.configuration_encrypted);

  // Local system MinIO: no config to decrypt.
  if (type === 'minio' && !hasConfig) {
    return LOCAL_MINIO_CLIENT;
  }

  if (!['minio', 's3', 'r2', 'b2'].includes(type)) {
    throw new Error(`Storage backend type "${type}" is not supported`);
  }

  const id = backend.id || 'anon';
  const fingerprint = backend.configuration_encrypted;
  const cached = clientCache.get(id);
  if (cached && cached.fingerprint === fingerprint) {
    return cached.client;
  }

  // Decrypt on demand. secretBox throws with a clear message if the key is
  // missing; we deliberately let that propagate rather than swallow it.
  const cfg = decryptConfig(backend);
  if (!cfg) {
    throw new Error(`Backend ${type} has no configuration to build a client from`);
  }
  // MinIO / B2 / R2 all want path-style addressing; default it on for those
  // and any remote MinIO, unless the config explicitly disables it.
  const forcePathStyle = cfg.forcePathStyle !== undefined
    ? cfg.forcePathStyle
    : (type === 'minio' || type === 'b2' || type === 'r2');
  const client = createS3Client({ ...cfg, forcePathStyle });

  clientCache.set(id, { client, fingerprint });
  return client;
}

/**
 * Resolve the cold backend new archives should go to, for an account:
 *   1. the account's own is_cold_default backend, else
 *   2. the system-wide is_cold_default backend, else
 *   3. null (no cold backend configured — archive jobs no-op safely).
 * @param {{ id?: string } | string | null} account  account object or id
 * @returns {Promise<object|null>} the storage_backends row, or null.
 */
async function resolveColdBackend(account) {
  const accountId = account && (typeof account === 'string' ? account : account.id);
  try {
    if (accountId) {
      const { rows } = await query(
        `SELECT id, account_id, type, name, configuration_encrypted, status, is_default, is_cold_default, last_verified_at
           FROM storage_backends
          WHERE account_id = $1 AND is_cold_default AND status = 'active'
          LIMIT 1`,
        [accountId]
      );
      if (rows.length > 0) {
        backendByIdCache.set(rows[0].id, rows[0]);
        return rows[0];
      }
    }
    const { rows: sys } = await query(
      `SELECT id, account_id, type, name, configuration_encrypted, status, is_default, is_cold_default, last_verified_at
         FROM storage_backends
        WHERE account_id IS NULL AND is_cold_default AND status = 'active'
        LIMIT 1`
    );
    if (sys.length > 0) {
      backendByIdCache.set(sys[0].id, sys[0]);
      return sys[0];
    }
  } catch {
    // fall through
  }
  return null;
}

/** Drop the cached client for one backend (after a config update). */
function invalidateClient(id) {
  clientCache.delete(id);
  backendByIdCache.delete(id);
  if (cachedDefault && cachedDefault.id === id) cachedDefault = null;
}

/** Test-only: drop caches so a fresh DB fixture is re-read. */
function _resetCache() {
  cachedDefault = null;
  backendByIdCache.clear();
  clientCache.clear();
}

module.exports = {
  getDefaultBackend,
  getBackendById,
  getBackendClient,
  resolveColdBackend,
  decryptConfig,
  invalidateClient,
  SYSTEM_SCOPE,
  _resetCache,
};
