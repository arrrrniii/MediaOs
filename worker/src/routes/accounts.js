const { Router } = require('express');
const bcrypt = require('bcrypt');
const adminAuth = require('../middleware/adminAuth');
const { query } = require('../db');

const router = Router();

// POST /api/v1/accounts — create a new account
router.post('/api/v1/accounts', adminAuth, async (req, res, next) => {
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
      passwordHash = await bcrypt.hash(password, 12);
    }

    const { rows } = await query(
      `INSERT INTO accounts (name, email, password_hash, plan, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, plan, status, metadata, created_at, updated_at`,
      [name, email, passwordHash, plan, JSON.stringify(metadata)]
    );

    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/accounts — list all accounts
router.get('/api/v1/accounts', adminAuth, async (req, res, next) => {
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

// Simple IP-based rate limiting for login (10 attempts per minute)
const loginAttempts = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, data] of loginAttempts) {
    if (data.resetAt < now) loginAttempts.delete(key);
  }
}, 60000).unref();

function loginRateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const minuteBucket = Math.floor(now / 60000);
  const key = `login:${ip}:${minuteBucket}`;
  const resetAt = (minuteBucket + 1) * 60000;

  let data = loginAttempts.get(key);
  if (!data || data.resetAt < now) {
    data = { count: 0, resetAt };
    loginAttempts.set(key, data);
  }
  data.count++;

  if (data.count > 10) {
    const retryAfter = Math.ceil((resetAt - now) / 1000);
    return res.status(429).json({
      error: 'Too many login attempts',
      code: 'RATE_LIMITED',
      retry_after: retryAfter,
    });
  }
  next();
}

// POST /api/v1/accounts/login — authenticate account (for dashboard)
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

// PATCH /api/v1/accounts/:id/password — change password
router.patch('/api/v1/accounts/:id/password', adminAuth, async (req, res, next) => {
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

    const { rows } = await query(
      "SELECT id, password_hash FROM accounts WHERE id = $1 AND status = 'active'",
      [req.params.id]
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

    const newHash = await bcrypt.hash(new_password, 12);
    await query(
      'UPDATE accounts SET password_hash = $1 WHERE id = $2',
      [newHash, req.params.id]
    );

    res.json({ updated: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
