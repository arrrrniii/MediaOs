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
const transformCacheService = require('./transformCacheService');
const { generateTransform } = require('./signedUrl');
const { addJob, QUEUES } = require('../queue');
const config = require('../config');

// Default responsive widths for srcset generation.
const SRCSET_WIDTHS = [320, 640, 960, 1280, 1600];

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

/**
 * Idempotency: a completed prior upload with the same (project,
 * idempotency_key) short-circuits a re-upload and returns the existing file.
 * The key→file mapping is recorded as a 'completed' direct_uploads row, so the
 * same table backs both normal and direct-upload idempotency.
 */
async function findByIdempotencyKey(projectId, key) {
  if (!key) return null;
  const { rows } = await query(
    `SELECT file_id FROM direct_uploads
     WHERE project_id = $1 AND idempotency_key = $2 AND status = 'completed' AND file_id IS NOT NULL
     ORDER BY completed_at DESC NULLS LAST LIMIT 1`,
    [projectId, key]
  );
  if (rows.length === 0 || !rows[0].file_id) return null;
  return getFile(rows[0].file_id, { id: projectId });
}

async function recordIdempotency(projectId, key, fileId) {
  if (!key) return;
  await query(
    `INSERT INTO direct_uploads (project_id, token_hash, status, idempotency_key, file_id, completed_at)
     VALUES ($1, $2, 'completed', $3, $4, NOW())`,
    [projectId, crypto.randomBytes(32).toString('hex'), key, fileId]
  ).catch(() => {});
}

/**
 * Find a live file in the same project whose SOURCE bytes match (by
 * content_hash) and whose access level matches. Access must match so a
 * deduped logical file — which shares the canonical file's storage_key — can
 * never expose bytes at a different access level. Returns the CANONICAL file
 * row (following an existing dedup_of so chains collapse to one root).
 */
async function findDedupTarget(projectId, contentHash, access) {
  if (!contentHash) return null;
  const { rows } = await query(
    `SELECT id, project_id, storage_key, thumbnail_key, type, mime_type, size, width, height,
            checksum, content_hash, access, dedup_of
     FROM files
     WHERE project_id = $1 AND content_hash = $2 AND access = $3 AND deleted_at IS NULL
     ORDER BY (dedup_of IS NULL) DESC, created_at ASC
     LIMIT 1`,
    [projectId, contentHash, access]
  );
  if (rows.length === 0) return null;
  const match = rows[0];
  if (match.dedup_of) {
    // Collapse to the root canonical file so dedup_of never points at another
    // deduped row.
    const { rows: root } = await query(
      `SELECT id, project_id, storage_key, thumbnail_key, type, mime_type, size, width, height,
              checksum, content_hash, access, dedup_of
       FROM files WHERE id = $1 AND deleted_at IS NULL LIMIT 1`,
      [match.dedup_of]
    );
    if (root.length > 0) return root[0];
  }
  return match;
}

/**
 * Create a deduped logical file that reuses an existing file's physical bytes.
 * No bytes are stored and no file_objects rows are created — the new row
 * points at the canonical storage_key and records dedup_of. Storage counters
 * still count the logical size (the customer is billed as if they uploaded
 * it); metadata records the bytes dedup saved.
 */
