const { Router } = require('express');
const { query } = require('../db');
const {
  validateOriginal, validateTransform, validateVariant, rewriteHlsPlaylist,
} = require('../services/signedUrl');
const { trackDownload, trackTransform, trackBandwidth } = require('../services/usageService');
const { recordAccess } = require('../services/accessTrackingService');
const fileObjectService = require('../services/fileObjectService');
const storageBackendService = require('../services/storageBackendService');
const transformCacheService = require('../services/transformCacheService');
const variantService = require('../services/variantService');
const lifecycleService = require('../services/lifecycleService');
const { addJob, QUEUES, isEnabled } = require('../queue');
const config = require('../config');

/**
 * Whether a project restricts image delivery to named variants only. Settings
 * may arrive as a parsed object or a JSON string; both are tolerated. Default
 * false preserves the open /img/:mode/:w/:h behavior.
 */
function isStrictTransforms(settings) {
  let s = settings;
  if (typeof s === 'string') {
    try { s = JSON.parse(s); } catch { return false; }
  }
  return !!(s && s.strict_transforms === true);
}

const router = Router();

// How long a client should wait before retrying a request that triggered an
// on-access restore. Restores are async (copy cold→hot + verify), so this is a
// hint, not a guarantee.
const RESTORE_RETRY_AFTER_SECONDS = 10;

/**
 * A file is archived (cold, no hot copy) and must be restored before it can be
 * served. If the project opts into restore-on-access, kick off an idempotent
 * RESTORE job, flip the file to 'restoring', and tell the caller to retry.
 * Returns true when it handled the response (202), false to serve normally.
 */
async function maybeHandleArchived(req, res, file) {
  const state = file.lifecycle_state;
  if (state !== 'archived' && state !== 'restoring') return false;

  const policy = lifecycleService.getLifecyclePolicy({ settings: file.project_settings });

  // Archived + restore-on-access disabled: the cold copy is still available, so
  // fall through and serve it directly from cold rather than denying access.
  if (state === 'archived' && !policy.restoreOnAccess) return false;

  if (state === 'archived') {
    // Guarded flip so concurrent hits don't each enqueue/transition twice.
    try {
      const { rowCount } = await query(
        `UPDATE files SET lifecycle_state = 'restoring' WHERE id = $1 AND lifecycle_state = 'archived'`,
        [file.id]
      );
      if (rowCount === 1) {
        await lifecycleService.writeAudit(query, {
          accountId: file.project_account_id, projectId: file.project_id, fileId: file.id,
          action: 'restore.on_access', fromState: 'archived', toState: 'restoring',
          actor: 'system:serve', detail: { trigger: 'access' },
        });
        if (isEnabled()) {
          await addJob(QUEUES.RESTORE, 'restore',
            { fileId: file.id, projectId: file.project_id },
            { jobId: `restore:${file.id}` }).catch(() => {});
        }
      }
    } catch {
      // If the transition/enqueue fails we still return 202; the file is not
      // servable from hot yet, and a retry will re-drive the restore.
    }
  }

  res.set('Retry-After', String(RESTORE_RETRY_AFTER_SECONDS));
  res.set('Cache-Control', 'no-store');
  return res.status(202).json({ status: 'restoring', message: 'Restore in progress' });
}

/**
 * Resolve which physical object to stream for a logical file, and the
 * storage client that holds it. Reads the logical asset model
 * (file_objects), preferring the optimized rendition and falling back to the
 * preserved source. When a file has no objects yet (rows uploaded before
 * migration 006's backfill, or a bookkeeping gap), fall back to the legacy
 * files.storage_key on the default backend so serving never regresses.
 */
async function resolveStreamTarget(file, requestedKey) {
  try {
    let obj = await fileObjectService.getObjectByRole(file.id, 'optimized');
    if (!obj) obj = await fileObjectService.getObjectByRole(file.id, 'source');
    if (obj && obj.storage_key) {
      const backend = await storageBackendService.getBackendById(obj.storage_backend_id);
      return { key: obj.storage_key, client: storageBackendService.getBackendClient(backend) };
    }
  } catch {
    // fall through to the legacy key on the default backend
  }
  const backend = await storageBackendService.getDefaultBackend();
  return { key: requestedKey, client: storageBackendService.getBackendClient(backend) };
}

