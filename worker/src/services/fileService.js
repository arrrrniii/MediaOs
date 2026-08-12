const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sharp = require('sharp');
const { query, withTransaction } = require('../db');
const { processImage, isAnimatedGif } = require('./imageProcessor');
const { getVideoDuration, cleanup, tmpPath } = require('./videoProcessor');
const { slugify } = require('../utils/slugify');
const { detectFileType, isDangerous, sanitizeSvg, svgHasActiveContent } = require('../utils/fileType');
const { trackUpload, trackDelete } = require('./usageService');
const outboxService = require('./outboxService');
const fileObjectService = require('./fileObjectService');
const storageBackendService = require('./storageBackendService');
const { addJob, QUEUES } = require('../queue');
const config = require('../config');

const ACCESS_LEVELS = ['public', 'private', 'signed'];
const ORIGINAL_POLICIES = ['keep', 'archive', 'temporary', 'discard'];

// Decompression-bomb guards, applied to image metadata before any pixel work.
const MAX_IMAGE_PIXELS = parseInt(process.env.MAX_IMAGE_PIXELS || '50000000', 10);
const MAX_IMAGE_DIMENSION = parseInt(process.env.MAX_IMAGE_DIMENSION || '16383', 10);

const DAY_MS = 24 * 60 * 60 * 1000;

function nanoid(size = 6) {
  return crypto.randomBytes(size).toString('hex').substring(0, size);
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Streamed hash for on-disk renditions (video), so large files are not
// buffered into memory just to checksum them.
function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

function sanitizeFolder(folder) {
  if (!folder) return null;
  const sanitized = folder
    .replace(/[^a-zA-Z0-9_\-\/]/g, '')
    .replace(/\.{2,}/g, '')
    .replace(/^\/|\/$/g, '');
  return sanitized || null;
}

function buildStorageKey(projectId, folder, slug, ext) {
  const parts = [projectId];
  if (folder) parts.push(folder);
  parts.push(`${slug}-${nanoid()}.${ext}`);
  return parts.join('/');
}

function buildUrls(publicUrl, projectId, storageKey, type) {
  const fileUrl = `${publicUrl}/f/${storageKey}`;
  const urls = { original: fileUrl };

  if (type === 'image') {
    urls.thumb = `${publicUrl}/img/fit/200/200/f/${storageKey}`;
    urls.sm = `${publicUrl}/img/fit/400/0/f/${storageKey}`;
    urls.md = `${publicUrl}/img/fit/800/0/f/${storageKey}`;
    urls.lg = `${publicUrl}/img/fit/1200/0/f/${storageKey}`;
  }

  return urls;
}

function uploadError(status, code, message) {
  const err = new Error(message);
  err.status = status;
  err.code = code;
  return err;
}

function resolveAccess(options, project) {
  const requested = options.access;
  if (requested !== undefined && requested !== null && requested !== '') {
    if (!ACCESS_LEVELS.includes(requested)) {
      throw uploadError(400, 'INVALID_ACCESS', 'Invalid access level. Use: public, private, signed');
    }
    return requested;
  }
  const fallback = project.settings?.default_access;
  return ACCESS_LEVELS.includes(fallback) ? fallback : 'public';
}

/**
 * Original-preservation policy for a project. Lives in
 * project.settings.original_policy; missing/invalid fields fall back to the
 * defaults, and the 'discard' default reproduces the legacy behaviour
 * (optimized copy only, no source kept).
 */
function getOriginalPolicy(project) {
  // Accept two shapes so the setting is forgiving of how it was written:
  //   settings.original_policy = "keep"                       (bare mode string)
  //   settings.original_policy = { original_policy: "keep", … } (policy object)
  // In the string form, the sibling fields live directly on settings.
  const raw = project.settings?.original_policy;
  const isString = typeof raw === 'string';
  const p = isString ? {} : (raw || {});
  const container = isString ? (project.settings || {}) : p;

  const modeValue = isString ? raw : p.original_policy;
  const mode = ORIGINAL_POLICIES.includes(modeValue) ? modeValue : 'discard';
  const days = Number.isFinite(container.archive_original_after_days)
    ? container.archive_original_after_days
    : 30;
  return {
    mode,
    archiveAfterDays: days,
    optimizedFormats: Array.isArray(container.optimized_formats) ? container.optimized_formats : ['webp'],
    preserveMetadata: container.preserve_metadata === true,
  };
}

function assertTypeAllowed(project, category) {
  const allowed = project.settings?.allowed_types;
  if (!Array.isArray(allowed) || allowed.length === 0) return;
  // Audio has always been recorded under the generic "file" type, so a project
  // that allows "file" still accepts audio.
  const accepted = category === 'audio' ? ['audio', 'file'] : [category];
  if (!accepted.some((c) => allowed.includes(c))) {
    throw uploadError(400, 'TYPE_NOT_ALLOWED', `File type "${category}" is not allowed for this project`);
  }
}

function assertWithinSizeLimit(project, size) {
  const limit = project.settings?.max_file_size || config.maxFileSize;
  if (limit && size > limit) {
    throw uploadError(413, 'FILE_TOO_LARGE', `File exceeds the ${limit} byte limit for this project`);
  }
}

// Reads dimensions from the header only; sharp does not decode pixels for metadata().
async function imageMetadataWithinLimits(buffer) {
  let metadata;
  try {
    metadata = await sharp(buffer).metadata();
  } catch {
    return null;
  }
  const width = metadata?.width;
  const height = metadata?.height;
  if (!width || !height) return metadata || null;

  if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
    throw uploadError(400, 'IMAGE_TOO_LARGE', `Image exceeds the maximum dimension of ${MAX_IMAGE_DIMENSION}px`);
  }
  if (width * height > MAX_IMAGE_PIXELS) {
    throw uploadError(400, 'IMAGE_TOO_LARGE', `Image exceeds the maximum of ${MAX_IMAGE_PIXELS} pixels`);
  }
  return metadata;
}

