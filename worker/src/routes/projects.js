const { Router } = require('express');
const crypto = require('crypto');
const adminAuth = require('../middleware/adminAuth');
const { query } = require('../db');
const { getCurrentUsage } = require('../services/usageService');

const router = Router();

// POST /api/v1/projects — create a new project
router.post('/api/v1/projects', adminAuth, async (req, res, next) => {
  try {
    const { account_id, name, slug, description, settings } = req.body;

    if (!account_id || !name) {
      return res.status(400).json({
        error: 'account_id and name are required',
        code: 'VALIDATION_ERROR',
      });
    }

    // Verify account exists
    const { rows: accounts } = await query(
      "SELECT id FROM accounts WHERE id = $1 AND status = 'active'",
      [account_id]
    );
    if (accounts.length === 0) {
      return res.status(404).json({
        error: 'Account not found',
        code: 'ACCOUNT_NOT_FOUND',
      });
    }

    // Generate slug if not provided
    const projectSlug = slug || name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    // Check duplicate slug for this account
    const { rows: existing } = await query(
      'SELECT id FROM projects WHERE account_id = $1 AND slug = $2',
      [account_id, projectSlug]
    );
    if (existing.length > 0) {
      return res.status(409).json({
        error: 'Project slug already exists for this account',
        code: 'DUPLICATE_SLUG',
      });
    }

    // Generate signing secret
    const signingSecret = crypto.randomBytes(32).toString('hex');

    // Merge settings with defaults
    const defaultSettings = {
      max_file_size: 104857600,
      allowed_types: ['image', 'video', 'file'],
      webp_quality: 80,
      max_width: 1600,
      max_height: 1600,
      default_access: 'public',
    };
    const mergedSettings = { ...defaultSettings, ...(settings || {}) };

    const { rows } = await query(
      `INSERT INTO projects (account_id, name, slug, description, signing_secret, settings)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, account_id, name, slug, description, status, signing_secret, settings, storage_used, file_count, created_at, updated_at`,
      [account_id, name, projectSlug, description || null, signingSecret, JSON.stringify(mergedSettings)]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/projects — list projects (paginated)
router.get('/api/v1/projects', adminAuth, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const accountId = req.query.account_id;
    const status = req.query.status;

    const conditions = ["status != 'deleted'"];
    const params = [];

    if (accountId) {
      params.push(accountId);
      conditions.push(`account_id = $${params.length}`);
    }
    if (status) {
      params.push(status);
      conditions.push(`status = $${params.length}`);
    }

    const whereClause = 'WHERE ' + conditions.join(' AND ');

    const { rows: countRows } = await query(
      `SELECT COUNT(*) FROM projects ${whereClause}`,
      params
    );
    const total = parseInt(countRows[0].count);

    const dataParams = [...params, limit, offset];
    const { rows } = await query(
      `SELECT id, account_id, name, slug, description, status, settings, storage_used, file_count, created_at, updated_at
       FROM projects ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    res.json({ data: rows, total, page, limit });
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/projects/:id — get project details with usage summary
router.get('/api/v1/projects/:id', adminAuth, async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT id, account_id, name, slug, description, status, settings, storage_used, file_count, created_at, updated_at
       FROM projects WHERE id = $1 AND status != 'deleted'`,
      [req.params.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'Project not found',
        code: 'NOT_FOUND',
      });
    }

    const project = rows[0];
    const usage = await getCurrentUsage(project);
    res.json({ ...project, usage });
  } catch (err) {
    next(err);
  }
});

// PATCH /api/v1/projects/:id — update project settings
router.patch('/api/v1/projects/:id', adminAuth, async (req, res, next) => {
  try {
    const { rows: existing } = await query(
      "SELECT * FROM projects WHERE id = $1 AND status != 'deleted'",
      [req.params.id]
    );

    if (existing.length === 0) {
      return res.status(404).json({
        error: 'Project not found',
        code: 'NOT_FOUND',
      });
    }

    const project = existing[0];
    const { name, description, settings } = req.body;

    // Merge settings with existing
    const mergedSettings = settings
      ? { ...((typeof project.settings === 'string' ? JSON.parse(project.settings) : project.settings) || {}), ...settings }
      : undefined;

    const updates = [];
    const params = [];

    if (name !== undefined) {
      params.push(name);
      updates.push(`name = $${params.length}`);
    }
    if (description !== undefined) {
      params.push(description);
      updates.push(`description = $${params.length}`);
    }
    if (mergedSettings !== undefined) {
      params.push(JSON.stringify(mergedSettings));
      updates.push(`settings = $${params.length}`);
    }

    if (updates.length === 0) {
      return res.status(400).json({
        error: 'No fields to update',
        code: 'VALIDATION_ERROR',
      });
    }

    params.push(req.params.id);
    const { rows } = await query(
      `UPDATE projects SET ${updates.join(', ')} WHERE id = $${params.length}
       RETURNING id, account_id, name, slug, description, status, settings, storage_used, file_count, created_at, updated_at`,
      params
    );

    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/projects/:id — soft delete project
router.delete('/api/v1/projects/:id', adminAuth, async (req, res, next) => {
  try {
    const projectId = req.params.id;

    const { rowCount } = await query(
      "UPDATE projects SET status = 'deleted' WHERE id = $1 AND status != 'deleted'",
      [projectId]
    );

    if (rowCount === 0) {
      return res.status(404).json({
        error: 'Project not found',
        code: 'NOT_FOUND',
      });
    }

    // Cascade: soft-delete all files
    query(
      'UPDATE files SET deleted_at = NOW() WHERE project_id = $1 AND deleted_at IS NULL',
      [projectId]
    ).catch(() => {});

    // Cascade: revoke all API keys
    query(
      "UPDATE api_keys SET status = 'revoked' WHERE project_id = $1 AND status = 'active'",
      [projectId]
    ).catch(() => {});

    res.json({ deleted: true, id: projectId });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