// Upper bound on imgproxy output dimensions, so a URL cannot ask the origin to
// render an arbitrarily large image.
const MAX_TRANSFORM_DIMENSION = parseInt(process.env.MAX_TRANSFORM_DIMENSION || '4096', 10);

const PUBLIC_CACHE = 'public, max-age=31536000, immutable';
const PUBLIC_EDGE_CACHE = 'public, max-age=31536000, stale-while-revalidate=60, stale-if-error=86400';
const PRIVATE_CACHE = 'private, no-store';

const TRANSFORM_FORMATS = ['webp', 'avif', 'jpeg', 'png'];
const SVG_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

function isPublicAccess(access) {
  // Anything we cannot positively identify as public is treated as private.
  return access === 'public';
}

/**
 * Caching and CORS headers. Signed and private files must never be stored by a
 * shared cache — a cached copy would keep serving after the token expires.
 */
function setCacheHeaders(res, access) {
  if (isPublicAccess(access)) {
    res.set('Cache-Control', PUBLIC_CACHE);
    res.set('CDN-Cache-Control', PUBLIC_EDGE_CACHE);
    res.set('Surrogate-Control', PUBLIC_EDGE_CACHE);
    res.set('Access-Control-Allow-Origin', '*');
  } else {
    res.set('Cache-Control', PRIVATE_CACHE);
    res.set('CDN-Cache-Control', 'no-store');
    res.set('Surrogate-Control', 'no-store');
    res.set('Vary', 'Authorization');
    // The global CORS middleware opens these routes to every origin; a private
    // file should not be readable cross-origin just because it has a token.
    res.removeHeader('Access-Control-Allow-Origin');
  }
}