/**
 * Decide what we are actually storing, from the bytes rather than from the
 * client-supplied mimetype or filename. SVG is the one type allowed through
 * the dangerous-content gate, and only after its active content is stripped.
 */
function inspectUpload(buffer, originalName) {
  const detected = detectFileType(buffer, originalName);

  if (detected.mime === 'image/svg+xml') {
    const sanitized = sanitizeSvg(buffer);
    if (svgHasActiveContent(sanitized)) {
      throw uploadError(400, 'DANGEROUS_FILE_TYPE', 'SVG contains active content that could not be removed');
    }
    return { detected, buffer: sanitized };
  }

  if (isDangerous(buffer, detected.mime)) {
    throw uploadError(400, 'DANGEROUS_FILE_TYPE', 'This file type cannot be served safely and was rejected');
  }

  return { detected, buffer };
}

/**
 * Confirm bytes actually landed in storage at the expected size before we
 * mark an object available. A mismatch means a truncated/failed write and
 * fails the whole upload rather than recording a corrupt object.
 */
async function verifyStoredObject(client, storageKey, expectedSize) {
  let stat;
  try {
    stat = await client.statObject(storageKey);
  } catch {
    throw uploadError(500, 'STORAGE_VERIFY_FAILED', 'Stored object could not be verified after write');
  }
  if (
    expectedSize != null &&
    typeof stat?.size === 'number' &&
    stat.size !== expectedSize
  ) {
    throw uploadError(500, 'STORAGE_VERIFY_FAILED', 'Stored object size does not match the uploaded bytes');
  }
}

