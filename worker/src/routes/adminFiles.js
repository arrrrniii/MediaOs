const { Router } = require('express');
const multer = require('multer');
const adminAuth = require('../middleware/adminAuth');
const loadProject = require('../middleware/loadProject');
const { listFiles, getFile, deleteFile, uploadFile } = require('../services/fileService');
const archiver = require('archiver');
const { getObject, statObject } = require('../minio');
const config = require('../config');

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxFileSize },
});

// GET /api/v1/projects/:id/files — list files (admin)
router.get('/api/v1/projects/:id/files', adminAuth, loadProject, async (req, res, next) => {
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

// DELETE /api/v1/projects/:id/files/:fileId — delete file (admin)
router.delete('/api/v1/projects/:id/files/:fileId', adminAuth, loadProject, async (req, res, next) => {
  try {
    const result = await deleteFile(req.params.fileId, req.project);
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

// POST /api/v1/projects/:id/upload — upload file (admin)
router.post('/api/v1/projects/:id/upload', adminAuth, loadProject, upload.single('file'), async (req, res, next) => {
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

// GET /api/v1/projects/:id/files/:fileId/download — download single file
router.get('/api/v1/projects/:id/files/:fileId/download', adminAuth, loadProject, async (req, res, next) => {
  try {
    const file = await getFile(req.params.fileId, req.project);
    if (!file) {
      return res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });
    }

    const stat = await statObject(file.storage_key);
    const stream = await getObject(file.storage_key);

    res.setHeader('Content-Type', file.mime_type || 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);

    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/projects/:id/files/download/zip — download all files as zip
router.get('/api/v1/projects/:id/files/download/zip', adminAuth, loadProject, async (req, res, next) => {
  try {
    const result = await listFiles(req.project, {
      page: 1,
      limit: 1000,
      folder: req.query.folder,
      type: req.query.type,
    });

    if (result.data.length === 0) {
      return res.status(404).json({
        error: 'No files to download',
        code: 'NO_FILES',
      });
    }

    const projectName = req.project.slug || req.project.name || 'mediaos';
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${projectName}-files.zip"`);

    const archive = archiver('zip', { zlib: { level: 1 } });
    archive.pipe(res);

    archive.on('error', (err) => {
      res.status(500).end();
    });

    for (const file of result.data) {
      try {
        const stream = await getObject(file.storage_key);
        const name = file.folder
          ? `${file.folder}/${file.filename}`
          : file.filename;
        archive.append(stream, { name });
      } catch {
        // Skip files that can't be read
      }
    }

    await archive.finalize();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
