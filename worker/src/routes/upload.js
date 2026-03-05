const { Router } = require('express');
const multer = require('multer');
const auth = require('../middleware/auth');
const { uploadFile } = require('../services/fileService');
const config = require('../config');

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileSize },
});

// POST /api/v1/upload — single file upload
router.post('/api/v1/upload', auth('upload'), upload.single('file'), async (req, res, next) => {
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
    };

    const result = await uploadFile(req.file, req.project, options, req.app.locals.queue);
    const statusCode = result._statusCode || 200;
    delete result._statusCode;

    res.set('Cache-Control', 'no-store');
    res.status(statusCode).json(result);
  } catch (err) {
    next(err);
  }
});

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
    };

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