function contentDispositionFilename(filename) {
  const fallback = String(filename || 'download').replace(/["\\\r\n]/g, '_');
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(filename || 'download')}`;
}

/**
 * Content-sniffing and script-execution defenses for whatever we are about to
 * write to the response.
 */
function setContentSafetyHeaders(res, { mimeType, type, filename }) {
  res.set('X-Content-Type-Options', 'nosniff');

  if (mimeType === 'image/svg+xml') {
    // Defense in depth: the CSP sandbox blocks script execution, but SVG is
    // still an active document format. Force it to download rather than render
    // as a top-level document, so a payload that slips past the regex-based
    // sanitizer cannot execute in the media origin. <img>-embedded SVGs never
    // run scripts regardless, so this does not break legitimate image use.
    res.set('Content-Security-Policy', SVG_CSP);
    res.set('Content-Disposition', contentDispositionFilename(filename));
  }

  // Non-media is never rendered inline in the CDN origin.
  if (type === 'file') {
    res.set('Content-Disposition', contentDispositionFilename(filename));
  }
}

// ── HLS + video-derivative serving ──────────────────────
// Video renditions live under `{fileBase}/hls/…` and are NOT rows in `files`
// (only the master/media playlists + poster are file_objects). They are served
// here: the owning file is resolved from the deterministic prefix, access is
// enforced exactly like /f/, and for signed/private videos the playlist body
// is rewritten so every child playlist + segment carries its own token.

const HLS_MIME = 'application/vnd.apple.mpegurl';
// Playlists are cheap to regenerate and must not pin a stale token; segments
// are immutable content addressed by name, so they cache forever.
const HLS_PLAYLIST_CACHE = 'public, max-age=60';
const HLS_SEGMENT_CACHE = 'public, max-age=31536000, immutable';

const AUX_IMAGE_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
};

function collectStream(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

/**
 * Caching + CORS for a video-derivative response. Signed/private objects are
 * never stored by a shared cache (a cached copy would outlive its token).
 */
function setHlsCache(res, access, kind) {
  res.set('X-Content-Type-Options', 'nosniff');
  if (isPublicAccess(access)) {
    const cache = kind === 'segment' ? HLS_SEGMENT_CACHE : HLS_PLAYLIST_CACHE;
    res.set('Cache-Control', cache);
    res.set('CDN-Cache-Control', cache);
    res.set('Access-Control-Allow-Origin', '*');
  } else {
    res.set('Cache-Control', PRIVATE_CACHE);
    res.set('CDN-Cache-Control', 'no-store');
    res.set('Surrogate-Control', 'no-store');
    res.set('Vary', 'Authorization');
    res.removeHeader('Access-Control-Allow-Origin');
  }
}

async function serveHls(req, res, next) {
  try {
    const projectId = req.params.projectId;
    const remainder = req.params[0];
    const storageKey = `${projectId}/${remainder}`;

    const idx = remainder.indexOf('/hls/');
    if (idx === -1) return next(); // not a video-derivative path — fall through

    const ext = (remainder.split('.').pop() || '').toLowerCase();
    const isPlaylist = ext === 'm3u8';
    const isSegment = ext === 'ts' || ext === 'm4s';
    const isVtt = ext === 'vtt';
    const isImage = !!AUX_IMAGE_MIME[ext];
    if (!isPlaylist && !isSegment && !isVtt && !isImage) return next();

    // Resolve the owning file from the deterministic prefix: everything up to
    // `/hls/` is the file's storage key minus its `.mp4` extension.
    const fileStorageKey = `${projectId}/${remainder.slice(0, idx)}.mp4`;
    const { rows } = await query(
      `SELECT f.id, f.access, f.project_id, f.type, p.signing_secret
         FROM files f JOIN projects p ON f.project_id = p.id
        WHERE f.storage_key = $1 AND f.deleted_at IS NULL`,
      [fileStorageKey]
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });
    }
    const file = rows[0];

    // Access control — identical to /f/. Each object (playlist/segment/poster/
    // subtitle) is signed over its OWN storage key, so the token the player
    // presents must validate against this exact key.
    const expires = req.query.expires;
    if (file.access === 'private' || file.access === 'signed') {
      const token = req.query.token;
      if (!token || !expires) {
        return res.status(403).json({ error: 'Access denied. This file requires a signed URL.', code: 'ACCESS_DENIED' });
      }
      if (!validateOriginal(file.signing_secret, storageKey, token, expires)) {
        const isExpired = parseInt(expires) < Math.floor(Date.now() / 1000);
        return res.status(403).json({
          error: isExpired ? 'Signed URL has expired' : 'Invalid signature',
          code: isExpired ? 'URL_EXPIRED' : 'INVALID_SIGNATURE',
        });
      }
    }

    const backend = await storageBackendService.getDefaultBackend();
    const sclient = storageBackendService.getBackendClient(backend);

    let stat;
    try {
      stat = await sclient.statObject(storageKey);
    } catch {
      return res.status(404).json({ error: 'File not found in storage', code: 'STORAGE_NOT_FOUND' });
    }

    // ── Playlist (master or media) ──────────────────────
    if (isPlaylist) {
      const stream = await sclient.getObject(storageKey);
      let body = (await collectStream(stream)).toString('utf8');
      // Signed/private: rewrite child URIs so each carries a token over its own
      // key and the SAME expiry, so the whole session shares one deadline.
      if ((file.access === 'private' || file.access === 'signed') && expires) {
        const dir = storageKey.slice(0, storageKey.lastIndexOf('/'));
        body = rewriteHlsPlaylist(body, dir, file.signing_secret, expires);
      }
      res.set('Content-Type', HLS_MIME);
      setHlsCache(res, file.access, 'playlist');
      res.set('Content-Length', Buffer.byteLength(body));
      recordAccess(file.id, 'video_play');
      return res.send(body);
    }

    // ── Segment / VTT / poster — byte streams (Range for segments) ──
    const contentType = isSegment
      ? (ext === 'm4s' ? 'video/iso.segment' : 'video/MP2T')
      : isVtt ? 'text/vtt' : (AUX_IMAGE_MIME[ext] || 'application/octet-stream');

    res.set('Content-Type', contentType);
    setHlsCache(res, file.access, isSegment ? 'segment' : 'aux');
    if (stat.etag) res.set('ETag', stat.etag);
    res.set('Accept-Ranges', 'bytes');

    if (stat.etag && req.headers['if-none-match'] === stat.etag) {
      return res.status(304).end();
    }

    const range = req.headers.range;
    if (range && isSegment) {
      const total = stat.size;
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;
      if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end < start || start >= total || end >= total) {
        return res.status(416).set('Content-Range', `bytes */${total}`).end();
      }
      const bytesServed = end - start + 1;
      res.status(206);
      res.set('Content-Range', `bytes ${start}-${end}/${total}`);
      res.set('Content-Length', bytesServed);
      const pstream = await sclient.getPartialObject(storageKey, start, bytesServed);
      pstream.pipe(res);
      trackBandwidth(file.project_id, file.id, bytesServed);
      return;
    }

    res.set('Content-Length', stat.size);
    const stream = await sclient.getObject(storageKey);
    stream.pipe(res);
    trackBandwidth(file.project_id, file.id, stat.size);
    if (isSegment) recordAccess(file.id, 'video_play');
  } catch (err) {
    next(err);
  }
}

router.get('/f/:projectId/*', serveHls);

// GET /f/:projectId/* — serve file from MinIO
router.get('/f/:projectId/*', async (req, res, next) => {
  try {
    const projectId = req.params.projectId;
    const remainder = req.params[0];
    const storageKey = `${projectId}/${remainder}`;

    // Look up file in DB
    const { rows } = await query(
      'SELECT f.*, p.signing_secret, p.settings AS project_settings, p.account_id AS project_account_id FROM files f JOIN projects p ON f.project_id = p.id WHERE f.storage_key = $1 AND f.deleted_at IS NULL',
      [storageKey]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'File not found',
        code: 'NOT_FOUND',
      });
    }

    const file = rows[0];

    // Check access
    if (file.access === 'private' || file.access === 'signed') {
      const token = req.query.token;
      const expires = req.query.expires;

      if (!token || !expires) {
        return res.status(403).json({
          error: 'Access denied. This file requires a signed URL.',
          code: 'ACCESS_DENIED',
        });
      }

      if (!validateOriginal(file.signing_secret, storageKey, token, expires)) {
        const isExpired = parseInt(expires) < Math.floor(Date.now() / 1000);
        return res.status(403).json({
          error: isExpired ? 'Signed URL has expired' : 'Invalid signature',
          code: isExpired ? 'URL_EXPIRED' : 'INVALID_SIGNATURE',
        });
      }
    }

    // If the file is archived to cold storage (no hot copy), optionally kick
    // off an on-access restore and tell the caller to retry. Runs after the
    // access check so it never leaks the existence of a private archived file.
    if (await maybeHandleArchived(req, res, file)) return;

    // If file is processing, return a status page
    if (file.status === 'processing') {
      return res
        .status(202)
        .set('Content-Type', 'text/html')
        .set('Cache-Control', 'no-store')
        .send(`
        <!DOCTYPE html>
        <html><head><meta http-equiv="refresh" content="5">
        <title>Processing...</title></head>
        <body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#111;color:#fff">
        <div style="text-align:center"><h2>File is being processed</h2><p>This page will auto-refresh.</p></div>
        </body></html>
      `);
    }

    // Resolve the physical object + backend to stream from (logical asset
    // model), falling back to the legacy key on the default backend.
    const target = await resolveStreamTarget(file, storageKey);

    // Get object stat for headers
    let stat;
    try {
      stat = await target.client.statObject(target.key);
    } catch {
      return res.status(404).json({
        error: 'File not found in storage',
        code: 'STORAGE_NOT_FOUND',
      });
    }

    // Set headers
    const etag = stat.etag;
    res.set('Content-Type', file.mime_type);
    setCacheHeaders(res, file.access);
    setContentSafetyHeaders(res, {
      mimeType: file.mime_type,
      type: file.type,
      filename: file.filename,
    });
    if (etag) res.set('ETag', etag);
    res.set('Accept-Ranges', 'bytes');

    // 304 Not Modified
    if (etag && req.headers['if-none-match'] && req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    // Handle Range requests (for video seeking)
    const range = req.headers.range;
    if (range) {
      const total = stat.size;
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;

      if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end < start || start >= total || end >= total) {
        res.status(416).set('Content-Range', `bytes */${total}`).end();
        return;
      }

      const bytesServed = end - start + 1;
      res.status(206);
      res.set('Content-Range', `bytes ${start}-${end}/${total}`);
      res.set('Content-Length', bytesServed);

      const stream = await target.client.getPartialObject(target.key, start, bytesServed);
      stream.pipe(res);

      // Track download usage (fire-and-forget)
      trackDownload(file.project_id, bytesServed).catch(() => {});
      trackBandwidth(file.project_id, file.id, bytesServed);
      recordAccess(file.id, file.type === 'video' ? 'video_play' : 'download');
    } else {
      res.set('Content-Length', stat.size);
      const stream = await target.client.getObject(target.key);
      stream.pipe(res);

      // Track download usage (fire-and-forget)
      trackDownload(file.project_id, stat.size).catch(() => {});
      trackBandwidth(file.project_id, file.id, stat.size);
      recordAccess(file.id, file.type === 'video' ? 'video_play' : 'download');
    }
  } catch (err) {
    next(err);
  }
});

/**
 * Pick the concrete output format for a transform request.
 *   - An explicit non-'auto' request format wins (already validated).
 *   - Else a non-'auto' variant format wins.
 *   - Else negotiate: AVIF when the client advertises image/avif, else WebP.
 * Always returns one of TRANSFORM_FORMATS (never 'auto').
 */
function negotiateFormat({ requestedFormat, variantFormat, accept }) {
  if (requestedFormat && requestedFormat !== 'auto' && TRANSFORM_FORMATS.includes(requestedFormat)) {
    return requestedFormat;
  }
  if (variantFormat && variantFormat !== 'auto' && TRANSFORM_FORMATS.includes(variantFormat)) {
    return variantFormat;
  }
  if (typeof accept === 'string' && accept.includes('image/avif')) return 'avif';
  return 'webp';
}

function buildImgproxyUrl(storageKey, { mode, w, h, format, quality }) {
  const q = Number.isInteger(quality) && quality >= 1 && quality <= 100 ? `/quality:${quality}` : '';
  const path = `/insecure/resize:${mode}:${w}:${h}${q}/plain/s3://${config.bucket}/${storageKey}@${format}`;
  return `${config.imgproxyUrl}${path}`;
}

/**
 * Render a transform through imgproxy and serve it, using the persistent cache
 * for public files. `spec` = { mode, w, h, format, quality, variantKey }.
 * `fileRow` (when present) supplies id/project_id/cache_version for cache keys
 * and usage tracking. Private/signed transforms are never persisted to the
 * shared cache.
 */
async function renderAndServe(req, res, { storageKey, access, spec, fileRow }) {
  const isPublic = isPublicAccess(access);
  const contentType = `image/${spec.format}`;

  // Cache lookup — public files only. A hit streams stored bytes and skips
  // imgproxy entirely.
  if (isPublic && fileRow && fileRow.id) {
    const hit = await transformCacheService.lookup(
      fileRow.id, fileRow.cache_version || 1, spec.variantKey, spec.format
    );
    if (hit) {
      res.set('Content-Type', contentType);
      setCacheHeaders(res, access);
      setContentSafetyHeaders(res, { mimeType: contentType, type: 'image' });
      res.set('X-Transform-Cache', 'HIT');
      if (hit.stat && hit.stat.etag) res.set('ETag', hit.stat.etag);
      if (hit.stat && typeof hit.stat.size === 'number') res.set('Content-Length', hit.stat.size);
      const stream = await hit.client.getObject(hit.key);
      stream.pipe(res);
      const bytes = (hit.stat && hit.stat.size) || 0;
      trackTransform(fileRow.project_id).catch(() => {});
      trackBandwidth(fileRow.project_id, fileRow.id, bytes, true);
      recordAccess(fileRow.id, 'transform');
      return;
    }
  }

  // Render via imgproxy.
  const imgproxyUrl = buildImgproxyUrl(storageKey, spec);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  let response;
  try {
    response = await fetch(imgproxyUrl, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    return res.status(response.status).json({
      error: 'Image processing failed',
      code: 'IMGPROXY_ERROR',
    });
  }

  const upstreamType = response.headers.get('content-type') || contentType;
  const body = Buffer.from(await response.arrayBuffer());

  res.set('Content-Type', upstreamType);
  setCacheHeaders(res, access);
  setContentSafetyHeaders(res, { mimeType: upstreamType, type: 'image' });
  res.set('Content-Length', body.length);
  res.set('X-Transform-Cache', isPublic ? 'MISS' : 'BYPASS');
  res.end(body);

  // Store to the shared cache for public files only (best-effort, after the
  // response is already sent).
  if (isPublic && fileRow && fileRow.id) {
    transformCacheService.store({
      projectId: fileRow.project_id,
      fileId: fileRow.id,
      cacheVersion: fileRow.cache_version || 1,
      variantKey: spec.variantKey,
      format: spec.format,
      buffer: body,
      contentType: upstreamType,
    }).catch(() => {});
  }

  if (fileRow && fileRow.id) {
    trackTransform(fileRow.project_id).catch(() => {});
    trackBandwidth(fileRow.project_id, fileRow.id, body.length, true);
    recordAccess(fileRow.id, 'transform');
  }
}

// GET /img/:type/:width/:height/f/:projectId/* — serve resized image via imgproxy
router.get('/img/:type/:width/:height/f/:projectId/*', async (req, res, next) => {
  try {
    const { type, width, height, projectId } = req.params;
    const remainder = req.params[0];
    const storageKey = `${projectId}/${remainder}`;

    // Validate resize type
    const validTypes = ['fit', 'fill', 'auto', 'force'];
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        error: 'Invalid resize type. Use: fit, fill, auto, force',
        code: 'INVALID_RESIZE_TYPE',
      });
    }

    // Validate dimensions — 0 means "derive from the other axis", so at least
    // one of the two has to be a real size.
    if (!/^\d+$/.test(width) || !/^\d+$/.test(height)) {
      return res.status(400).json({
        error: 'Width and height must be non-negative integers',
        code: 'INVALID_DIMENSIONS',
      });
    }
    const w = parseInt(width, 10);
    const h = parseInt(height, 10);
    if (w === 0 && h === 0) {
      return res.status(400).json({
        error: 'Width and height cannot both be zero',
        code: 'INVALID_DIMENSIONS',
      });
    }
    if (w > MAX_TRANSFORM_DIMENSION || h > MAX_TRANSFORM_DIMENSION) {
      return res.status(400).json({
        error: `Width and height cannot exceed ${MAX_TRANSFORM_DIMENSION}px`,
        code: 'DIMENSION_TOO_LARGE',
      });
    }

    // Validate the optional output format
    const requestedFormat = req.query.format;
    if (requestedFormat !== undefined && !TRANSFORM_FORMATS.includes(requestedFormat) && requestedFormat !== 'auto') {
      return res.status(400).json({
        error: `Invalid format. Use: ${TRANSFORM_FORMATS.join(', ')}`,
        code: 'INVALID_FORMAT',
      });
    }

    // Check file access level + settings (for strict_transforms) + cache version
    const { rows: fileRows } = await query(
      'SELECT f.access, f.id, f.project_id, p.signing_secret, f.cache_version, p.settings AS project_settings FROM files f JOIN projects p ON f.project_id = p.id WHERE f.storage_key = $1 AND f.deleted_at IS NULL',
      [storageKey]
    );

    const fileRow = fileRows[0] || null;
    // An unknown key is not known to be public, so it gets the private headers.
    const access = fileRow ? fileRow.access : null;

    // Strict transforms: when a project opts in, arbitrary /img/:mode/:w/:h
    // combos are refused — only named variants may be delivered. Default off
    // keeps the current open behavior for back-compat.
    if (fileRow && isStrictTransforms(fileRow.project_settings)) {
      return res.status(403).json({
        error: 'This project only allows named variants. Use /img/v/:variant/...',
        code: 'STRICT_TRANSFORMS',
      });
    }

    // Negotiate the concrete output format (AVIF/WebP) for signing + rendering.
    const format = negotiateFormat({ requestedFormat, accept: req.headers['accept'] });

    if (fileRow && (access === 'private' || access === 'signed')) {
      const token = req.query.token;
      const expires = req.query.expires;

      if (!token || !expires) {
        return res.status(403).json({
          error: 'Access denied. This file requires a signed URL.',
          code: 'ACCESS_DENIED',
        });
      }

      // A signed transform URL is signed with the format the caller baked in.
      // When that was 'auto' (or omitted), validate against the negotiated
      // format so the same signature covers whichever of avif/webp we serve.
      const signedFmt = requestedFormat || 'webp';
      const okExplicit = validateTransform(fileRow.signing_secret, storageKey, { mode: type, width, height, format: signedFmt }, token, expires);
      const okNegotiated = validateTransform(fileRow.signing_secret, storageKey, { mode: type, width, height, format }, token, expires);
      if (!okExplicit && !okNegotiated) {
        const isExpired = parseInt(expires) < Math.floor(Date.now() / 1000);
        return res.status(403).json({
          error: isExpired ? 'Signed URL has expired' : 'Invalid signature',
          code: isExpired ? 'URL_EXPIRED' : 'INVALID_SIGNATURE',
        });
      }
    }

    const variantKey = transformCacheService.rawVariantKey(type, w, h);
    await renderAndServe(req, res, {
      storageKey, access,
      spec: { mode: type, w, h, format, quality: undefined, variantKey },
      fileRow,
    });
  } catch (err) {
    next(err);
  }
});

