const { Router } = require('express');
const multer = require('multer');
const auth = require('../middleware/auth');
const { uploadFile, ACCESS_LEVELS } = require('../services/fileService');
const config = require('../config');

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileSize },
});

// Rejected up front so a bad access level fails the whole request instead of
// every file in it individually.
function invalidAccess(access) {
  return access !== undefined && access !== null && access !== '' && !ACCESS_LEVELS.includes(access);
}

function singleUpload(streaming = false) {
  return async (req, res, next) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: 'No file provided',
          code: 'NO_FILE',
        });
      }

      const options = {
        folder: req.query.folder || req.body.folder,
        name: req.query.name || req.body.name,
        access: req.query.access || req.body.access,
        apiKeyId: req.apiKey.id,
        // Request correlation id (from requestId middleware) threaded into the
        // enqueued media job so it traces back to this upload.
        requestId: req.id,
        // Idempotency-Key header: a repeated key returns the original file
        // instead of storing a second copy.
        idempotencyKey: req.headers['idempotency-key'] || req.query.idempotency_key,
        // Normal uploads are storage-only. The dedicated /upload/stream route
        // explicitly opts a video into the expensive MP4/HLS pipeline.
        streaming,
      };

      if (invalidAccess(options.access)) {
        return res.status(400).json({
          error: 'Invalid access level. Use: public, private, signed',
          code: 'INVALID_ACCESS',
        });
      }

      const result = await uploadFile(req.file, req.project, options, req.app.locals.queue);
      const statusCode = result._statusCode || 200;
      delete result._statusCode;

      res.set('Cache-Control', 'no-store');
      res.status(statusCode).json(result);
    } catch (err) {
      next(err);
    }
  };
}

// POST /api/v1/upload — store media as-is (no video transcoding/HLS).
router.post('/api/v1/upload', auth('upload'), upload.single('file'), singleUpload(false));

// POST /api/v1/upload/stream — opt a video into MP4/HLS processing.
router.post('/api/v1/upload/stream', auth('upload'), upload.single('file'), singleUpload(true));

// POST /api/v1/upload/bulk — multiple file upload (max 20)
router.post('/api/v1/upload/bulk', auth('upload'), upload.array('files', 20), async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        error: 'No files provided',
        code: 'NO_FILES',
      });
    }

    const options = {
      folder: req.query.folder || req.body.folder,
      access: req.query.access || req.body.access,
      apiKeyId: req.apiKey.id,
      requestId: req.id,
    };

    if (invalidAccess(options.access)) {
      return res.status(400).json({
        error: 'Invalid access level. Use: public, private, signed',
        code: 'INVALID_ACCESS',
      });
    }

    const results = [];
    const errors = [];

    for (const file of req.files) {
      try {
        const result = await uploadFile(file, req.project, options, req.app.locals.queue);
        delete result._statusCode;
        results.push(result);
      } catch (err) {
        errors.push({
          filename: file.originalname,
          error: err.message,
          code: err.code || 'UPLOAD_FAILED',
        });
      }
    }

    res.set('Cache-Control', 'no-store');
    res.json({
      uploaded: results.length,
      failed: errors.length,
      files: results,
      errors,
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
