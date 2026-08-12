const { Router } = require('express');
const { sessionScope, requireRole } = require('../middleware/sessionAuth');
const loadProject = require('../middleware/loadProject');
const { createKey, revokeKey, listKeys, revealKey } = require('../services/keyService');

const router = Router();

// loadProject resolves :id against req.account, so every handler below is
// already proven to be operating on a project the caller's account owns.

// POST /api/v1/projects/:id/keys — create API key
router.post('/api/v1/projects/:id/keys', ...sessionScope, requireRole('admin'), loadProject, async (req, res, next) => {
  try {
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

    if (req.project.status !== 'active') {
      return res.status(404).json({
        error: 'Project not found',
        code: 'NOT_FOUND',
      });
    }

    const result = await createKey(req.project.id, name, scopes, {
      rate_limit,
      expires_at,
    });

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/projects/:id/keys — list keys
router.get('/api/v1/projects/:id/keys', ...sessionScope, requireRole('viewer'), loadProject, async (req, res, next) => {
  try {
    const keys = await listKeys(req.project.id);
    res.json({ data: keys });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/projects/:id/keys/:keyId/reveal — reveal full API key
router.post('/api/v1/projects/:id/keys/:keyId/reveal', ...sessionScope, requireRole('admin'), loadProject, async (req, res, next) => {
  try {
    const key = await revealKey(req.params.keyId, req.project.id);
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
router.delete('/api/v1/projects/:id/keys/:keyId', ...sessionScope, requireRole('admin'), loadProject, async (req, res, next) => {
  try {
    const revoked = await revokeKey(req.params.keyId, req.project.id);
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