async function createDedupedFile({ project, target, options, originalName, originalSize, folder, access }) {
  const slug = slugify(options.name || originalName);
  const filename = path.basename(target.storage_key);
  const savedBytes = parseInt(target.size, 10) || 0;

  const response = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO files (project_id, storage_key, filename, original_name, folder, type, mime_type,
        size, original_size, width, height, status, processing_ms, access, uploaded_by,
        checksum, content_hash, dedup_of, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'done', 0, $12, $13, $14, $15, $16, $17)
       RETURNING *`,
      [
        project.id, target.storage_key, filename, originalName, folder, target.type, target.mime_type,
        target.size, originalSize, target.width || null, target.height || null,
        access, options.apiKeyId || null, target.checksum || null, target.content_hash || null,
        target.id, JSON.stringify({ deduped: true, dedup_of: target.id, dedup_saved_bytes: savedBytes }),
      ]
    );
    const row = rows[0];
    const resp = formatResponse(row, project.id, []);
    resp.deduped = true;
    resp.dedup_of = target.id;
    await outboxService.emitEvent(client, {
      aggregateType: 'file', aggregateId: row.id, eventType: 'file.uploaded', payload: resp,
    });
    return resp;
  });

  // Bill the logical size even though no new bytes were stored.
  await updateProjectCounters(project.id, savedBytes);
  trackUpload(project.id, savedBytes).catch(() => {});
  return response;
}

/**
 * Public entry point: handles idempotency (return an existing file for a
 * repeated key) and records the key→file mapping after a successful upload,
 * then delegates the actual storage/processing to _uploadFileImpl.
 */
async function uploadFile(file, project, options = {}, queue = null) {
  if (options.idempotencyKey) {
    const existing = await findByIdempotencyKey(project.id, options.idempotencyKey);
    if (existing) return { ...existing, idempotent_replay: true };
  }
  const result = await _uploadFileImpl(file, project, options, queue);
  if (options.idempotencyKey && result && result.id) {
    await recordIdempotency(project.id, options.idempotencyKey, result.id);
  }
  return result;
}

async function _uploadFileImpl(file, project, options = {}, queue = null) {
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

  // Content dedup — non-video only (video is stored async and owned by the
  // Phase-8b pipeline). If another live file in this project already holds the
  // same source bytes at the same access level, reuse its physical objects.
  if (detected.category !== 'video') {
    const contentHash = sha256(buffer);
    const target = await findDedupTarget(project.id, contentHash, access);
    if (target) {
      return createDedupedFile({
        project, target, options, originalName: file.originalname,
        originalSize, folder, access,
      });
    }
  }

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
      // Strip EXIF/metadata from the optimized output unless the project's
      // original-preservation policy asks to keep it. The preserved SOURCE
      // object (below) always retains its metadata.
      preserveMetadata: policy.preserveMetadata,
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
        contentHash: sourceChecksum,
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
  // content_hash is the checksum of the SOURCE bytes (the dedup key); it may
  // equal files.checksum, or differ when the source is discarded and checksum
  // becomes the optimized rendition's hash.
  const contentHash = data.contentHash || data.checksum || null;
  const { rows } = await exec(
    `INSERT INTO files (project_id, storage_key, filename, original_name, folder, type, mime_type,
     size, original_size, width, height, duration, thumbnail_key, status, processing_ms, access,
     uploaded_by, checksum, retention_until, content_hash, dedup_of)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)
     RETURNING *`,
    [
      data.projectId, data.storageKey, data.filename, data.originalName, data.folder,
      data.type, data.mimeType, data.size, data.originalSize, data.width || null,
      data.height || null, data.duration || null, data.thumbnailKey || null,
      data.status, data.processingMs, data.access, data.uploadedBy || null,
      data.checksum || null, data.retentionUntil || null, contentHash, data.dedupOf || null,
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

  // The physical bytes for a deduped file live under its canonical file's
  // storage keys. Reference-safe delete: bytes are only removed once no live
  // file still references the canonical object set.
  const canonicalId = file.dedup_of || file.id;

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

  // After the tombstone commits, count files still referencing the canonical
  // bytes (the canonical row itself, or any dedup pointing at it). Zero means
  // this delete freed the last reference and the physical objects can go.
  const { rows: refRows } = await query(
    `SELECT COUNT(*)::int AS n FROM files
     WHERE deleted_at IS NULL AND (id = $1 OR dedup_of = $1)`,
    [canonicalId]
  );
  const liveRefs = refRows[0] ? refRows[0].n : 0;

  // Logical decrement mirrors the logical size billed on upload.
  let freedBytes = parseInt(file.size, 10) || 0;

  if (liveRefs === 0) {
    // Safe to remove the canonical's physical objects — this file is either
    // the canonical itself or the last dependent still standing.
    let objects = [];
    try {
      objects = await fileObjectService.listObjects(canonicalId);
    } catch { /* fall back to legacy keys below */ }

    if (objects.length > 0) {
      // When deleting a canonical file directly, prefer the physical object
      // sum for the counter (preserves the pre-dedup accounting).
      if (!file.dedup_of) {
        freedBytes = objects.reduce((t, o) => t + (parseInt(o.size, 10) || 0), 0);
      }
      for (const o of objects) {
        const backend = await storageBackendService.getBackendById(o.storage_backend_id);
        const client = storageBackendService.getBackendClient(backend);
        client.removeObject(o.storage_key).catch(() => {});
      }
    } else {
      // Legacy fallback: remove by the canonical file's storage_key.
      let canonicalKey = file.storage_key;
      let canonicalThumb = file.thumbnail_key;
      if (canonicalId !== file.id) {
        const { rows: cr } = await query(
          'SELECT storage_key, thumbnail_key FROM files WHERE id = $1',
          [canonicalId]
        );
        if (cr.length > 0) {
          canonicalKey = cr[0].storage_key;
          canonicalThumb = cr[0].thumbnail_key;
        }
      }
      const client = storageBackendService.getBackendClient(await storageBackendService.getDefaultBackend());
      if (canonicalKey) client.removeObject(canonicalKey).catch(() => {});
      if (canonicalThumb) client.removeObject(canonicalThumb).catch(() => {});
    }

    // Cached transforms belong to the canonical file; purge them too.
    transformCacheService.purge(canonicalId, project.id).catch(() => {});
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

/**
 * Build a responsive srcset for an image file. Public files get plain /img
 * URLs; private/signed files get per-width SIGNED transform URLs so each
 * candidate is independently fetchable. Returns { widths, sizes, srcset, urls }.
 * `project` must include signing_secret for signed URLs.
 */
function buildSrcset(project, file, options = {}) {
  const widths = Array.isArray(options.widths) && options.widths.length
    ? options.widths.filter((w) => Number.isInteger(w) && w > 0 && w <= 8192)
    : SRCSET_WIDTHS;
  const mode = options.mode || 'fit';
  const format = options.format || 'auto';
  const sizes = options.sizes || '100vw';
  const isPublic = file.access === 'public';
  const expiresIn = Math.min(86400, Math.max(60, parseInt(options.expiresIn, 10) || 3600));

  const entries = widths.map((w) => {
    let url;
    if (isPublic) {
      url = `${config.publicUrl}/img/${mode}/${w}/0/f/${file.storage_key}`;
      if (format && format !== 'auto') url += `?format=${format}`;
    } else {
      const signed = generateTransform(
        project, file.storage_key, { mode, width: w, height: 0, format: format === 'auto' ? 'webp' : format }, expiresIn
      );
      url = signed.url;
    }
    return { width: w, url };
  });

  const srcset = entries.map((e) => `${e.url} ${e.width}w`).join(', ');
  return { widths, sizes, srcset, urls: entries };
}

/**
 * Fetch a file and build its srcset. Returns null when the file is missing or
 * is not an image.
 */
async function getSrcset(fileId, project, options = {}) {
  const { rows } = await query(
    'SELECT * FROM files WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL',
    [fileId, project.id]
  );
  if (rows.length === 0) return null;
  if (rows[0].type !== 'image') {
    const err = new Error('srcset is only available for images');
    err.status = 400;
    err.code = 'INVALID_FILE_TYPE';
    throw err;
  }
  return buildSrcset(project, rows[0], options);
}

module.exports = {
  uploadFile,
  deleteFile,
  listFiles,
  getFile,
  getSrcset,
  buildSrcset,
  ACCESS_LEVELS,
  SRCSET_WIDTHS,
  // Exported for the BullMQ media processor, which reuses these rather than
  // duplicating rendition bookkeeping.
  formatResponse,
  recordObject,
  updateProjectCounters,
  sha256File,
  // Exported for the direct/multipart upload routes, which reuse the same
  // idempotency bookkeeping as the normal upload path.
  findByIdempotencyKey,
  recordIdempotency,
};