async function uploadFile(file, project, options = {}, queue = null) {
  const start = Date.now();
  const access = resolveAccess(options, project);
  const slug = slugify(options.name || file.originalname);
  const folder = sanitizeFolder(options.folder);
  const policy = getOriginalPolicy(project);

  const { detected, buffer } = inspectUpload(file.buffer, file.originalname);
  const ext = detected.ext;
  const originalSize = file.buffer.length;

  assertWithinSizeLimit(project, buffer.length);
  assertTypeAllowed(project, detected.category);

  const backend = await storageBackendService.getDefaultBackend();
  const client = storageBackendService.getBackendClient(backend);

  if (detected.category === 'image') {
    // SVG is stored as sanitized source; rasterizing it would lose its point.
    // The stored object *is* the source, so it is recorded with role 'source'.
    if (detected.mime === 'image/svg+xml') {
      const storageKey = buildStorageKey(project.id, folder, slug, 'svg');
      let metadata = null;
      try {
        metadata = await sharp(buffer).metadata();
      } catch { /* dimensions are optional for SVG */ }
      const checksum = sha256(buffer);

      await client.putBuffer(storageKey, buffer, 'image/svg+xml');
      await verifyStoredObject(client, storageKey, buffer.length);

      const processingMs = Date.now() - start;
      return finalizeSyncUpload({
        projectId: project.id,
        backend,
        fileData: {
          projectId: project.id, storageKey, filename: path.basename(storageKey),
          originalName: file.originalname, folder, type: 'image', mimeType: 'image/svg+xml',
          size: buffer.length, originalSize, checksum,
          width: metadata?.width || null, height: metadata?.height || null,
          status: 'done', processingMs, access, uploadedBy: options.apiKeyId,
        },
        pendingObjects: [{
          role: 'source', storageKey, mimeType: 'image/svg+xml', size: buffer.length,
          checksum, width: metadata?.width, height: metadata?.height,
        }],
      });
    }

    const imageMetadata = await imageMetadataWithinLimits(buffer);

    // Animated GIF -> store as-is (preserve animation). The stored object is
    // the source; nothing is optimized.
    const animated = detected.mime === 'image/gif' && await isAnimatedGif(buffer);
    if (animated) {
      const storageKey = buildStorageKey(project.id, folder, slug, 'gif');
      const checksum = sha256(buffer);

      await client.putBuffer(storageKey, buffer, 'image/gif');
      await verifyStoredObject(client, storageKey, buffer.length);

      const processingMs = Date.now() - start;
      return finalizeSyncUpload({
        projectId: project.id,
        backend,
        fileData: {
          projectId: project.id, storageKey, filename: path.basename(storageKey),
          originalName: file.originalname, folder, type: 'image', mimeType: 'image/gif',
          size: buffer.length, originalSize, checksum,
          width: imageMetadata?.width || null, height: imageMetadata?.height || null,
          status: 'done', processingMs, access, uploadedBy: options.apiKeyId,
        },
        pendingObjects: [{
          role: 'source', storageKey, mimeType: 'image/gif', size: buffer.length,
          checksum, width: imageMetadata?.width, height: imageMetadata?.height,
        }],
      });
    }

    // Regular image -> WebP. The WebP is the optimized/canonical object; the
    // pre-optimization bytes are the source, preserved when policy != discard.
    const result = await processImage(buffer, {
      maxWidth: project.settings?.max_width || config.maxWidth,
      maxHeight: project.settings?.max_height || config.maxHeight,
      quality: project.settings?.webp_quality || config.webpQuality,
    });

    const sourceChecksum = sha256(buffer);
    const optimizedChecksum = sha256(result.buffer);
    const keepSource = policy.mode !== 'discard';

    const pendingObjects = [];
    let retentionUntil = null;

    if (keepSource) {
      const srcExt = (ext || '').replace(/^\./, '') || 'bin';
      const sourceKey = buildStorageKey(project.id, folder, slug, srcExt);
      const sourceMeta = {};
      if (policy.mode === 'archive') {
        // Movement to a cold tier is Phase 5/6; here we only record intent.
        sourceMeta.archive_after = new Date(Date.now() + policy.archiveAfterDays * DAY_MS).toISOString();
      }
      if (policy.mode === 'temporary') {
        retentionUntil = new Date(Date.now() + policy.archiveAfterDays * DAY_MS);
        sourceMeta.delete_after = retentionUntil.toISOString();
      }

      await client.putBuffer(sourceKey, buffer, detected.mime);
      await verifyStoredObject(client, sourceKey, buffer.length);
      pendingObjects.push({
        role: 'source', storageKey: sourceKey, mimeType: detected.mime, size: buffer.length,
        checksum: sourceChecksum, width: imageMetadata?.width, height: imageMetadata?.height, metadata: sourceMeta,
      });
    }

    const storageKey = buildStorageKey(project.id, folder, slug, 'webp');
    await client.putBuffer(storageKey, result.buffer, 'image/webp');
    await verifyStoredObject(client, storageKey, result.size);
    pendingObjects.push({
      role: 'optimized', storageKey, mimeType: 'image/webp', size: result.size,
      checksum: optimizedChecksum, width: result.width, height: result.height,
    });

    // files.checksum is the source/canonical checksum: the source when kept,
    // otherwise the canonical optimized rendition.
    const canonicalChecksum = keepSource ? sourceChecksum : optimizedChecksum;

    const processingMs = Date.now() - start;
    return finalizeSyncUpload({
      projectId: project.id,
      backend,
      fileData: {
        projectId: project.id, storageKey, filename: path.basename(storageKey),
        originalName: file.originalname, folder, type: 'image', mimeType: 'image/webp',
        size: result.size, originalSize, width: result.width, checksum: canonicalChecksum,
        height: result.height, status: 'done', processingMs, access, uploadedBy: options.apiKeyId,
        retentionUntil,
      },
      pendingObjects,
    });
  }

  if (detected.category === 'video') {
    // Store temp original, return 202, enqueue durable processing. Physical
    // objects (mp4 rendition + thumbnail) are recorded when processing
    // completes. The files row + the file.uploaded outbox event commit
    // atomically, then the media job is enqueued into BullMQ. Because the
    // job is durable in Redis (and the file is 'processing' in Postgres),
    // a worker restart resumes processing rather than losing the upload.
    const passthrough = detected.mime === 'video/mp4';
    const storageKey = buildStorageKey(project.id, folder, slug, 'mp4');
    const tempKey = `_processing_${crypto.randomBytes(8).toString('hex')}${ext}`;

    // Store temp in MinIO
    await client.putBuffer(tempKey, buffer, detected.mime);

    const processingMs = Date.now() - start;
    const { row, response } = await withTransaction(async (txClient) => {
      const row = await insertFileRecord({
        projectId: project.id, storageKey, filename: path.basename(storageKey),
        originalName: file.originalname, folder, type: 'video', mimeType: 'video/mp4',
        size: 0, originalSize, status: 'processing',
        processingMs, access, uploadedBy: options.apiKeyId,
      }, txClient);
      const response = formatResponse(row, project.id, []);
      await outboxService.emitEvent(txClient, {
        aggregateType: 'file', aggregateId: row.id, eventType: 'file.uploaded', payload: response,
      });
      return { row, response };
    });

    // Enqueue processing. With Redis/BullMQ active this is a durable job whose
    // jobId `media:<fileId>` is the idempotency key — the same asset can never
    // be enqueued twice. Fire-and-forget so a transient Redis hiccup doesn't
    // fail the already-committed upload; the reconciler (Phase 6/7)
    // re-enqueues stuck 'processing' files.
    const jobData = {
      fileId: row.id,
      projectId: project.id,
      tempKey,
      finalKey: storageKey,
      kind: passthrough ? 'video_passthrough' : 'video',
    };
    const queueModule = require('../queue');
    if (queueModule.isEnabled()) {
      addJob(QUEUES.MEDIA, 'process', jobData, { jobId: `media:${row.id}` }).catch((err) => {
        console.error(`Failed to enqueue media job for ${row.id}:`, err.message);
      });
    } else if (queue) {
      // Single-node fallback (no Redis): process in-process via the legacy
      // in-memory queue. Durability guarantees don't apply in this mode.
      queue.enqueue(row.id, async () => {
        const { processMediaJob } = require('../queue/processors/media');
        await processMediaJob(jobData);
      }).catch((err) => {
        console.error(`In-memory media processing failed for ${row.id}:`, err.message);
      });
    }

    trackUpload(project.id, originalSize).catch(() => {});
    return { ...response, _statusCode: 202 };
  }

  if (detected.category === 'audio') {
    // Store as-is, extract duration. The stored object is the source.
    const storageKey = buildStorageKey(project.id, folder, slug, ext.substring(1));
    const checksum = sha256(buffer);
    await client.putBuffer(storageKey, buffer, detected.mime);
    await verifyStoredObject(client, storageKey, buffer.length);

    // Try to get duration
    let duration = null;
    try {
      const tempPath = tmpPath(ext);
      await fs.promises.writeFile(tempPath, buffer);
      duration = await getVideoDuration(tempPath);
      cleanup(tempPath);
    } catch { /* noop */ }

    const processingMs = Date.now() - start;
    return finalizeSyncUpload({
      projectId: project.id,
      backend,
      fileData: {
        projectId: project.id, storageKey, filename: path.basename(storageKey),
        originalName: file.originalname, folder, type: 'file', mimeType: detected.mime,
        size: buffer.length, originalSize, duration, checksum,
        status: 'done', processingMs, access, uploadedBy: options.apiKeyId,
      },
      pendingObjects: [{
        role: 'source', storageKey, mimeType: detected.mime, size: buffer.length, checksum,
      }],
    });
  }

  // Generic file — store as-is. The stored object is the source.
  const storageKey = buildStorageKey(project.id, folder, slug, ext.substring(1) || 'bin');
  const checksum = sha256(buffer);
  await client.putBuffer(storageKey, buffer, detected.mime);
  await verifyStoredObject(client, storageKey, buffer.length);

  const processingMs = Date.now() - start;
  return finalizeSyncUpload({
    projectId: project.id,
    backend,
    fileData: {
      projectId: project.id, storageKey, filename: path.basename(storageKey),
      originalName: file.originalname, folder, type: 'file', mimeType: detected.mime,
      size: buffer.length, originalSize, checksum,
      status: 'done', processingMs, access, uploadedBy: options.apiKeyId,
    },
    pendingObjects: [{
      role: 'source', storageKey, mimeType: detected.mime, size: buffer.length, checksum,
    }],
  });
}

