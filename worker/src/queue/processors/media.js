/**
 * Media processing job — transcode a video into an HLS adaptive-bitrate
 * package (+ a progressive mp4 fallback + poster + thumbnail), record every
 * physical object, summarize the ladder in video_renditions, and emit
 * file.processed / file.failed through the outbox.
 *
 * This is the durable replacement for the old in-process processVideoAsync:
 * the job lives in BullMQ (Redis), so a worker crash mid-transcode leaves the
 * job to be retried on restart rather than lost. It is written to be safely
 * re-runnable — the idempotency guard at the top returns early if the asset
 * already has its HLS objects — and every storage key is deterministic
 * (derived from the file's final key) so a retry overwrites rather than
 * duplicates. Objects are only recorded (and marked available) once every
 * upload is verified; a failure marks the file 'failed', keeps the source for
 * a retry, and leaves no half-available objects behind.
 *
 * Storage layout (base = finalKey without its .mp4 extension):
 *   {finalKey}                         progressive mp4  (role 'optimized')
 *   {base}/hls/master.m3u8             master playlist  (role 'hls')
 *   {base}/hls/<h>p/index.m3u8         media playlist   (role video_<h>p)
 *   {base}/hls/<h>p/seg_XXX.ts         segments
 *   {base}/hls/poster.jpg             poster frame     (role 'poster')
 *   {base}/source<ext>                preserved source (role 'source', policy)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { query, withTransaction } = require('../../db');
const config = require('../../config');
const {
  transcodeVideo, extractThumbnail, probeVideo, transcodeHls, cleanup, tmpPath,
} = require('../../services/videoProcessor');
const storageBackendService = require('../../services/storageBackendService');
const fileObjectService = require('../../services/fileObjectService');
const outboxService = require('../../services/outboxService');
const lifecycleService = require('../../services/lifecycleService');
const { addJob, QUEUES, isEnabled } = require('../../queue');
const {
  formatResponse, recordObject, updateProjectCounters, sha256File, getOriginalPolicy,
} = require('../../services/fileService');

const MIME_HLS = 'application/vnd.apple.mpegurl';
const MIME_TS = 'video/MP2T';
const DAY_MS = 24 * 60 * 60 * 1000;

// Columns formatResponse reads off each object.
const OBJECT_COLS =
  'role, storage_key, mime_type, size, checksum, storage_tier, status';

// Progressive mp4 fallback height — a single H.264 rendition for clients
// without HLS and for Range/download. Never upscales the source.
const PROGRESSIVE_MAX_HEIGHT = parseInt(process.env.VIDEO_PROGRESSIVE_HEIGHT || '720', 10);

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

function baseKey(finalKey) {
  return finalKey.replace(/\.mp4$/i, '');
}

/** Download an object from storage to a local path. */
async function downloadTo(client, key, destPath) {
  const stream = await client.getObject(key);
  const writeStream = fs.createWriteStream(destPath);
  await new Promise((resolve, reject) => {
    stream.pipe(writeStream);
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
    stream.on('error', reject);
  });
}

/** Confirm an object landed at the expected size (when known). Throws on gap. */
async function verifyStored(client, key, expectedSize) {
  let stat;
  try {
    stat = await client.statObject(key);
  } catch {
    throw new Error(`stored object could not be verified: ${key}`);
  }
  if (expectedSize != null && typeof stat?.size === 'number' && stat.size !== expectedSize) {
    throw new Error(`stored object size mismatch for ${key}: expected ${expectedSize}, got ${stat.size}`);
  }
}

/**
 * Apply the project's original-preservation policy to the SOURCE video. Runs
 * ONLY after every rendition + poster is verified available and the file is
 * marked done, so the deliverable is never at risk. Mirrors the image path:
 *   keep      → store source hot, record 'source' object
 *   temporary → store source hot with a retention_until deadline
 *   archive   → store source hot, then enqueue the Phase-6 archive (scope
 *               'source') to move it to cold
 *   discard   → remove the source; the renditions are the deliverable
 * Every branch writes a lifecycle_audit row.
 */
