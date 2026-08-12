const { Router } = require('express');
const { query } = require('../db');
const { validateOriginal, validateTransform } = require('../services/signedUrl');
const { trackDownload, trackTransform, trackBandwidth } = require('../services/usageService');
const { recordAccess } = require('../services/accessTrackingService');
const fileObjectService = require('../services/fileObjectService');
const storageBackendService = require('../services/storageBackendService');
const config = require('../config');

const router = Router();

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

// GET /f/:projectId/* — serve file from MinIO
router.get('/f/:projectId/*', async (req, res, next) => {
  try {
    const projectId = req.params.projectId;
    const remainder = req.params[0];
    const storageKey = `${projectId}/${remainder}`;

    // Look up file in DB
    const { rows } = await query(
      'SELECT f.*, p.signing_secret FROM files f JOIN projects p ON f.project_id = p.id WHERE f.storage_key = $1 AND f.deleted_at IS NULL',
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
    if (requestedFormat !== undefined && !TRANSFORM_FORMATS.includes(requestedFormat)) {
      return res.status(400).json({
        error: `Invalid format. Use: ${TRANSFORM_FORMATS.join(', ')}`,
        code: 'INVALID_FORMAT',
      });
    }

    // Check file access level
    const { rows: fileRows } = await query(
      'SELECT f.access, f.id, f.project_id, p.signing_secret FROM files f JOIN projects p ON f.project_id = p.id WHERE f.storage_key = $1 AND f.deleted_at IS NULL',
      [storageKey]
    );

    // An unknown key is not known to be public, so it gets the private headers.
    const access = fileRows.length > 0 ? fileRows[0].access : null;

    if (fileRows.length > 0 && (access === 'private' || access === 'signed')) {
      const token = req.query.token;
      const expires = req.query.expires;

      if (!token || !expires) {
        return res.status(403).json({
          error: 'Access denied. This file requires a signed URL.',
          code: 'ACCESS_DENIED',
        });
      }

      const format = requestedFormat || 'webp';
      if (!validateTransform(fileRows[0].signing_secret, storageKey, { mode: type, width, height, format }, token, expires)) {
        const isExpired = parseInt(expires) < Math.floor(Date.now() / 1000);
        return res.status(403).json({
          error: isExpired ? 'Signed URL has expired' : 'Invalid signature',
          code: isExpired ? 'URL_EXPIRED' : 'INVALID_SIGNATURE',
        });
      }
    }

    // Proxy to imgproxy
    const extension = requestedFormat ? `@${requestedFormat}` : '';
    const imgproxyPath = `/insecure/resize:${type}:${w}:${h}/plain/s3://${config.bucket}/${storageKey}${extension}`;
    const imgproxyUrl = `${config.imgproxyUrl}${imgproxyPath}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch(imgproxyUrl, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(response.status).json({
        error: 'Image processing failed',
        code: 'IMGPROXY_ERROR',
      });
    }

    // Forward headers
    const contentType = response.headers.get('content-type') || 'image/webp';
    res.set('Content-Type', contentType);
    setCacheHeaders(res, access);
    setContentSafetyHeaders(res, { mimeType: contentType, type: 'image' });

    const contentLength = response.headers.get('content-length');
    if (contentLength) {
      res.set('Content-Length', contentLength);
    }

    // Stream response
    const reader = response.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    };
    await pump();

    // Track transform usage (fire-and-forget)
    if (fileRows.length > 0) {
      const bytesServed = parseInt(contentLength) || 0;
      trackTransform(fileRows[0].project_id).catch(() => {});
      trackBandwidth(fileRows[0].project_id, fileRows[0].id, bytesServed, true);
      recordAccess(fileRows[0].id, 'transform');
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
