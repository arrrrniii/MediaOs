/**
 * One-time presigned direct uploads.
 *
 * A grant (direct_uploads row) authorizes exactly one PUT of one object
 * straight to the worker. The returned token is the only credential the PUT
 * needs; the grant binds the project, so the byte transfer carries no API key.
 * On PUT the bytes run through the SAME processing pipeline as a normal upload
 * (type detection, dual-write objects, checksum, dedup), and the grant is
 * marked completed with the resulting file_id. Single-use is enforced by an
 * atomic status claim.
 */

const crypto = require('crypto');
const { query } = require('../db');
const { sha256 } = require('../utils/crypto');
const fileService = require('./fileService');
const config = require('../config');

// How long a grant is valid before it must be re-requested.
const DEFAULT_GRANT_TTL_MS = parseInt(process.env.DIRECT_UPLOAD_TTL_MS || String(60 * 60 * 1000), 10);

function grantError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

/**
 * Create a one-time upload grant for a project. Returns the grant metadata plus
 * the raw token embedded in the upload URL (the token is only ever returned
 * here; only its hash is stored).
 */
async function createGrant(project, options = {}) {
  const maxBytes = options.maxBytes != null ? parseInt(options.maxBytes, 10) : (project.settings?.max_file_size || config.maxFileSize);
  const ttlMs = options.ttlMs != null ? Math.min(24 * 60 * 60 * 1000, Math.max(60 * 1000, parseInt(options.ttlMs, 10))) : DEFAULT_GRANT_TTL_MS;
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256(token);
  const expiresAt = new Date(Date.now() + ttlMs);

  const { rows } = await query(
    `INSERT INTO direct_uploads
       (project_id, token_hash, status, max_bytes, content_type, access, folder, idempotency_key, expires_at)
     VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7, $8)
     RETURNING id, created_at, expires_at`,
    [
      project.id, tokenHash, maxBytes || null, options.contentType || null,
      options.access || null, options.folder || null, options.idempotencyKey || null, expiresAt,
    ]
  );
  const row = rows[0];

  return {
    id: row.id,
    upload_url: `${config.publicUrl}/api/v1/uploads/direct/${token}`,
    method: 'PUT',
    max_bytes: maxBytes || null,
    content_type: options.contentType || null,
    access: options.access || null,
    folder: options.folder || null,
    expires_at: row.expires_at,
    created_at: row.created_at,
  };
}

/**
 * Consume a grant by its raw token: atomically claim it (single-use), run the
 * bytes through the upload pipeline, and mark it completed. Throws a 404/409/
 * 410/413 shaped error on missing/used/expired/oversize.
 */
async function consumeGrant(token, buffer, reqContentType) {
  const tokenHash = sha256(String(token || ''));

  // Load the grant. A missing token and a used/expired one are distinguished
  // so a client can tell "wrong token" from "already used".
  const { rows } = await query(
    `SELECT id, project_id, status, max_bytes, content_type, access, folder, idempotency_key, expires_at
     FROM direct_uploads WHERE token_hash = $1 LIMIT 1`,
    [tokenHash]
  );
  if (rows.length === 0) {
    throw grantError(404, 'GRANT_NOT_FOUND', 'Upload grant not found');
  }
  const grant = rows[0];

  if (grant.expires_at && new Date(grant.expires_at).getTime() < Date.now()) {
    await query("UPDATE direct_uploads SET status = 'expired' WHERE id = $1 AND status = 'pending'", [grant.id]).catch(() => {});
    throw grantError(410, 'GRANT_EXPIRED', 'Upload grant has expired');
  }
  if (grant.status !== 'pending') {
    throw grantError(409, 'GRANT_USED', 'Upload grant has already been used');
  }
  if (grant.max_bytes != null && buffer.length > parseInt(grant.max_bytes, 10)) {
    throw grantError(413, 'FILE_TOO_LARGE', `File exceeds the grant limit of ${grant.max_bytes} bytes`);
  }

  // Atomically claim the grant so two concurrent PUTs can never both process.
  const claim = await query(
    "UPDATE direct_uploads SET status = 'aborted' WHERE id = $1 AND status = 'pending' RETURNING id",
    [grant.id]
  );
  if (claim.rowCount !== 1) {
    throw grantError(409, 'GRANT_USED', 'Upload grant has already been used');
  }

  // Load the bound project.
  const { rows: projects } = await query(
    "SELECT * FROM projects WHERE id = $1 AND status = 'active'",
    [grant.project_id]
  );
  if (projects.length === 0) {
    throw grantError(403, 'PROJECT_INACTIVE', 'Project not found or inactive');
  }
  const project = projects[0];

  const filename = grant.content_type
    ? `upload.${(grant.content_type.split('/')[1] || 'bin')}`
    : 'upload';

  const result = await fileService.uploadFile(
    { buffer, originalname: filename },
    project,
    {
      folder: grant.folder || undefined,
      access: grant.access || undefined,
      idempotencyKey: grant.idempotency_key || undefined,
    }
  );

  // Mark the grant completed and attach the file.
  await query(
    "UPDATE direct_uploads SET status = 'completed', file_id = $2, completed_at = NOW() WHERE id = $1",
    [grant.id, result.id]
  ).catch(() => {});

  return result;
}

module.exports = {
  DEFAULT_GRANT_TTL_MS,
  createGrant,
  consumeGrant,
};
