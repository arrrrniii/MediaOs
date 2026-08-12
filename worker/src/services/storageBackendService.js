/**
 * Storage-backend seam.
 *
 * A logical file's physical objects live on a storage backend. Today the
 * only real backend is the system-default MinIO bucket, configured from
 * env/config (storage_backends.configuration_encrypted is NULL). This
 * module hides that behind a uniform client interface so Phase 6 can add
 * S3/R2/B2 backends by returning a different client without touching the
 * upload or serve code.
 *
 * Client interface (every backend must implement):
 *   putBuffer(key, buffer, contentType) -> Promise<void>
 *   putFile(key, filePath, contentType) -> Promise<void>
 *   getObject(key)                       -> Promise<Readable>
 *   getPartialObject(key, offset, length)-> Promise<Readable>
 *   statObject(key)                      -> Promise<{ size, etag, ... }>
 *   removeObject(key)                    -> Promise<void>
 */

const { query } = require('../db');
const minio = require('../minio');

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

/**
 * The system-wide default backend row. Cached after the first successful
 * read; falls back to the env-configured MinIO description if the row is
 * not present.
 */
async function getDefaultBackend() {
  if (cachedDefault) return cachedDefault;

  try {
    const { rows } = await query(
      `SELECT id, account_id, type, name, configuration_encrypted, status, is_default
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
      `SELECT id, account_id, type, name, configuration_encrypted, status, is_default
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
 * A uniform storage client for a backend row. Only 'minio' is implemented;
 * other types throw until Phase 6 wires up their SDKs.
 */
function getBackendClient(backend) {
  const type = backend?.type || 'minio';

  if (type === 'minio') {
    // The system MinIO reads its credentials from config; nothing to decrypt.
    // TODO(phase-6): when backend.configuration_encrypted is set, decrypt it
    // and build a per-backend MinIO client instead of the shared module.
    return {
      putBuffer: minio.putBuffer,
      putFile: minio.putFile,
      getObject: minio.getObject,
      getPartialObject: minio.getPartialObject,
      statObject: minio.statObject,
      removeObject: minio.removeObject,
    };
  }

  // TODO(phase-6): s3 / r2 / b2 clients. configuration_encrypted must be
  // decrypted (KMS/master-key) into { endpoint, region, bucket, accessKey,
  // secretKey } before constructing the client.
  throw new Error(`Storage backend type "${type}" is not implemented yet`);
}

/** Test-only: drop caches so a fresh DB fixture is re-read. */
function _resetCache() {
  cachedDefault = null;
  backendByIdCache.clear();
}

module.exports = {
  getDefaultBackend,
  getBackendById,
  getBackendClient,
  SYSTEM_SCOPE,
  _resetCache,
};
