/**
 * Persistent transform cache.
 *
 * A rendered transform (an imgproxy output for a given file + params + format)
 * is stored back in the default storage backend under a deterministic key that
 * embeds the file's cache_version. A subsequent request for the same transform
 * streams the stored object instead of re-rendering.
 *
 * Purge model: bumping files.cache_version changes the key prefix, so every
 * previously cached object becomes unreachable at once (a lazy purge). The
 * transform_cache rows let an explicit purge also delete the physical objects;
 * anything left behind is swept by the Phase-7 orphan reaper (an object with
 * no live reference under the current version).
 *
 * Privacy: private/signed files are NEVER written to this shared cache — a
 * cached copy would be servable without the token. Only public files cache.
 */

const { query } = require('../db');
const storageBackendService = require('./storageBackendService');

const CACHE_PREFIX = '_cache';

/**
 * Deterministic storage key for a cached transform. Embedding cache_version in
 * the path means a version bump silently invalidates every prior key.
 *   _cache/v{version}/{fileId}/{variantKey}.{fmt}
 */
function cacheStorageKey(fileId, cacheVersion, variantKey, format) {
  const safeVariant = String(variantKey).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return `${CACHE_PREFIX}/v${cacheVersion}/${fileId}/${safeVariant}.${format}`;
}

/** Canonical variant key for a raw resize transform. */
function rawVariantKey(mode, width, height) {
  return `r_${mode}_${width}x${height}`;
}

/** Canonical variant key for a named variant. */
function namedVariantKey(name) {
  return `n_${name}`;
}

/**
 * Look up a cached transform. Returns { client, key, stat } when a stored
 * object exists, else null. Only meaningful for public files; callers must not
 * call this for private/signed files.
 */
async function lookup(fileId, cacheVersion, variantKey, format) {
  const key = cacheStorageKey(fileId, cacheVersion, variantKey, format);
  try {
    const backend = await storageBackendService.getDefaultBackend();
    const client = storageBackendService.getBackendClient(backend);
    const stat = await client.statObject(key);
    return { client, key, stat };
  } catch {
    return null;
  }
}

/**
 * Store a rendered transform (best-effort). Writes the object to the default
 * backend and records a transform_cache row. Never throws — a cache write
 * failure must not fail the request that produced the bytes.
 */
async function store({ projectId, fileId, cacheVersion, variantKey, format, buffer, contentType }) {
  const key = cacheStorageKey(fileId, cacheVersion, variantKey, format);
  try {
    const backend = await storageBackendService.getDefaultBackend();
    const client = storageBackendService.getBackendClient(backend);
    await client.putBuffer(key, buffer, contentType || `image/${format}`);
    await query(
      `INSERT INTO transform_cache (project_id, file_id, variant_key, storage_key, format, size)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (file_id, variant_key) DO UPDATE SET
         storage_key = EXCLUDED.storage_key, format = EXCLUDED.format,
         size = EXCLUDED.size, created_at = NOW()`,
      [projectId || null, fileId, variantKey, key, format, buffer.length]
    ).catch(() => {});
  } catch {
    // best-effort; leave no partial bookkeeping
  }
  return key;
}

/**
 * Bump a file's cache_version (lazy purge) and delete the known cached
 * objects + their transform_cache rows. Returns the new cache_version and the
 * number of objects removed. Object deletes are best-effort; any that fail
 * become orphans reaped later.
 */
async function purge(fileId, projectId) {
  // Delete the physical cache objects we know about.
  let removed = 0;
  const { rows } = await query(
    'SELECT storage_key FROM transform_cache WHERE file_id = $1',
    [fileId]
  );
  if (rows.length > 0) {
    const backend = await storageBackendService.getDefaultBackend();
    const client = storageBackendService.getBackendClient(backend);
    for (const r of rows) {
      try {
        await client.removeObject(r.storage_key);
        removed += 1;
      } catch { /* orphaned; reaped later */ }
    }
    await query('DELETE FROM transform_cache WHERE file_id = $1', [fileId]).catch(() => {});
  }

  // Bump cache_version so any object we could not delete is now unreachable.
  const params = projectId ? [fileId, projectId] : [fileId];
  const where = projectId ? 'id = $1 AND project_id = $2' : 'id = $1';
  const { rows: bumped } = await query(
    `UPDATE files SET cache_version = cache_version + 1 WHERE ${where} RETURNING cache_version`,
    params
  );
  return {
    cache_version: bumped[0] ? bumped[0].cache_version : null,
    objects_removed: removed,
    purged: bumped.length > 0,
  };
}

module.exports = {
  CACHE_PREFIX,
  cacheStorageKey,
  rawVariantKey,
  namedVariantKey,
  lookup,
  store,
  purge,
};