// GET /img/v/:variant/f/:projectId/* — serve a named variant via imgproxy
router.get('/img/v/:variant/f/:projectId/*', async (req, res, next) => {
  try {
    const { variant, projectId } = req.params;
    const remainder = req.params[0];
    const storageKey = `${projectId}/${remainder}`;

    // Look up file + project (for the variant resolution + signing).
    const { rows: fileRows } = await query(
      'SELECT f.access, f.id, f.project_id, f.cache_version, p.signing_secret FROM files f JOIN projects p ON f.project_id = p.id WHERE f.storage_key = $1 AND f.deleted_at IS NULL',
      [storageKey]
    );
    const fileRow = fileRows[0] || null;
    const access = fileRow ? fileRow.access : null;

    // Resolve the variant against the file's project (stored, else built-in).
    // Unknown files still resolve built-ins so serving does not depend on a DB
    // row existing, but access defaults to private for anything unrecognized.
    const resolved = await variantService.resolveVariant(
      fileRow ? fileRow.project_id : projectId, variant
    );
    if (!resolved) {
      return res.status(404).json({
        error: `Unknown variant "${variant}"`,
        code: 'UNKNOWN_VARIANT',
      });
    }

    // Optional per-request format override, validated against the format list.
    const requestedFormat = req.query.format;
    if (requestedFormat !== undefined && !TRANSFORM_FORMATS.includes(requestedFormat) && requestedFormat !== 'auto') {
      return res.status(400).json({
        error: `Invalid format. Use: ${TRANSFORM_FORMATS.join(', ')}`,
        code: 'INVALID_FORMAT',
      });
    }

    const format = negotiateFormat({
      requestedFormat,
      variantFormat: resolved.format,
      accept: req.headers['accept'],
    });

    if (fileRow && (access === 'private' || access === 'signed')) {
      const token = req.query.token;
      const expires = req.query.expires;
      if (!token || !expires) {
        return res.status(403).json({
          error: 'Access denied. This file requires a signed URL.',
          code: 'ACCESS_DENIED',
        });
      }
      // Accept a signature over the negotiated format or over 'auto' (so a URL
      // signed before negotiation still validates whichever variant we serve).
      const okAuto = validateVariant(fileRow.signing_secret, storageKey, { variant, format: 'auto' }, token, expires);
      const okFmt = validateVariant(fileRow.signing_secret, storageKey, { variant, format }, token, expires);
      if (!okAuto && !okFmt) {
        const isExpired = parseInt(expires) < Math.floor(Date.now() / 1000);
        return res.status(403).json({
          error: isExpired ? 'Signed URL has expired' : 'Invalid signature',
          code: isExpired ? 'URL_EXPIRED' : 'INVALID_SIGNATURE',
        });
      }
    }

    const variantKey = transformCacheService.namedVariantKey(resolved.name);
    await renderAndServe(req, res, {
      storageKey, access,
      spec: {
        mode: resolved.mode, w: resolved.width, h: resolved.height,
        format, quality: resolved.quality || undefined, variantKey,
      },
      fileRow,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