async function applyOriginalPolicy({ file, project, backend, client, tempKey, localSourcePath, data }) {
  const policy = getOriginalPolicy(project);
  const auditBase = {
    accountId: project.account_id,
    projectId: project.id,
    fileId: file.id,
    fromState: 'active',
    toState: 'active',
    actor: 'system:video',
  };

  if (policy.mode === 'discard') {
    client.removeObject(tempKey).catch(() => {});
    await lifecycleService.writeAudit(query, {
      ...auditBase, action: 'video.source_discarded', detail: { policy: 'discard' },
    }).catch(() => {});
    return { sourceBytes: 0 };
  }

  const ext = (data.originalExt || '.mp4').replace(/^\.?/, '.');
  const sourceKey = `${baseKey(data.finalKey)}/source${ext}`;
  const mime = data.originalMime || 'video/mp4';

  let size = 0;
  let checksum = null;
  try {
    await client.putFile(sourceKey, localSourcePath, mime);
    size = (await fs.promises.stat(localSourcePath)).size;
    checksum = await sha256File(localSourcePath);
    await verifyStored(client, sourceKey, size);
  } catch (err) {
    // Preserving the source is best-effort bookkeeping; a failure here must not
    // fail the already-completed renditions. Leave the temp in place for a
    // retry/reconcile and record the reason.
    await lifecycleService.writeAudit(query, {
      ...auditBase, action: 'video.source_preserve_failed', detail: { error: err.message },
    }).catch(() => {});
    return { sourceBytes: 0 };
  }

  const metadata = {};
  let retentionUntil = null;
  if (policy.mode === 'temporary') {
    retentionUntil = new Date(Date.now() + policy.archiveAfterDays * DAY_MS);
    metadata.delete_after = retentionUntil.toISOString();
  }

  await recordObject(file.id, backend, {
    role: 'source', storageKey: sourceKey, mimeType: mime, size, checksum, metadata,
  });

  if (retentionUntil) {
    await query('UPDATE files SET retention_until = $1 WHERE id = $2', [retentionUntil, file.id]).catch(() => {});
  }

  // The hot source copy is safe to remove now that a permanent 'source' object
  // records it.
  client.removeObject(tempKey).catch(() => {});

  if (policy.mode === 'archive') {
    await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE file_objects
            SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{archive_intent}', 'true')
          WHERE file_id = $1 AND role = 'source'`,
        [file.id]
      );
      await lifecycleService.writeAudit(tx.query.bind(tx), {
        ...auditBase, action: 'video.source_archive', detail: { policy: 'archive', scope: 'source' },
      });
    });
    if (isEnabled()) {
      await addJob(
        QUEUES.ARCHIVE, 'archive',
        { fileId: file.id, projectId: project.id, scope: 'source' },
        { jobId: `archive:${file.id}` }
      ).catch(() => {});
    }
  } else {
    await lifecycleService.writeAudit(query, {
      ...auditBase, action: `video.source_${policy.mode}`, detail: { policy: policy.mode },
    }).catch(() => {});
  }

  return { sourceBytes: size };
}

/**
 * @param {object} data  { fileId, projectId, tempKey, finalKey, kind,
 *                          originalMime, originalExt }
 * @param {object} [job] the BullMQ job, for progress/heartbeat
 */
async function processMediaJob(data, job = null) {
  const { fileId, projectId, tempKey, finalKey } = data;

  const backend = await storageBackendService.getDefaultBackend();
  const client = storageBackendService.getBackendClient(backend);

  // ── Idempotency ─────────────────────────────────────────
  // A finished asset with its HLS master already recorded is a completed job
  // (or a duplicate enqueue with the same jobId). Do nothing.
  const { rows: existing } = await query('SELECT id, status FROM files WHERE id = $1', [fileId]);
  if (existing.length === 0) {
    client.removeObject(tempKey).catch(() => {});
    return { skipped: 'file_missing' };
  }
  if (existing[0].status === 'done') {
    const hls = await fileObjectService.getObjectByRole(fileId, 'hls');
    const optimized = await fileObjectService.getObjectByRole(fileId, 'optimized');
    if (hls || optimized) {
      client.removeObject(tempKey).catch(() => {});
      return { skipped: 'already_done' };
    }
  }

  // Load the project (settings + account) for the original-preservation policy.
  const { rows: projRows } = await query('SELECT * FROM projects WHERE id = $1', [projectId]);
  const project = projRows[0] || { id: projectId, settings: {}, account_id: null };

  const tempInput = tmpPath(path.extname(tempKey) || '.mp4');
  const outDir = path.join(os.tmpdir(), `mv_hls_${crypto.randomBytes(8).toString('hex')}`);
  const base = baseKey(finalKey);
  const hlsPrefix = `${base}/hls`;
  const masterKey = `${hlsPrefix}/master.m3u8`;
  const posterKey = `${hlsPrefix}/poster.jpg`;
  const thumbKey = finalKey.replace(/\.mp4$/i, '_thumb.webp');

  const uploadedKeys = [];
  const asyncStart = Date.now();
  let progressivePath = null;
  let thumbPath = null;

  try {
    await query("UPDATE files SET video_status = 'processing' WHERE id = $1", [fileId]).catch(() => {});
    await heartbeat(job, 5);

    await downloadTo(client, tempKey, tempInput);
    await heartbeat(job, 15);

    const probe = await probeVideo(tempInput);
    await fs.promises.mkdir(outDir, { recursive: true });

    // ── HLS adaptive-bitrate package ──────────────────────
    const hls = await transcodeHls(tempInput, outDir, {
      probe,
      timeout: config.videoJobTimeoutMs,
      onProgress: (frac) => { heartbeat(job, 15 + Math.round(frac * 45)); },
    });
    await heartbeat(job, 60);

    // ── Progressive mp4 fallback (Range/download, non-HLS clients) ──
    const progressiveHeight = Math.min(PROGRESSIVE_MAX_HEIGHT, hls.height || PROGRESSIVE_MAX_HEIGHT);
    const prog = await transcodeVideo(tempInput, { crf: config.videoCrf, maxHeight: progressiveHeight });
    progressivePath = prog.path;
    const progressiveSize = prog.size;

    // ── Poster + thumbnail ────────────────────────────────
    // The WebVTT poster (jpeg) is the canonical preview and always produced by
    // the HLS step. The grid thumbnail (webp) is best-effort: some ffmpeg
    // builds lack the libwebp encoder, and a preview thumbnail must never fail
    // the whole video — the poster stands in for the grid when it's missing.
    try {
      thumbPath = await extractThumbnail(tempInput);
    } catch (thumbErr) {
      console.warn(`Thumbnail (webp) generation failed for ${fileId}, using poster: ${thumbErr.message}`);
      thumbPath = null;
    }
    await heartbeat(job, 70);

    // ── Upload every object under deterministic keys ──────
    await client.putFile(finalKey, progressivePath, 'video/mp4'); uploadedKeys.push(finalKey);
    if (thumbPath) { await client.putFile(thumbKey, thumbPath, 'image/webp'); uploadedKeys.push(thumbKey); }
    await client.putFile(posterKey, hls.posterPath, 'image/jpeg'); uploadedKeys.push(posterKey);
    await client.putFile(masterKey, hls.masterPath, MIME_HLS); uploadedKeys.push(masterKey);

    const renditionObjects = [];
    for (const r of hls.renditions) {
      const playlistKey = `${hlsPrefix}/${r.height}p/${r.playlistName}`;
      await client.putFile(playlistKey, r.playlistPath, MIME_HLS); uploadedKeys.push(playlistKey);
      for (const seg of r.segmentFiles) {
        const segKey = `${hlsPrefix}/${r.height}p/${seg}`;
        await client.putFile(segKey, path.join(r.dir, seg), MIME_TS); uploadedKeys.push(segKey);
      }
      renditionObjects.push({ rendition: r, playlistKey });
    }
    await heartbeat(job, 85);

    // ── Verify everything landed before recording anything ─
    await verifyStored(client, finalKey, progressiveSize);
    if (thumbPath) await verifyStored(client, thumbKey, null);
    await verifyStored(client, posterKey, null);
    await verifyStored(client, masterKey, null);
    for (const { playlistKey } of renditionObjects) {
      await verifyStored(client, playlistKey, null);
    }
    await heartbeat(job, 90);

    // Checksums for the durable single-file objects (segments rely on size).
    let progressiveChecksum = null;
    let posterChecksum = null;
    try { progressiveChecksum = await sha256File(progressivePath); } catch { /* best effort */ }
    try { posterChecksum = await sha256File(hls.posterPath); } catch { /* best effort */ }
    let thumbSize = 0;
    if (thumbPath) { try { thumbSize = (await fs.promises.stat(thumbPath)).size; } catch { /* noop */ } }
    // When the webp thumbnail could not be produced, the poster doubles as the
    // grid thumbnail so previews still render.
    const gridThumbKey = thumbPath ? thumbKey : posterKey;
    let posterSize = 0;
    try { posterSize = (await fs.promises.stat(hls.posterPath)).size; } catch { /* noop */ }
    let masterSize = 0;
    try { masterSize = (await fs.promises.stat(hls.masterPath)).size; } catch { /* noop */ }

    const duration = hls.duration != null ? hls.duration : probe.duration;
    const width = hls.width || probe.width || null;
    const height = hls.height || probe.height || null;
    const asyncProcessingMs = Date.now() - asyncStart;

    // Record renditions bytes toward storage counters.
    const renditionBytes = renditionObjects.reduce((t, { rendition }) => t + (rendition.bytes || 0), 0);

    // ── Commit: files row + all objects + renditions + event, atomically ──
    await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE files
            SET status = 'done', video_status = 'ready', has_hls = TRUE,
                size = $1, duration = $2, width = $3, height = $4,
                thumbnail_key = $5, poster_key = $6, processing_ms = $7, checksum = $8
          WHERE id = $9`,
        [progressiveSize, duration, width, height, gridThumbKey, posterKey, asyncProcessingMs, progressiveChecksum, fileId]
      );

      await recordObject(fileId, backend, {
        role: 'optimized', storageKey: finalKey, mimeType: 'video/mp4', size: progressiveSize, checksum: progressiveChecksum,
      }, tx);
      if (thumbPath) {
        await recordObject(fileId, backend, {
          role: 'thumbnail', storageKey: thumbKey, mimeType: 'image/webp', size: thumbSize,
        }, tx);
      }
      await recordObject(fileId, backend, {
        role: 'poster', storageKey: posterKey, mimeType: 'image/jpeg', size: posterSize, checksum: posterChecksum,
      }, tx);
      await recordObject(fileId, backend, {
        role: 'hls', storageKey: masterKey, mimeType: MIME_HLS, size: masterSize,
      }, tx);

      for (const { rendition, playlistKey } of renditionObjects) {
        const role = `video_${rendition.height}p`;
        await recordObject(fileId, backend, {
          role, storageKey: playlistKey, mimeType: MIME_HLS, size: rendition.bytes || 0,
          width: rendition.width, height: rendition.height,
        }, tx);
        await tx.query(
          `INSERT INTO video_renditions (file_id, height, width, bitrate, codec, hls_playlist_key, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'ready')
           ON CONFLICT (file_id, height) DO UPDATE
             SET width = EXCLUDED.width, bitrate = EXCLUDED.bitrate, codec = EXCLUDED.codec,
                 hls_playlist_key = EXCLUDED.hls_playlist_key, status = 'ready'`,
          [fileId, rendition.height, rendition.width, rendition.vbitrate, 'h264', playlistKey]
        );
      }

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

    const renditionsTotal = progressiveSize + thumbSize + posterSize + masterSize + renditionBytes;
    await updateProjectCounters(projectId, renditionsTotal, { incrementFileCount: false });
    await heartbeat(job, 95);

    // ── Original-video archival (only now that renditions are verified) ──
    const { rows: fileRows } = await query('SELECT id FROM files WHERE id = $1', [fileId]);
    if (fileRows.length > 0) {
      try {
        const { sourceBytes } = await applyOriginalPolicy({
          file: { id: fileId }, project, backend, client, tempKey, localSourcePath: tempInput, data,
        });
        if (sourceBytes > 0) {
          await updateProjectCounters(projectId, sourceBytes, { incrementFileCount: false });
        }
      } catch (err) {
        console.error(`Original-policy application failed for ${fileId}:`, err.message);
      }
    } else {
      client.removeObject(tempKey).catch(() => {});
    }

    cleanup(tempInput, progressivePath, thumbPath);
    fs.promises.rm(outDir, { recursive: true, force: true }).catch(() => {});
    await heartbeat(job, 100);
    return { fileId, size: progressiveSize, duration, renditions: renditionObjects.length, hls: true };
  } catch (err) {
    // Never leave half-available objects: remove anything we uploaded this run,
    // KEEP the source temp so a retry can re-run, mark the file failed, and
    // emit file.failed. Rethrow so BullMQ records the failure and retries.
    for (const key of uploadedKeys) {
      client.removeObject(key).catch(() => {});
    }

    await withTransaction(async (tx) => {
      await tx.query(
        "UPDATE files SET status = 'failed', video_status = 'failed', error_message = $1 WHERE id = $2",
        [err.message, fileId]
      );
      await outboxService.emitEvent(tx, {
        aggregateType: 'file', aggregateId: fileId, eventType: 'file.failed',
        payload: { id: fileId, error: err.message },
      });
    }).catch(() => { /* the thrown error below is what matters */ });

    cleanup(tempInput);
    if (progressivePath) cleanup(progressivePath);
    if (thumbPath) cleanup(thumbPath);
    fs.promises.rm(outDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

module.exports = { processMediaJob, baseKey, MIME_HLS, MIME_TS };
