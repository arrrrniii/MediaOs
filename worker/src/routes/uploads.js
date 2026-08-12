const { Router } = require('express');
const express = require('express');
const auth = require('../middleware/auth');
const directUploadService = require('../services/directUploadService');
const multipartUploadService = require('../services/multipartUploadService');
const { ACCESS_LEVELS } = require('../services/fileService');
const config = require('../config');

const router = Router();

// Raw binary body parser for the byte-transfer routes (direct PUT, part PUT).
// Accepts any content type up to the configured max file size.
const rawBody = express.raw({ type: () => true, limit: config.maxFileSize });

function invalidAccess(access) {
  return access !== undefined && access !== null && access !== '' && !ACCESS_LEVELS.includes(access);
}

// ── Direct one-time uploads ──────────────────────────────

// POST /api/v1/uploads/direct — create a one-time presigned upload grant
router.post('/api/v1/uploads/direct', auth('upload'), async (req, res, next) => {
  try {
    const body = req.body || {};
    if (invalidAccess(body.access)) {
      return res.status(400).json({ error: 'Invalid access level. Use: public, private, signed', code: 'INVALID_ACCESS' });
    }

    // Idempotency: a completed prior upload with this key returns the file.
    const idempotencyKey = req.headers['idempotency-key'] || body.idempotency_key;
    if (idempotencyKey) {
      const { findByIdempotencyKey } = require('../services/fileService');
      const existing = await findByIdempotencyKey(req.project.id, idempotencyKey);
      if (existing) {
        return res.status(200).json({ idempotent_replay: true, file: existing });
      }
    }

    const grant = await directUploadService.createGrant(req.project, {
      contentType: body.content_type,
      maxBytes: body.max_bytes,
      access: body.access,
      folder: body.folder,
      idempotencyKey,
      ttlMs: body.expires_in ? parseInt(body.expires_in, 10) * 1000 : undefined,
    });

    res.set('Cache-Control', 'no-store');
    res.status(201).json(grant);
  } catch (err) {
    next(err);
  }
});

// PUT /api/v1/uploads/direct/:token — consume a grant (single-use, token-auth)
router.put('/api/v1/uploads/direct/:token', rawBody, async (req, res, next) => {
  try {
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (buffer.length === 0) {
      return res.status(400).json({ error: 'No file bytes provided', code: 'NO_FILE' });
    }
    const result = await directUploadService.consumeGrant(req.params.token, buffer, req.headers['content-type']);
    res.set('Cache-Control', 'no-store');
    res.status(result._statusCode || 200).json(result);
  } catch (err) {
    if (err.status && err.code) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

// ── Resumable multipart uploads ──────────────────────────

// POST /api/v1/uploads/multipart/start — begin a resumable session
router.post('/api/v1/uploads/multipart/start', auth('upload'), async (req, res, next) => {
  try {
    const body = req.body || {};
    if (invalidAccess(body.access)) {
      return res.status(400).json({ error: 'Invalid access level. Use: public, private, signed', code: 'INVALID_ACCESS' });
    }
    const idempotencyKey = req.headers['idempotency-key'] || body.idempotency_key;
    const result = await multipartUploadService.startSession(req.project, {
      filename: body.filename,
      size: body.size,
      contentType: body.content_type,
      folder: body.folder,
      access: body.access,
      idempotencyKey,
    });
    res.set('Cache-Control', 'no-store');
    res.status(result.idempotent_replay ? 200 : 201).json(result);
  } catch (err) {
    if (err.status && err.code) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

// GET /api/v1/uploads/multipart/:id — session state (resume)
router.get('/api/v1/uploads/multipart/:id', auth('upload'), async (req, res, next) => {
  try {
    const result = await multipartUploadService.getSession(req.project, req.params.id);
    res.json(result);
  } catch (err) {
    if (err.status && err.code) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

// PUT /api/v1/uploads/multipart/:id/parts/:partNumber — upload a part
router.put('/api/v1/uploads/multipart/:id/parts/:partNumber', auth('upload'), rawBody, async (req, res, next) => {
  try {
    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const result = await multipartUploadService.uploadPart(req.project, req.params.id, req.params.partNumber, buffer);
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (err) {
    if (err.status && err.code) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

// POST /api/v1/uploads/multipart/:id/complete — assemble + process
router.post('/api/v1/uploads/multipart/:id/complete', auth('upload'), async (req, res, next) => {
  try {
    const result = await multipartUploadService.completeSession(req.project, req.params.id);
    res.set('Cache-Control', 'no-store');
    res.json(result);
  } catch (err) {
    if (err.status && err.code) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

// POST /api/v1/uploads/multipart/:id/abort — abort + cleanup
router.post('/api/v1/uploads/multipart/:id/abort', auth('upload'), async (req, res, next) => {
  try {
    const result = await multipartUploadService.abortSession(req.project, req.params.id);
    res.json(result);
  } catch (err) {
    if (err.status && err.code) {
      return res.status(err.status).json({ error: err.message, code: err.code });
    }
    next(err);
  }
});

module.exports = router;
