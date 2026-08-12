/**
 * Resumable multipart uploads.
 *
 * Pragmatic chunked-upload path for the default MinIO backend: each part is
 * stored as a temporary object (_multipart/{sessionId}/{partNumber}); on
 * complete, the parts are fetched in order, concatenated, and run through the
 * SAME processing pipeline as a normal upload. Resume = GET the session to see
 * which parts landed and continue. Idempotency, expiry, and per-project
 * scoping mirror the normal upload path.
 *
 * A real S3 CreateMultipartUpload is intentionally not used: it buys nothing
 * for the local MinIO default and the assembled-buffer pipeline reuses all of
 * fileService's type detection, dedup, and dual-write bookkeeping unchanged.
 */

const { query } = require('../db');
const storageBackendService = require('./storageBackendService');
const fileService = require('./fileService');
const config = require('../config');

const DEFAULT_SESSION_TTL_MS = parseInt(process.env.MULTIPART_TTL_MS || String(24 * 60 * 60 * 1000), 10);
const RECOMMENDED_PART_SIZE = parseInt(process.env.MULTIPART_PART_SIZE || String(8 * 1024 * 1024), 10);
const MAX_PART_NUMBER = 10000;

function mpError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function tempPartKey(sessionId, partNumber) {
  return `_multipart/${sessionId}/${partNumber}`;
}

function sessionView(row) {
  const parts = Array.isArray(row.parts) ? row.parts : [];
  return {
    id: row.id,
    project_id: row.project_id,
    filename: row.filename,
    content_type: row.content_type,
    access: row.access,
    folder: row.folder,
    status: row.status,
    total_bytes: row.total_bytes != null ? parseInt(row.total_bytes, 10) : null,
    received_bytes: parseInt(row.received_bytes, 10) || 0,
    parts: parts
      .map((p) => ({ part_number: p.part_number, size: p.size }))
      .sort((a, b) => a.part_number - b.part_number),
    part_size: RECOMMENDED_PART_SIZE,
    file_id: row.file_id || null,
    created_at: row.created_at,
    expires_at: row.expires_at,
  };
}

