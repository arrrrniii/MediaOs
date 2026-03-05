const { Router } = require('express');
const adminAuth = require('../middleware/adminAuth');
const { createKey, revokeKey, listKeys, revealKey } = require('../services/keyService');
const { query } = require('../db');

const router = Router();

// POST /api/v1/projects/:id/keys — create API key
router.post('/api/v1/projects/:id/keys', adminAuth, async (req, res, next) => {
  try {
    const projectId = req.params.id;
    const { name = 'Default Key', scopes = ['upload', 'read'], rate_limit, expires_at } = req.body;

    // Validate scopes
    const VALID_SCOPES = ['upload', 'read', 'delete', 'admin'];
    const invalidScopes = scopes.filter(s => !VALID_SCOPES.includes(s));
    if (invalidScopes.length > 0) {
      return res.status(400).json({
        error: `Invalid scopes: ${invalidScopes.join(', ')}. Allowed: ${VALID_SCOPES.join(', ')}`,
        code: 'INVALID_SCOPES',
      });
    }

    // Verify project exists
    const { rows: projects } = await query(
      "SELECT id FROM projects WHERE id = $1 AND status = 'active'",
      [projectId]
    );
    if (projects.length === 0) {
      return res.status(404).json({
        error: 'Project not found',
        code: 'NOT_FOUND',
      });
    }

    const result = await createKey(projectId, name, scopes, {
      rate_limit,
      expires_at,
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/projects/:id/keys — list keys
router.get('/api/v1/projects/:id/keys', adminAuth, async (req, res, next) => {
  try {
    const keys = await listKeys(req.params.id);
    res.json({ data: keys });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/projects/:id/keys/:keyId/reveal — reveal full API key
router.post('/api/v1/projects/:id/keys/:keyId/reveal', adminAuth, async (req, res, next) => {
  try {
    const key = await revealKey(req.params.keyId);
    if (!key) {
      return res.status(404).json({
        error: 'Key not found, revoked, or was created before reveal feature',
        code: 'NOT_FOUND',
      });
    }
    res.json({ key });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/projects/:id/keys/:keyId — revoke key
router.delete('/api/v1/projects/:id/keys/:keyId', adminAuth, async (req, res, next) => {
  try {
    const revoked = await revokeKey(req.params.keyId);
    if (!revoked) {
      return res.status(404).json({
        error: 'Key not found or already revoked',
        code: 'NOT_FOUND',
      });
    }
    res.json({ revoked: true, id: req.params.keyId });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
