/**
 * file_objects CRUD — the physical byte-copies backing a logical file.
 *
 * A logical `files` row can own several objects distinguished by role
 * (source, optimized, thumbnail, video renditions, poster, hls). Usage
 * accounting sums the sizes of ALL objects, since every copy consumes
 * real storage.
 */

const { query } = require('../db');

/**
 * Record a physical object for a file.
 * @param {object} o
 * @param {string} o.fileId
 * @param {string} o.role
 * @param {string} o.backendId   storage_backends.id
 * @param {string} o.storageKey
 * @param {string} o.mimeType
 * @param {number} [o.size]
 * @param {string} [o.checksum]
 * @param {string} [o.tier]      hot|warm|cold|archive
 * @param {string} [o.status]    pending|available|missing|corrupt
 * @param {number} [o.width]
 * @param {number} [o.height]
 * @param {object} [o.metadata]
 */
async function createObject(o) {
  const { rows } = await query(
    `INSERT INTO file_objects
       (file_id, role, storage_backend_id, storage_key, mime_type, size,
        checksum, storage_tier, status, width, height, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING *`,
    [
      o.fileId,
      o.role,
      o.backendId,
      o.storageKey,
      o.mimeType,
      o.size || 0,
      o.checksum || null,
      o.tier || 'hot',
      o.status || 'available',
      o.width || null,
      o.height || null,
      o.metadata ? JSON.stringify(o.metadata) : '{}',
    ]
  );
  return rows[0];
}

/** All objects for a file, oldest first. */
async function listObjects(fileId) {
  const { rows } = await query(
    `SELECT id, file_id, role, storage_backend_id, storage_key, mime_type, size,
            checksum, storage_tier, status, width, height, metadata, created_at, archived_at
     FROM file_objects WHERE file_id = $1 ORDER BY created_at ASC`,
    [fileId]
  );
  return rows;
}

/** The first object with the given role, or null. */
async function getObjectByRole(fileId, role) {
  const { rows } = await query(
    `SELECT id, file_id, role, storage_backend_id, storage_key, mime_type, size,
            checksum, storage_tier, status, width, height, metadata, created_at, archived_at
     FROM file_objects WHERE file_id = $1 AND role = $2 ORDER BY created_at ASC LIMIT 1`,
    [fileId, role]
  );
  return rows[0] || null;
}

/** Total bytes across every physical copy of a file. */
async function sumSizes(fileId) {
  const { rows } = await query(
    'SELECT COALESCE(SUM(size), 0) AS total FROM file_objects WHERE file_id = $1',
    [fileId]
  );
  return parseInt(rows[0]?.total || 0, 10);
}

/** Move an object between health states (available|pending|missing|corrupt). */
async function markStatus(objectId, status) {
  await query('UPDATE file_objects SET status = $1 WHERE id = $2', [status, objectId]);
}

module.exports = {
  createObject,
  listObjects,
  getObjectByRole,
  sumSizes,
  markStatus,
};