/** Start a resumable upload session for a project. */
async function startSession(project, options = {}) {
  // Idempotency: a completed prior upload with the same key returns the file.
  if (options.idempotencyKey) {
    const existing = await fileService.findByIdempotencyKey(project.id, options.idempotencyKey);
    if (existing) {
      return { idempotent_replay: true, file: existing };
    }
  }

  const size = options.size != null ? parseInt(options.size, 10) : null;
  const limit = project.settings?.max_file_size || config.maxFileSize;
  if (size != null && limit && size > limit) {
    throw mpError(413, 'FILE_TOO_LARGE', `Declared size exceeds the ${limit} byte limit for this project`);
  }

  const expiresAt = new Date(Date.now() + DEFAULT_SESSION_TTL_MS);
  const { rows } = await query(
    `INSERT INTO upload_sessions
       (project_id, filename, content_type, access, folder, total_bytes, idempotency_key, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      project.id, options.filename || 'upload', options.contentType || null,
      options.access || null, options.folder || null, size, options.idempotencyKey || null, expiresAt,
    ]
  );
  return sessionView(rows[0]);
}

async function loadActiveSession(project, sessionId) {
  const { rows } = await query(
    'SELECT * FROM upload_sessions WHERE id = $1 AND project_id = $2 LIMIT 1',
    [sessionId, project.id]
  );
  // A session that belongs to another tenant reads as not found.
  if (rows.length === 0) throw mpError(404, 'SESSION_NOT_FOUND', 'Upload session not found');
  return rows[0];
}

/** Get a session's current state (for resume). */
async function getSession(project, sessionId) {
  const row = await loadActiveSession(project, sessionId);
  return sessionView(row);
}

/** Upload one part; idempotent by part number (re-uploading replaces it). */
async function uploadPart(project, sessionId, partNumber, buffer) {
  const n = parseInt(partNumber, 10);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PART_NUMBER) {
    throw mpError(400, 'INVALID_PART_NUMBER', `Part number must be 1..${MAX_PART_NUMBER}`);
  }
  if (!buffer || buffer.length === 0) {
    throw mpError(400, 'EMPTY_PART', 'Part body is empty');
  }

  const session = await loadActiveSession(project, sessionId);
  if (session.status !== 'active') {
    throw mpError(409, 'SESSION_NOT_ACTIVE', `Session is ${session.status}`);
  }
  if (session.expires_at && new Date(session.expires_at).getTime() < Date.now()) {
    await query("UPDATE upload_sessions SET status = 'expired' WHERE id = $1 AND status = 'active'", [session.id]).catch(() => {});
    throw mpError(410, 'SESSION_EXPIRED', 'Upload session has expired');
  }

  const backend = await storageBackendService.getDefaultBackend();
  const client = storageBackendService.getBackendClient(backend);
  const key = tempPartKey(session.id, n);
  await client.putBuffer(key, buffer, session.content_type || 'application/octet-stream');

  // Replace-or-insert this part in the jsonb array, then recompute received.
  const parts = Array.isArray(session.parts) ? session.parts.filter((p) => p.part_number !== n) : [];
  parts.push({ part_number: n, size: buffer.length, key });
  const receivedBytes = parts.reduce((t, p) => t + (p.size || 0), 0);

  await query(
    'UPDATE upload_sessions SET parts = $2, received_bytes = $3, updated_at = NOW() WHERE id = $1',
    [session.id, JSON.stringify(parts), receivedBytes]
  );

  return {
    part_number: n,
    size: buffer.length,
    received_bytes: receivedBytes,
  };
}

/** Assemble the parts and run the pipeline; then clean up temp objects. */
async function completeSession(project, sessionId) {
  const session = await loadActiveSession(project, sessionId);
  if (session.status === 'completed' && session.file_id) {
    const existing = await fileService.getFile(session.file_id, project);
    if (existing) return { file: existing, already_completed: true };
  }
  if (session.status !== 'active') {
    throw mpError(409, 'SESSION_NOT_ACTIVE', `Session is ${session.status}`);
  }
  const parts = Array.isArray(session.parts) ? [...session.parts] : [];
  if (parts.length === 0) {
    throw mpError(400, 'NO_PARTS', 'No parts have been uploaded');
  }
  parts.sort((a, b) => a.part_number - b.part_number);

  const limit = project.settings?.max_file_size || config.maxFileSize;
  const totalBytes = parts.reduce((t, p) => t + (p.size || 0), 0);
  if (limit && totalBytes > limit) {
    throw mpError(413, 'FILE_TOO_LARGE', `Assembled size exceeds the ${limit} byte limit for this project`);
  }

  const backend = await storageBackendService.getDefaultBackend();
  const client = storageBackendService.getBackendClient(backend);

  // Fetch and concatenate parts in order.
  const chunks = [];
  for (const p of parts) {
    const stream = await client.getObject(p.key);
    chunks.push(await streamToBuffer(stream));
  }
  const assembled = Buffer.concat(chunks);

  const result = await fileService.uploadFile(
    { buffer: assembled, originalname: session.filename || 'upload' },
    project,
    {
      folder: session.folder || undefined,
      access: session.access || undefined,
      idempotencyKey: session.idempotency_key || undefined,
    }
  );

  await query(
    "UPDATE upload_sessions SET status = 'completed', file_id = $2, received_bytes = $3, updated_at = NOW() WHERE id = $1",
    [session.id, result.id, totalBytes]
  ).catch(() => {});

  // Best-effort temp cleanup.
  for (const p of parts) {
    client.removeObject(p.key).catch(() => {});
  }

  return { file: result };
}

/** Abort a session and delete its temp parts. */
async function abortSession(project, sessionId) {
  const session = await loadActiveSession(project, sessionId);
  const parts = Array.isArray(session.parts) ? session.parts : [];
  if (session.status === 'active') {
    await query("UPDATE upload_sessions SET status = 'aborted', updated_at = NOW() WHERE id = $1", [session.id]);
  }
  const backend = await storageBackendService.getDefaultBackend();
  const client = storageBackendService.getBackendClient(backend);
  for (const p of parts) {
    client.removeObject(p.key).catch(() => {});
  }
  return { aborted: true, id: session.id };
}

function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

module.exports = {
  DEFAULT_SESSION_TTL_MS,
  RECOMMENDED_PART_SIZE,
  MAX_PART_NUMBER,
  startSession,
  getSession,
  uploadPart,
  completeSession,
  abortSession,
  sessionView,
};