/**
 * Store a file_objects row and return the response-shaped summary. Errors
 * are swallowed so a bookkeeping failure never loses the already-stored
 * bytes; the returned summary is still built from the known values. Pass a
 * transaction `client` to record the object atomically with the files row.
 */
async function recordObject(fileId, backend, o, client = null) {
  const summary = {
    role: o.role,
    storage_key: o.storageKey,
    mime_type: o.mimeType,
    size: o.size || 0,
    checksum: o.checksum || null,
    storage_tier: o.tier || 'hot',
    status: 'available',
  };
  try {
    await fileObjectService.createObject({
      fileId,
      role: o.role,
      backendId: backend.id,
      storageKey: o.storageKey,
      mimeType: o.mimeType,
      size: o.size || 0,
      checksum: o.checksum || null,
      tier: o.tier || 'hot',
      status: 'available',
      width: o.width,
      height: o.height,
      metadata: o.metadata,
    }, client);
  } catch (err) {
    console.error(`Failed to record file_object for ${fileId} (${o.role}):`, err.message);
  }
  return summary;
}

/**
 * Commit a finished synchronous upload atomically: the files row, its
 * file_objects, and the outbox event all commit in one transaction, so the
 * event can never fire for a file that failed to persist (and vice versa).
 * Storage counters and usage tracking run after the commit — they are
 * derived bookkeeping, not part of the atomic unit.
 *
 * @returns the API response object.
 */
