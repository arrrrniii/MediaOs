/**
 * Video routes: subtitle upload/list, playback beacons, and playback
 * analytics. Each capability is exposed twice — session-scoped for the
 * dashboard (scoped to req.account, role-gated) and API-key-scoped for
 * programmatic use (scoped to req.project) — mirroring the delivery routes.
 */

const { Router } = require('express');
const multer = require('multer');
const auth = require('../middleware/auth');
const { sessionScope, requireRole } = require('../middleware/sessionAuth');
const { query } = require('../db');
const videoService = require('../services/videoService');
const config = require('../config');

const router = Router();

const subtitleUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: videoService.MAX_SUBTITLE_BYTES },
});

function handleError(res, err, next) {
  if (err && err.status && err.code) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  return next(err);
}

/** Load a project scoped to the session account (cross-tenant id → null). */
async function loadAccountProject(req) {
  const { rows } = await query(
    "SELECT * FROM projects WHERE id = $1 AND account_id = $2 AND status != 'deleted'",
    [req.params.id, req.account.id]
  );
  return rows[0] || null;
}

// ── Shared handlers (project already resolved onto req.videoProject) ──

async function postSubtitle(req, res, next) {
  try {
    const project = req.videoProject;
    if (!req.file) return res.status(400).json({ error: 'No subtitle file provided', code: 'NO_FILE' });
    const row = await videoService.addSubtitle({
      project,
      fileId: req.params.fileId,
      buffer: req.file.buffer,
      lang: req.query.lang || req.body.lang,
      label: req.query.label || req.body.label,
      format: req.query.format || req.body.format,
      filename: req.file.originalname,
    });
    res.status(201).json(row);
  } catch (err) {
    handleError(res, err, next);
  }
}

async function listSubtitlesHandler(req, res, next) {
  try {
    const project = req.videoProject;
    const file = await videoService.loadVideoFile(req.params.fileId, project.id);
    const rows = await videoService.listSubtitles(req.params.fileId);
    res.json({ data: videoService.buildTracks(project, file, rows) });
  } catch (err) {
    handleError(res, err, next);
  }
}

async function postPlayback(req, res, next) {
  try {
    const project = req.videoProject;
    const result = await videoService.recordPlayback({
      project,
      fileId: req.params.fileId,
      event: req.body.event,
      position: req.body.position,
      sessionId: req.body.session_id,
    });
    res.status(202).json(result);
  } catch (err) {
    handleError(res, err, next);
  }
}

async function getPlaybackPayload(req, res, next) {
  try {
    const project = req.videoProject;
    const expiresIn = Math.min(86400, Math.max(60, parseInt(req.query.expires, 10) || 3600));
    const payload = await videoService.getPlayback(project, req.params.fileId, expiresIn);
    res.json(payload);
  } catch (err) {
    handleError(res, err, next);
  }
}

async function getAnalytics(req, res, next) {
  try {
    const project = req.videoProject;
    // Confirm the file is in this project before returning its analytics.
    await videoService.loadVideoFile(req.params.fileId, project.id);
    const summary = await videoService.playbackAnalytics(req.params.fileId, { days: req.query.days });
    res.json(summary);
  } catch (err) {
    handleError(res, err, next);
  }
}

// ── Session-scoped (dashboard) ──────────────────────────

function withSessionProject(handler) {
  return async (req, res, next) => {
    const project = await loadAccountProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found', code: 'NOT_FOUND' });
    req.videoProject = project;
    return handler(req, res, next);
  };
}

router.post(
  '/api/v1/projects/:id/files/:fileId/subtitles',
  ...sessionScope, requireRole('editor'), subtitleUpload.single('file'), withSessionProject(postSubtitle)
);
router.get(
  '/api/v1/projects/:id/files/:fileId/subtitles',
  ...sessionScope, requireRole('viewer'), withSessionProject(listSubtitlesHandler)
);
router.post(
  '/api/v1/projects/:id/files/:fileId/playback',
  ...sessionScope, requireRole('viewer'), withSessionProject(postPlayback)
);
router.get(
  '/api/v1/projects/:id/files/:fileId/playback/analytics',
  ...sessionScope, requireRole('viewer'), withSessionProject(getAnalytics)
);
router.get(
  '/api/v1/projects/:id/files/:fileId/hls-url',
  ...sessionScope, requireRole('viewer'), withSessionProject(getPlaybackPayload)
);

// ── API-key-scoped (programmatic) ───────────────────────

function withKeyProject(handler) {
  return (req, res, next) => {
    req.videoProject = req.project;
    return handler(req, res, next);
  };
}

router.post(
  '/api/v1/files/:fileId/subtitles',
  auth('upload'), subtitleUpload.single('file'), withKeyProject(postSubtitle)
);
router.get(
  '/api/v1/files/:fileId/subtitles',
  auth('read'), withKeyProject(listSubtitlesHandler)
);
router.post(
  '/api/v1/files/:fileId/playback',
  auth('read'), withKeyProject(postPlayback)
);
router.get(
  '/api/v1/files/:fileId/playback/analytics',
  auth('read'), withKeyProject(getAnalytics)
);
router.get(
  '/api/v1/files/:fileId/hls-url',
  auth('read'), withKeyProject(getPlaybackPayload)
);

module.exports = router;
