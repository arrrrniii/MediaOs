const { Router } = require('express');
const config = require('../config');
const { query } = require('../db');
const ipRateLimit = require('../middleware/ipRateLimit');
const { hashPassword, ensureOwnerUser } = require('../services/identityService');

const router = Router();

// The strict limit guards account creation. The needsSetup probe is a plain
// boolean the login page polls on every load, so it gets a looser ceiling.
const setupRateLimit = ipRateLimit('setup', config.setupRateLimit);
const setupProbeRateLimit = ipRateLimit('setup-probe', config.setupRateLimit * 12);

// GET /api/v1/setup — check if setup is needed
router.get('/api/v1/setup', setupProbeRateLimit, async (req, res, next) => {
  try {
    const { rows } = await query('SELECT COUNT(*) FROM accounts');
    const count = parseInt(rows[0].count);
    res.json({ needsSetup: count === 0 });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/setup — create the first admin account (only works if 0 accounts)
router.post('/api/v1/setup', setupRateLimit, async (req, res, next) => {
  try {
    // Check no accounts exist
    const { rows: countRows } = await query('SELECT COUNT(*) FROM accounts');
    const count = parseInt(countRows[0].count);

    if (count > 0) {
      return res.status(403).json({
        error: 'Setup already completed',
        code: 'SETUP_DONE',
      });
    }

    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        error: 'Name, email, and password are required',
        code: 'VALIDATION_ERROR',
      });
    }

    if (password.length < 8) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters',
        code: 'VALIDATION_ERROR',
      });
    }

    const hash = await hashPassword(password);

    const { rows } = await query(
      `INSERT INTO accounts (name, email, password_hash, plan, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, plan, status, created_at`,
      [name, email, hash, 'free', 'active']
    );

    await ensureOwnerUser({
      accountId: rows[0].id,
      name,
      email,
      passwordHash: hash,
    });

    console.log(`Setup complete — admin account created for ${email}`);

    res.status(201).json(rows[0]);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