async function finalizeSyncUpload({ projectId, fileData, pendingObjects, backend, eventType = 'file.uploaded' }) {
  const { recorded, response } = await withTransaction(async (client) => {
    const row = await insertFileRecord(fileData, client);
    const recorded = [];
    for (const o of pendingObjects) {
      recorded.push(await recordObject(row.id, backend, o, client));
    }
    const response = formatResponse(row, projectId, recorded);
    await outboxService.emitEvent(client, {
      aggregateType: 'file',
      aggregateId: row.id,
      eventType,
      payload: response,
    });
    return { recorded, response };
  });

  const storedBytes = sumObjectBytes(recorded);
  await updateProjectCounters(projectId, storedBytes);
  trackUpload(projectId, storedBytes).catch(() => {});
  return response;
}

function sumObjectBytes(objects) {
  return objects.reduce((total, o) => total + (o.size || 0), 0);
}

async function insertFileRecord(data, client = null) {
  const exec = client ? (text, params) => client.query(text, params) : query;
  const { rows } = await exec(
    `INSERT INTO files (project_id, storage_key, filename, original_name, folder, type, mime_type,
     size, original_size, width, height, duration, thumbnail_key, status, processing_ms, access,
     uploaded_by, checksum, retention_until)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     RETURNING *`,
    [
      data.projectId, data.storageKey, data.filename, data.originalName, data.folder,
      data.type, data.mimeType, data.size, data.originalSize, data.width || null,
      data.height || null, data.duration || null, data.thumbnailKey || null,
      data.status, data.processingMs, data.access, data.uploadedBy || null,
      data.checksum || null, data.retentionUntil || null,
    ]
  );
  return rows[0];
}

