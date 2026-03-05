const { Router } = require('express');
const crypto = require('crypto');
const { query } = require('../db');
const { getObject, getPartialObject, statObject } = require('../minio');
const { constantTimeCompare } = require('../utils/crypto');
const { trackDownload, trackTransform, trackBandwidth } = require('../services/usageService');
const config = require('../config');

const router = Router();

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

      // Validate expiry
      if (parseInt(expires) < Math.floor(Date.now() / 1000)) {
        return res.status(403).json({
          error: 'Signed URL has expired',
          code: 'URL_EXPIRED',
        });
      }

      // Validate signature
      const payload = `${storageKey}:${expires}`;
      const expected = crypto
        .createHmac('sha256', file.signing_secret)
        .update(payload)
        .digest('hex');

      if (!constantTimeCompare(token, expected)) {
        return res.status(403).json({
          error: 'Invalid signature',
          code: 'INVALID_SIGNATURE',
        });
      }
    }

    // If file is processing, return a status page
    if (file.status === 'processing') {
      return res.status(202).set('Content-Type', 'text/html').send(`
        <!DOCTYPE html>
        <html><head><meta http-equiv="refresh" content="5">
        <title>Processing...</title></head>
        <body style="display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;background:#111;color:#fff">
        <div style="text-align:center"><h2>File is being processed</h2><p>This page will auto-refresh.</p></div>
        </body></html>
      `);
    }

    // Get object stat for headers
    let stat;
    try {
      stat = await statObject(storageKey);
    } catch {
      return res.status(404).json({
        error: 'File not found in storage',
        code: 'STORAGE_NOT_FOUND',
      });
    }

    // Set headers
    res.set('Content-Type', file.mime_type);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('ETag', stat.etag);
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Accept-Ranges', 'bytes');

    // Handle Range requests (for video seeking)
    const range = req.headers.range;
    if (range) {
      const total = stat.size;
      const parts = range.replace(/bytes=/, '').split('-');
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : total - 1;

      if (start >= total || end >= total) {
        res.status(416).set('Content-Range', `bytes */${total}`).end();
        return;
      }

      const bytesServed = end - start + 1;
      res.status(206);
      res.set('Content-Range', `bytes ${start}-${end}/${total}`);
      res.set('Content-Length', bytesServed);

      const stream = await getPartialObject(storageKey, start, bytesServed);
      stream.pipe(res);

      // Track download usage (fire-and-forget)
      trackDownload(file.project_id, bytesServed).catch(() => {});
      trackBandwidth(file.project_id, file.id, bytesServed);
    } else {
      res.set('Content-Length', stat.size);
      const stream = await getObject(storageKey);
      stream.pipe(res);

      // Track download usage (fire-and-forget)
      trackDownload(file.project_id, stat.size).catch(() => {});
      trackBandwidth(file.project_id, file.id, stat.size);
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

    // Check file access level
    const { rows: fileRows } = await query(
      'SELECT f.access, f.id, f.project_id, p.signing_secret FROM files f JOIN projects p ON f.project_id = p.id WHERE f.storage_key = $1 AND f.deleted_at IS NULL',
      [storageKey]
    );

    if (fileRows.length > 0 && (fileRows[0].access === 'private' || fileRows[0].access === 'signed')) {
      const token = req.query.token;
      const expires = req.query.expires;

      if (!token || !expires) {
        return res.status(403).json({
          error: 'Access denied. This file requires a signed URL.',
          code: 'ACCESS_DENIED',
        });
      }

      if (parseInt(expires) < Math.floor(Date.now() / 1000)) {
        return res.status(403).json({
          error: 'Signed URL has expired',
          code: 'URL_EXPIRED',
        });
      }

      const payload = `${storageKey}:${expires}`;
      const expected = crypto
        .createHmac('sha256', fileRows[0].signing_secret)
        .update(payload)
        .digest('hex');

      if (!constantTimeCompare(token, expected)) {
        return res.status(403).json({
          error: 'Invalid signature',
          code: 'INVALID_SIGNATURE',
        });
      }
    }

    // Proxy to imgproxy
    const imgproxyPath = `/insecure/resize:${type}:${width}:${height}/plain/s3://${config.bucket}/${storageKey}`;
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
    res.set('Content-Type', response.headers.get('content-type') || 'image/webp');
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Access-Control-Allow-Origin', '*');

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
    }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
