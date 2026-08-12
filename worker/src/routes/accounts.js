const { Router } = require('express');
const bcrypt = require('bcrypt');
const config = require('../config');
const adminAuth = require('../middleware/adminAuth');
const ipRateLimit = require('../middleware/ipRateLimit');
const { sessionScope } = require('../middleware/sessionAuth');
const { query } = require('../db');
const { hashPassword, ensureOwnerUser } = require('../services/identityService');

const router = Router();

// ═══════════════════════════════════════════════════════════
//  System admin (MASTER_KEY) — provisioning across all tenants.
//  MASTER_KEY authorizes nothing customer-scoped; those routes use
//  sessionAuth and are scoped to an account membership.
// ═══════════════════════════════════════════════════════════

const systemAdmin = [ipRateLimit('admin', config.adminRateLimit), adminAuth];

// POST /api/v1/accounts — create a new account
router.post('/api/v1/accounts', ...systemAdmin, async (req, res, next) => {
  try {
    const { name, email, password, plan = 'free', metadata = {} } = req.body;

    if (!name || !email) {
      return res.status(400).json({
        error: 'Name and email are required',
        code: 'VALIDATION_ERROR',
      });
    }

    // Check duplicate email
    const { rows: existing } = await query(
      'SELECT id FROM accounts WHERE email = $1',
      [email]
    );
    if (existing.length > 0) {
      return res.status(409).json({
        error: 'Email already registered',
        code: 'DUPLICATE_EMAIL',
      });
    }

    let passwordHash = null;
    if (password) {
      passwordHash = await hashPassword(password);
    }

    const { rows } = await query(
      `INSERT INTO accounts (name, email, password_hash, plan, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, plan, status, metadata, created_at, updated_at`,
      [name, email, passwordHash, plan, JSON.stringify(metadata)]
    );

    // An account with a password is meant to be logged into, so give it a
    // login identity and an owner membership straight away.
    if (passwordHash) {
      await ensureOwnerUser({
        accountId: rows[0].id,
        name,
        email,
        passwordHash,
      });
    }

    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/accounts — list all accounts
router.get('/api/v1/accounts', ...systemAdmin, async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    const status = req.query.status;

    let whereClause = '';
    const params = [];

    if (status) {
      params.push(status);
      whereClause = `WHERE status = $${params.length}`;
    }

    const countResult = await query(
      `SELECT COUNT(*) FROM accounts ${whereClause}`,
      params
    );
    const total = parseInt(countResult.rows[0].count);

    const dataParams = [...params, limit, offset];
    const { rows } = await query(
      `SELECT id, name, email, plan, status, metadata, created_at, updated_at
       FROM accounts ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    res.json({ data: rows, total, page, limit });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
//  Legacy login — superseded by POST /api/v1/auth/login, kept so
//  older dashboard builds keep working. Removed in a later release.
// ═══════════════════════════════════════════════════════════

const loginRateLimit = ipRateLimit('login', config.loginRateLimit, {
  identifiers: (req, ip) => [
    ip,
    req.body && req.body.email ? `email:${String(req.body.email).toLowerCase()}` : null,
  ],
});

// POST /api/v1/accounts/login — authenticate against the account row
router.post('/api/v1/accounts/login', loginRateLimit, async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Email and password are required',
        code: 'VALIDATION_ERROR',
      });
    }

    const { rows } = await query(
      "SELECT * FROM accounts WHERE email = $1 AND status = 'active'",
      [email]
    );

    if (rows.length === 0 || !rows[0].password_hash) {
      return res.status(401).json({
        error: 'Invalid email or password',
        code: 'AUTH_INVALID',
      });
    }

    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({
        error: 'Invalid email or password',
        code: 'AUTH_INVALID',
      });
    }

    const account = rows[0];
    res.json({
      id: account.id,
      name: account.name,
      email: account.email,
      plan: account.plan,
      status: account.status,
    });
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════
//  Customer-scoped (session auth)
// ═══════════════════════════════════════════════════════════

// PATCH /api/v1/accounts/:id/password — change the signed-in user's password.
// The session decides whose password changes; :id only has to agree with it.
router.patch('/api/v1/accounts/:id/password', ...sessionScope, async (req, res, next) => {
  try {
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({
        error: 'current_password and new_password are required',
        code: 'VALIDATION_ERROR',
      });
    }

    if (new_password.length < 8) {
      return res.status(400).json({
        error: 'New password must be at least 8 characters',
        code: 'VALIDATION_ERROR',
      });
    }

    // Older dashboard builds pass the account id here, newer ones the user id.
    if (req.params.id !== req.user.id && req.params.id !== req.account.id) {
      return res.status(404).json({
        error: 'Account not found',
        code: 'NOT_FOUND',
      });
    }

    const { rows } = await query(
      "SELECT id, password_hash FROM users WHERE id = $1 AND status = 'active'",
      [req.user.id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        error: 'Account not found',
        code: 'NOT_FOUND',
      });
    }

    if (!rows[0].password_hash) {
      return res.status(400).json({
        error: 'Account has no password set',
        code: 'NO_PASSWORD',
      });
    }

    const valid = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!valid) {
      return res.status(401).json({
        error: 'Current password is incorrect',
        code: 'AUTH_INVALID',
      });
    }

    const newHash = await hashPassword(new_password);
    await query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [newHash, req.user.id]
    );
    // Keep the legacy accounts login in step until that column is dropped.
    await query(
      'UPDATE accounts SET password_hash = $1 WHERE email = $2',
      [newHash, req.user.email]
    );

    res.json({ updated: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