async function updateProjectCounters(projectId, sizeChange, { incrementFileCount = true } = {}) {
  const fileCountDelta = incrementFileCount ? 1 : 0;
  await query(
    'UPDATE projects SET storage_used = storage_used + $1, file_count = file_count + $2 WHERE id = $3',
    [sizeChange, fileCountDelta, projectId]
  ).catch(() => {});
}

/**
 * @param {object[]} [objects] physical objects backing the file, in the
 *   response shape { role, storage_key, size, mime_type, storage_tier|tier,
 *   status, checksum }. Included as `objects`; a `source_url` is added when a
 *   'source' object exists.
 */
function formatResponse(row, projectId, objects = []) {
  const urls = buildUrls(config.publicUrl, projectId, row.storage_key, row.type);

  const objectList = (objects || []).map((o) => ({
    role: o.role,
    storage_key: o.storage_key,
    size: typeof o.size === 'string' ? parseInt(o.size, 10) : (o.size || 0),
    mime_type: o.mime_type,
    tier: o.storage_tier || o.tier || 'hot',
    status: o.status || 'available',
    checksum: o.checksum || null,
  }));

  const source = objectList.find((o) => o.role === 'source');

  return {
    id: row.id,
    project_id: projectId,
    filename: row.filename,
    url: urls.original,
    storage_key: row.storage_key,
    urls,
    type: row.type,
    mime_type: row.mime_type,
    size: row.size,
    original_size: row.original_size,
    width: row.width || undefined,
    height: row.height || undefined,
    duration: row.duration || undefined,
    thumbnail_url: row.thumbnail_key
      ? `${config.publicUrl}/f/${row.thumbnail_key}`
      : undefined,
    source_url: source ? `${config.publicUrl}/f/${source.storage_key}` : undefined,
    objects: objectList,
    access: row.access,
    status: row.status,
    processing_ms: row.processing_ms,
    created_at: row.created_at,
  };
}

