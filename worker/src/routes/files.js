const { Router } = require('express');
const auth = require('../middleware/auth');
const { listFiles, getFile, deleteFile } = require('../services/fileService');
const { generate: generateSignedUrl } = require('../services/signedUrl');
const { query } = require('../db');

const router = Router();

// GET /api/v1/files — list files
router.get('/api/v1/files', auth('read'), async (req, res, next) => {
  try {
    const result = await listFiles(req.project, {
      page: req.query.page,
      limit: req.query.limit,
      folder: req.query.folder,
      type: req.query.type,
      search: req.query.search,
      sort: req.query.sort,
      order: req.query.order,
      status: req.query.status,
    });

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/files/:id — get single file
router.get('/api/v1/files/:id', auth('read'), async (req, res, next) => {
  try {
    const file = await getFile(req.params.id, req.project);
    if (!file) {
      return res.status(404).json({
        error: 'File not found',
        code: 'NOT_FOUND',
      });
    }
    res.json(file);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/files/:id — soft delete file
router.delete('/api/v1/files/:id', auth('delete'), async (req, res, next) => {
  try {
    const result = await deleteFile(req.params.id, req.project);
    if (!result) {
      return res.status(404).json({
        error: 'File not found',
        code: 'NOT_FOUND',
      });
    }
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/files/:id/signed-url — generate signed URL
router.get('/api/v1/files/:id/signed-url', auth('read'), async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT f.storage_key, p.signing_secret FROM files f JOIN projects p ON f.project_id = p.id WHERE f.id = $1 AND f.project_id = $2 AND f.deleted_at IS NULL',
      [req.params.id, req.project.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'File not found',
        code: 'NOT_FOUND',
      });
    }

    const expiresIn = Math.min(86400, Math.max(60, parseInt(req.query.expires) || 3600));
    const result = generateSignedUrl(req.project, rows[0].storage_key, expiresIn);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
