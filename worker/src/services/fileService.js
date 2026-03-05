const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { query } = require('../db');
const { putBuffer, putFile, removeObject, getObject } = require('../minio');
const { processImage, isAnimatedGif } = require('./imageProcessor');
const { transcodeVideo, extractThumbnail, getVideoDuration, gifToMp4, cleanup, tmpPath } = require('./videoProcessor');
const { slugify } = require('../utils/slugify');
const { getMimeType } = require('../utils/mimeTypes');
const { getFileType } = require('../utils/fileTypes');
const { trackUpload, trackDelete } = require('./usageService');
const { dispatch: dispatchWebhook } = require('./webhookService');
const config = require('../config');

function nanoid(size = 6) {
  return crypto.randomBytes(size).toString('hex').substring(0, size);
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

async function uploadFile(file, project, options = {}, queue = null) {
  const start = Date.now();
  const ext = path.extname(file.originalname).toLowerCase();
  const fileType = getFileType(ext);
  const slug = slugify(options.name || file.originalname);
  const folder = sanitizeFolder(options.folder);
  const access = options.access || project.settings?.default_access || 'public';

  if (fileType === 'image') {
    // Check for animated GIF
    const animated = ext === '.gif' && await isAnimatedGif(file.buffer);

    if (animated) {
      // Animated GIF -> MP4
      const tempGif = tmpPath('.gif');
      await fs.promises.writeFile(tempGif, file.buffer);
      try {
        const result = await gifToMp4(tempGif, { crf: config.videoCrf });
        const storageKey = buildStorageKey(project.id, folder, slug, 'mp4');
        await putFile(storageKey, result.path, 'video/mp4');

        // Extract thumbnail
        const thumbPath = await extractThumbnail(result.path);
        const thumbKey = storageKey.replace('.mp4', '_thumb.webp');
        await putFile(thumbKey, thumbPath, 'image/webp');

        const duration = await getVideoDuration(result.path);
        cleanup(tempGif, result.path, thumbPath);

        const processingMs = Date.now() - start;
        const row = await insertFileRecord({
          projectId: project.id, storageKey, filename: `${slug}-${path.basename(storageKey).split('/').pop()}`,
          originalName: file.originalname, folder, type: 'video', mimeType: 'video/mp4',
          size: result.size, originalSize: file.buffer.length, duration, thumbnailKey: thumbKey,
          status: 'done', processingMs, access, uploadedBy: options.apiKeyId,
        });
        await updateProjectCounters(project.id, result.size);
        const response = formatResponse(row, project.id);
        trackUpload(project.id, file.buffer.length).catch(() => {});
        dispatchWebhook(project.id, 'file.uploaded', response).catch(() => {});
        return response;
      } catch (err) {
        cleanup(tempGif);
        throw err;
      }
    }

    // Regular image -> WebP
    const result = await processImage(file.buffer, {
      maxWidth: project.settings?.max_width || config.maxWidth,
      maxHeight: project.settings?.max_height || config.maxHeight,
      quality: project.settings?.webp_quality || config.webpQuality,
    });

    const storageKey = buildStorageKey(project.id, folder, slug, 'webp');
    await putBuffer(storageKey, result.buffer, 'image/webp');

    const processingMs = Date.now() - start;
    const row = await insertFileRecord({
      projectId: project.id, storageKey, filename: path.basename(storageKey),
      originalName: file.originalname, folder, type: 'image', mimeType: 'image/webp',
      size: result.size, originalSize: file.buffer.length, width: result.width,
      height: result.height, status: 'done', processingMs, access, uploadedBy: options.apiKeyId,
    });
    await updateProjectCounters(project.id, result.size);
    const response = formatResponse(row, project.id);
    trackUpload(project.id, file.buffer.length).catch(() => {});
    dispatchWebhook(project.id, 'file.uploaded', response).catch(() => {});
    return response;
  }

  if (fileType === 'video' || fileType === 'video_passthrough') {
    // Store temp original, return 202, enqueue processing
    const finalExt = 'mp4';
    const storageKey = buildStorageKey(project.id, folder, slug, finalExt);
    const tempKey = `_processing_${crypto.randomBytes(8).toString('hex')}${ext}`;

    // Store temp in MinIO
    await putBuffer(tempKey, file.buffer, getMimeType(ext));

    const processingMs = Date.now() - start;
    const row = await insertFileRecord({
      projectId: project.id, storageKey, filename: path.basename(storageKey),
      originalName: file.originalname, folder, type: 'video', mimeType: 'video/mp4',
      size: 0, originalSize: file.buffer.length, status: 'processing',
      processingMs, access, uploadedBy: options.apiKeyId,
    });

    // Enqueue async processing (download from MinIO, don't hold buffer)
    if (queue) {
      queue.enqueue(row.id, async () => {
        await processVideoAsync(row.id, project, tempKey, storageKey, fileType);
      }).catch((err) => {
        console.error(`Video processing failed for ${row.id}:`, err.message);
      });
    }

    const response = formatResponse(row, project.id);
    trackUpload(project.id, file.buffer.length).catch(() => {});
    dispatchWebhook(project.id, 'file.uploaded', response).catch(() => {});
    return { ...response, _statusCode: 202 };
  }

  if (fileType === 'audio') {
    // Store as-is, extract duration
    const storageKey = buildStorageKey(project.id, folder, slug, ext.substring(1));
    await putBuffer(storageKey, file.buffer, getMimeType(ext));

    // Try to get duration
    let duration = null;
    try {
      const tempPath = tmpPath(ext);
      await fs.promises.writeFile(tempPath, file.buffer);
      duration = await getVideoDuration(tempPath);
      cleanup(tempPath);
    } catch { /* noop */ }

    const processingMs = Date.now() - start;
    const row = await insertFileRecord({
      projectId: project.id, storageKey, filename: path.basename(storageKey),
      originalName: file.originalname, folder, type: 'file', mimeType: getMimeType(ext),
      size: file.buffer.length, originalSize: file.buffer.length, duration,
      status: 'done', processingMs, access, uploadedBy: options.apiKeyId,
    });
    await updateProjectCounters(project.id, file.buffer.length);
    const audioResponse = formatResponse(row, project.id);
    trackUpload(project.id, file.buffer.length).catch(() => {});
    dispatchWebhook(project.id, 'file.uploaded', audioResponse).catch(() => {});
    return audioResponse;
  }

  // Generic file — store as-is
  const storageKey = buildStorageKey(project.id, folder, slug, ext.substring(1) || 'bin');
  await putBuffer(storageKey, file.buffer, getMimeType(ext));

  const processingMs = Date.now() - start;
  const row = await insertFileRecord({
    projectId: project.id, storageKey, filename: path.basename(storageKey),
    originalName: file.originalname, folder, type: 'file', mimeType: getMimeType(ext),
    size: file.buffer.length, originalSize: file.buffer.length,
    status: 'done', processingMs, access, uploadedBy: options.apiKeyId,
  });
  await updateProjectCounters(project.id, file.buffer.length);
  const fileResponse = formatResponse(row, project.id);
  trackUpload(project.id, file.buffer.length).catch(() => {});
  dispatchWebhook(project.id, 'file.uploaded', fileResponse).catch(() => {});
  return fileResponse;
}

async function processVideoAsync(fileId, project, tempKey, finalKey, fileType) {
  const tempInput = tmpPath(path.extname(tempKey));
  const asyncStart = Date.now();

  try {
    // Download temp file from MinIO to local filesystem
    const stream = await getObject(tempKey);
    const writeStream = fs.createWriteStream(tempInput);
    await new Promise((resolve, reject) => {
      stream.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      stream.on('error', reject);
    });

    let transcodedPath;
    let finalSize;

    if (fileType === 'video_passthrough') {
      // MP4 passthrough — use as-is
      transcodedPath = tempInput;
      const stat = await fs.promises.stat(tempInput);
      finalSize = stat.size;
    } else {
      // Transcode
      const result = await transcodeVideo(tempInput, {
        crf: config.videoCrf,
        maxHeight: config.videoMaxHeight,
      });
      transcodedPath = result.path;
      finalSize = result.size;
    }

    // Extract thumbnail
    const thumbPath = await extractThumbnail(transcodedPath);
    const thumbKey = finalKey.replace('.mp4', '_thumb.webp');

    // Upload final files
    await putFile(finalKey, transcodedPath, 'video/mp4');
    await putFile(thumbKey, thumbPath, 'image/webp');

    // Get duration
    const duration = await getVideoDuration(transcodedPath);

    // Remove temp from MinIO
    removeObject(tempKey).catch(() => {});

    // Update DB
    const asyncProcessingMs = Date.now() - asyncStart;
    await query(
      `UPDATE files SET status = 'done', size = $1, duration = $2, thumbnail_key = $3,
       processing_ms = $4 WHERE id = $5`,
      [finalSize, duration, thumbKey, asyncProcessingMs, fileId]
    );

    await updateProjectCounters(project.id, finalSize);

    cleanup(tempInput, transcodedPath, thumbPath);

    // Fire webhook: file.processed
    const { rows: fileRows } = await query('SELECT * FROM files WHERE id = $1', [fileId]);
    if (fileRows.length > 0) {
      dispatchWebhook(project.id, 'file.processed', formatResponse(fileRows[0], project.id)).catch(() => {});
    }
  } catch (err) {
    // On failure, copy temp to final key so something is accessible
    try {
      const failStream = await getObject(tempKey);
      const failTmp = tmpPath('.mp4');
      const failWrite = fs.createWriteStream(failTmp);
      await new Promise((resolve, reject) => {
        failStream.pipe(failWrite);
        failWrite.on('finish', resolve);
        failWrite.on('error', reject);
      });
      await putFile(finalKey, failTmp, 'video/mp4');
      cleanup(failTmp);
      removeObject(tempKey).catch(() => {});
    } catch { /* noop */ }

    await query(
      "UPDATE files SET status = 'failed', error_message = $1 WHERE id = $2",
      [err.message, fileId]
    );

    // Fire webhook: file.failed
    dispatchWebhook(project.id, 'file.failed', { id: fileId, error: err.message }).catch(() => {});

    cleanup(tempInput);
    throw err;
  }
}

async function insertFileRecord(data) {
  const { rows } = await query(
    `INSERT INTO files (project_id, storage_key, filename, original_name, folder, type, mime_type,
     size, original_size, width, height, duration, thumbnail_key, status, processing_ms, access, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
     RETURNING *`,
    [
      data.projectId, data.storageKey, data.filename, data.originalName, data.folder,
      data.type, data.mimeType, data.size, data.originalSize, data.width || null,
      data.height || null, data.duration || null, data.thumbnailKey || null,
      data.status, data.processingMs, data.access, data.uploadedBy || null,
    ]
  );
  return rows[0];
}

async function updateProjectCounters(projectId, sizeChange) {
  await query(
    'UPDATE projects SET storage_used = storage_used + $1, file_count = file_count + 1 WHERE id = $2',
    [sizeChange, projectId]
  ).catch(() => {});
}

function formatResponse(row, projectId) {
  const urls = buildUrls(config.publicUrl, projectId, row.storage_key, row.type);
  return {
    id: row.id,
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

  // Soft delete
  await query('UPDATE files SET deleted_at = NOW() WHERE id = $1', [fileId]);

  // Remove from MinIO
  removeObject(file.storage_key).catch(() => {});
  if (file.thumbnail_key) {
    removeObject(file.thumbnail_key).catch(() => {});
  }

  // Decrement counters
  await query(
    'UPDATE projects SET storage_used = GREATEST(0, storage_used - $1), file_count = GREATEST(0, file_count - 1) WHERE id = $2',
    [file.size, project.id]
  ).catch(() => {});

  // Track usage and fire webhook
  trackDelete(project.id).catch(() => {});
  dispatchWebhook(project.id, 'file.deleted', {
    id: file.id,
    filename: file.filename,
    storage_key: file.storage_key,
    type: file.type,
    size: file.size,
  }).catch(() => {});

  return {
    deleted: true,
    id: file.id,
    storage_key: file.storage_key,
    freed_bytes: file.size,
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

  return {
    data: rows.map((row) => formatResponse(row, project.id)),
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
  return formatResponse(rows[0], project.id);
}

module.exports = { uploadFile, deleteFile, listFiles, getFile };
