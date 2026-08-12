/**
 * Media processing job — transcode a video, extract a thumbnail, record the
 * renditions, and emit file.processed / file.failed through the outbox.
 *
 * This is the durable replacement for the old in-process processVideoAsync:
 * the job lives in BullMQ (Redis), so a worker crash mid-transcode leaves the
 * job to be retried on restart rather than lost. It is written to be safely
 * re-runnable — the idempotency guard at the top returns early if the asset
 * is already done — so BullMQ retries can never double-process a file.
 */

const fs = require('fs');
const path = require('path');
const { query, withTransaction } = require('../../db');
const config = require('../../config');
const {
  transcodeVideo, extractThumbnail, getVideoDuration, cleanup, tmpPath,
} = require('../../services/videoProcessor');
const storageBackendService = require('../../services/storageBackendService');
const fileObjectService = require('../../services/fileObjectService');
const outboxService = require('../../services/outboxService');
const {
  formatResponse, recordObject, updateProjectCounters, sha256File,
} = require('../../services/fileService');

// Columns formatResponse reads off each object.
const OBJECT_COLS =
  'role, storage_key, mime_type, size, checksum, storage_tier, status';

async function heartbeat(job, pct) {
  if (job && typeof job.updateProgress === 'function') {
    // updateProgress renews the job lock, so a long transcode is not treated
    // as stalled and stolen by another worker.
    try { await job.updateProgress(pct); } catch { /* progress is best-effort */ }
  }
  if (job && typeof job.extendLock === 'function') {
    try { await job.extendLock(30000); } catch { /* lock renewal is best-effort */ }
  }
}

/**
 * @param {object} data  { fileId, projectId, tempKey, finalKey, kind }
 *   kind: 'video' (transcode) | 'video_passthrough' (mp4, use as-is)
 * @param {object} [job] the BullMQ job, for progress/heartbeat
 */
async function processMediaJob(data, job = null) {
  const { fileId, projectId, tempKey, finalKey, kind } = data;

  const backend = await storageBackendService.getDefaultBackend();
  const client = storageBackendService.getBackendClient(backend);

  // ── Idempotency ─────────────────────────────────────────
  // If this asset is already finished (a completed job, or a duplicate
  // enqueue with the same jobId that slipped through), do nothing.
  const { rows: existing } = await query('SELECT id, status FROM files WHERE id = $1', [fileId]);
  if (existing.length === 0) {
    // File row is gone (deleted before processing ran) — drop the temp and stop.
    client.removeObject(tempKey).catch(() => {});
    return { skipped: 'file_missing' };
  }
  if (existing[0].status === 'done') {
    const optimized = await fileObjectService.getObjectByRole(fileId, 'optimized');
    if (optimized) {
      client.removeObject(tempKey).catch(() => {});
      return { skipped: 'already_done' };
    }
  }

  const tempInput = tmpPath(path.extname(tempKey));
  const asyncStart = Date.now();

  try {
    await heartbeat(job, 5);

    // Download temp file from object storage to the local filesystem.
    const stream = await client.getObject(tempKey);
    const writeStream = fs.createWriteStream(tempInput);
    await new Promise((resolve, reject) => {
      stream.pipe(writeStream);
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
      stream.on('error', reject);
    });

    await heartbeat(job, 20);

    let transcodedPath;
    let finalSize;
    if (kind === 'video_passthrough') {
      transcodedPath = tempInput;
      finalSize = (await fs.promises.stat(tempInput)).size;
    } else {
      const result = await transcodeVideo(tempInput, {
        crf: config.videoCrf,
        maxHeight: config.videoMaxHeight,
      });
      transcodedPath = result.path;
      finalSize = result.size;
    }

    await heartbeat(job, 70);

    const thumbPath = await extractThumbnail(transcodedPath);
    const thumbKey = finalKey.replace('.mp4', '_thumb.webp');

    await client.putFile(finalKey, transcodedPath, 'video/mp4');
    await client.putFile(thumbKey, thumbPath, 'image/webp');

    await heartbeat(job, 90);

    const duration = await getVideoDuration(transcodedPath);
    let videoChecksum = null;
    try { videoChecksum = await sha256File(transcodedPath); } catch { /* best effort */ }
    let thumbSize = 0;
    try { thumbSize = (await fs.promises.stat(thumbPath)).size; } catch { /* noop */ }

    client.removeObject(tempKey).catch(() => {});

    const asyncProcessingMs = Date.now() - asyncStart;

    // Update the files row, record both renditions, and emit file.processed
    // in ONE transaction so the event can never diverge from the DB state.
    await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE files SET status = 'done', size = $1, duration = $2, thumbnail_key = $3,
         processing_ms = $4, checksum = $5 WHERE id = $6`,
        [finalSize, duration, thumbKey, asyncProcessingMs, videoChecksum, fileId]
      );
      await recordObject(fileId, backend, {
        role: 'optimized', storageKey: finalKey, mimeType: 'video/mp4', size: finalSize, checksum: videoChecksum,
      }, tx);
      await recordObject(fileId, backend, {
        role: 'thumbnail', storageKey: thumbKey, mimeType: 'image/webp', size: thumbSize,
      }, tx);

      const { rows: fileRows } = await tx.query('SELECT * FROM files WHERE id = $1', [fileId]);
      if (fileRows.length > 0) {
        const { rows: objs } = await tx.query(
          `SELECT ${OBJECT_COLS} FROM file_objects WHERE file_id = $1 ORDER BY created_at ASC`,
          [fileId]
        );
        await outboxService.emitEvent(tx, {
          aggregateType: 'file', aggregateId: fileId, eventType: 'file.processed',
          payload: formatResponse(fileRows[0], projectId, objs),
        });
      }
    });

    // Derived bookkeeping, outside the atomic unit.
    await updateProjectCounters(projectId, finalSize + thumbSize, { incrementFileCount: false });

    cleanup(tempInput, transcodedPath, thumbPath);
    await heartbeat(job, 100);
    return { fileId, size: finalSize, duration };
  } catch (err) {
    // Best-effort: copy the temp original to the final key so SOMETHING is
    // served, then mark failed + emit file.failed atomically. Rethrow so
    // BullMQ records the failure and retries per the queue's backoff policy.
    try {
      const failStream = await client.getObject(tempKey);
      const failTmp = tmpPath('.mp4');
      const failWrite = fs.createWriteStream(failTmp);
      await new Promise((resolve, reject) => {
        failStream.pipe(failWrite);
        failWrite.on('finish', resolve);
        failWrite.on('error', reject);
      });
      await client.putFile(finalKey, failTmp, 'video/mp4');
      cleanup(failTmp);
      client.removeObject(tempKey).catch(() => {});
    } catch { /* noop */ }

    await withTransaction(async (tx) => {
      await tx.query(
        "UPDATE files SET status = 'failed', error_message = $1 WHERE id = $2",
        [err.message, fileId]
      );
      await outboxService.emitEvent(tx, {
        aggregateType: 'file', aggregateId: fileId, eventType: 'file.failed',
        payload: { id: fileId, error: err.message },
      });
    }).catch(() => { /* the thrown error below is what matters */ });

    cleanup(tempInput);
    throw err;
  }
}

module.exports = { processMediaJob };
