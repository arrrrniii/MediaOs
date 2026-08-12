/**
 * Delivery management routes: named variants CRUD, transform-cache purge, and
 * responsive srcset. Each capability is exposed twice — once session-scoped
 * (dashboard, scoped to req.account) and once API-key-scoped (programmatic,
 * scoped to req.project).
 */

const { Router } = require('express');
const auth = require('../middleware/auth');
const { sessionScope, requireRole } = require('../middleware/sessionAuth');
const { query } = require('../db');
const variantService = require('../services/variantService');
const transformCacheService = require('../services/transformCacheService');
const fileService = require('../services/fileService');

const router = Router();

/**
 * Load a project scoped to the session account. Returns the row or null; a
 * project id from another tenant reads as null (→ 404).
 */
async function loadAccountProject(req) {
  const { rows } = await query(
    "SELECT * FROM projects WHERE id = $1 AND account_id = $2 AND status != 'deleted'",
    [req.params.id, req.account.id]
  );
  return rows[0] || null;
}

// ── Named variants (session-scoped) ──────────────────────

// GET /api/v1/projects/:id/variants — list stored variants (+ built-ins)
router.get('/api/v1/projects/:id/variants', ...sessionScope, requireRole('viewer'), async (req, res, next) => {
  try {
    const project = await loadAccountProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found', code: 'NOT_FOUND' });
    const variants = await variantService.listVariants(project.id);
    res.json({ data: variants, builtins: Object.values(variantService.BUILTIN_VARIANTS) });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/projects/:id/variants — create/update a named variant
router.post('/api/v1/projects/:id/variants', ...sessionScope, requireRole('editor'), async (req, res, next) => {
  try {
    const project = await loadAccountProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found', code: 'NOT_FOUND' });
    const variant = await variantService.createVariant(project.id, req.body || {});
    res.status(201).json(variant);
  } catch (err) {
    if (err.status && err.code) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

// POST /api/v1/projects/:id/variants/defaults — seed thumbnail/card/hero
router.post('/api/v1/projects/:id/variants/defaults', ...sessionScope, requireRole('editor'), async (req, res, next) => {
  try {
    const project = await loadAccountProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found', code: 'NOT_FOUND' });
    const created = await variantService.seedDefaults(project.id);
    res.status(201).json({ data: created });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/projects/:id/variants/:name — delete a named variant
router.delete('/api/v1/projects/:id/variants/:name', ...sessionScope, requireRole('editor'), async (req, res, next) => {
  try {
    const project = await loadAccountProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found', code: 'NOT_FOUND' });
    const deleted = await variantService.deleteVariant(project.id, req.params.name);
    if (!deleted) return res.status(404).json({ error: 'Variant not found', code: 'NOT_FOUND' });
    res.json({ deleted: true, name: req.params.name });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/projects/:id/files/:fileId/purge-cache — bump cache_version
router.post('/api/v1/projects/:id/files/:fileId/purge-cache', ...sessionScope, requireRole('editor'), async (req, res, next) => {
  try {
    const project = await loadAccountProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found', code: 'NOT_FOUND' });
    const { rows } = await query(
      'SELECT id FROM files WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL',
      [req.params.fileId, project.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });
    const result = await transformCacheService.purge(req.params.fileId, project.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/projects/:id/files/:fileId/srcset — responsive srcset
router.get('/api/v1/projects/:id/files/:fileId/srcset', ...sessionScope, requireRole('viewer'), async (req, res, next) => {
  try {
    const project = await loadAccountProject(req);
    if (!project) return res.status(404).json({ error: 'Project not found', code: 'NOT_FOUND' });
    const widths = req.query.widths ? String(req.query.widths).split(',').map((w) => parseInt(w, 10)).filter(Boolean) : undefined;
    const result = await fileService.getSrcset(req.params.fileId, project, {
      widths, mode: req.query.mode, format: req.query.format, sizes: req.query.sizes,
    });
    if (!result) return res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });
    res.json(result);
  } catch (err) {
    if (err.status && err.code) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

// ── Named variants (API-key scoped) ──────────────────────

// GET /api/v1/variants — list variants for the key's project
router.get('/api/v1/variants', auth('read'), async (req, res, next) => {
  try {
    const variants = await variantService.listVariants(req.project.id);
    res.json({ data: variants, builtins: Object.values(variantService.BUILTIN_VARIANTS) });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/variants — create/update a named variant
router.post('/api/v1/variants', auth('admin'), async (req, res, next) => {
  try {
    const variant = await variantService.createVariant(req.project.id, req.body || {});
    res.status(201).json(variant);
  } catch (err) {
    if (err.status && err.code) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

// DELETE /api/v1/variants/:name — delete a named variant
router.delete('/api/v1/variants/:name', auth('admin'), async (req, res, next) => {
  try {
    const deleted = await variantService.deleteVariant(req.project.id, req.params.name);
    if (!deleted) return res.status(404).json({ error: 'Variant not found', code: 'NOT_FOUND' });
    res.json({ deleted: true, name: req.params.name });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/files/:id/purge-cache — bump cache_version (API-key)
router.post('/api/v1/files/:id/purge-cache', auth('delete'), async (req, res, next) => {
  try {
    const { rows } = await query(
      'SELECT id FROM files WHERE id = $1 AND project_id = $2 AND deleted_at IS NULL',
      [req.params.id, req.project.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });
    const result = await transformCacheService.purge(req.params.id, req.project.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/files/:id/srcset — responsive srcset (API-key)
router.get('/api/v1/files/:id/srcset', auth('read'), async (req, res, next) => {
  try {
    const widths = req.query.widths ? String(req.query.widths).split(',').map((w) => parseInt(w, 10)).filter(Boolean) : undefined;
    const result = await fileService.getSrcset(req.params.id, req.project, {
      widths, mode: req.query.mode, format: req.query.format, sizes: req.query.sizes,
    });
    if (!result) return res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });
    res.json(result);
  } catch (err) {
    if (err.status && err.code) return res.status(err.status).json({ error: err.message, code: err.code });
    next(err);
  }
});

module.exports = router;