async function deleteFile(fileId, project) {
  const { rows } = await query(
    'SELECT * FROM files WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL',
    [fileId, project.id]
  );

  if (rows.length === 0) return null;

  const file = rows[0];

  // Gather every physical object so we can remove all copies, not just the
  // legacy canonical key. Older rows (pre-backfill) have no objects; fall
  // back to the legacy storage_key/thumbnail_key.
  let objects = [];
  try {
    objects = await fileObjectService.listObjects(fileId);
  } catch { /* fall back to legacy keys below */ }

  // Soft delete + emit file.deleted atomically: the tombstone and the event
  // commit together, so a crash can neither drop the event for a completed
  // delete nor fire it for a delete that rolled back.
  const deletedEvent = {
    id: file.id,
    filename: file.filename,
    storage_key: file.storage_key,
    type: file.type,
    size: file.size,
  };
  await withTransaction(async (client) => {
    await client.query('UPDATE files SET deleted_at = NOW() WHERE id = $1', [fileId]);
    await outboxService.emitEvent(client, {
      aggregateType: 'file', aggregateId: file.id, eventType: 'file.deleted', payload: deletedEvent,
    });
  });

  let freedBytes;
  if (objects.length > 0) {
    freedBytes = objects.reduce((t, o) => t + (parseInt(o.size, 10) || 0), 0);
    for (const o of objects) {
      const backend = await storageBackendService.getBackendById(o.storage_backend_id);
      const client = storageBackendService.getBackendClient(backend);
      client.removeObject(o.storage_key).catch(() => {});
    }
  } else {
    freedBytes = file.size;
    const client = storageBackendService.getBackendClient(await storageBackendService.getDefaultBackend());
    client.removeObject(file.storage_key).catch(() => {});
    if (file.thumbnail_key) {
      client.removeObject(file.thumbnail_key).catch(() => {});
    }
  }

  // Decrement counters
  await query(
    'UPDATE projects SET storage_used = GREATEST(0, storage_used - $1), file_count = GREATEST(0, file_count - 1) WHERE id = $2',
    [freedBytes, project.id]
  ).catch(() => {});

  // Track usage (the file.deleted event was already emitted atomically above)
  trackDelete(project.id).catch(() => {});

  return {
    deleted: true,
    id: file.id,
    storage_key: file.storage_key,
    freed_bytes: freedBytes,
  };
}

async function listFiles(project, options = {}) {
  const {
    page = 1,
    limit = 50,
    folder,
    type,
    search,
    sort = 'created_at',
    order = 'desc',
    status,
  } = options;

  const conditions = ['project_id = $1', 'deleted_at IS NULL'];
  const params = [project.id];

  if (folder) {
    params.push(folder);
    conditions.push(`folder = $${params.length}`);
  }
  if (type) {
    params.push(type);
    conditions.push(`type = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`status = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(filename ILIKE $${params.length} OR original_name ILIKE $${params.length})`);
  }

  const whereClause = 'WHERE ' + conditions.join(' AND ');

  // Validate sort column
  const allowedSorts = ['created_at', 'size', 'filename'];
  const sortCol = allowedSorts.includes(sort) ? sort : 'created_at';
  const sortOrder = order === 'asc' ? 'ASC' : 'DESC';

  const clampedLimit = Math.min(100, Math.max(1, parseInt(limit) || 50));
  const offset = (Math.max(1, parseInt(page) || 1) - 1) * clampedLimit;

  const countResult = await query(
    `SELECT COUNT(*) FROM files ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0].count);

  const dataParams = [...params, clampedLimit, offset];
  const { rows } = await query(
    `SELECT * FROM files ${whereClause}
     ORDER BY ${sortCol} ${sortOrder}
     LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
    dataParams
  );

  const data = [];
  for (const row of rows) {
    let objects = [];
    try {
      objects = await fileObjectService.listObjects(row.id);
    } catch { /* objects are optional in the list view */ }
    data.push(formatResponse(row, project.id, objects));
  }

  return {
    data,
    total,
    page: Math.max(1, parseInt(page) || 1),
    limit: clampedLimit,
  };
}

async function getFile(fileId, project) {
  const { rows } = await query(
    'SELECT * FROM files WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL',
    [fileId, project.id]
  );

  if (rows.length === 0) return null;

  let objects = [];
  try {
    objects = await fileObjectService.listObjects(fileId);
  } catch { /* objects are optional */ }
  return formatResponse(rows[0], project.id, objects);
}

module.exports = {
  uploadFile,
  deleteFile,
  listFiles,
  getFile,
  ACCESS_LEVELS,
  // Exported for the BullMQ media processor, which reuses these rather than
  // duplicating rendition bookkeeping.
  formatResponse,
  recordObject,
  updateProjectCounters,
  sha256File,
};
