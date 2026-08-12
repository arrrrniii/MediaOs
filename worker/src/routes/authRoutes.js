const { Router } = require('express');
const bcrypt = require('bcrypt');
const config = require('../config');
const { query } = require('../db');
const ipRateLimit = require('../middleware/ipRateLimit');
const { requireInternalSecret } = require('../middleware/sessionAuth');
const {
  findUserByEmail,
  listAccountsForUser,
  ensureOwnerUser,
} = require('../services/identityService');

const router = Router();

const loginRateLimit = ipRateLimit('login', config.loginRateLimit, {
  identifiers: (req, ip) => [
    ip,
    req.body && req.body.email ? `email:${String(req.body.email).toLowerCase()}` : null,
  ],
});

function invalidCredentials(res) {
  return res.status(401).json({
    error: 'Invalid email or password',
    code: 'AUTH_INVALID',
  });
}

/**
 * POST /api/v1/auth/login
 *
 * Called server-to-server by the dashboard, so it is protected by the shared
 * internal secret rather than a session. Returns the user plus every account
 * they hold a membership in — the dashboard picks one as the active account
 * and sends it back as x-account-id on subsequent requests.
 */
router.post('/api/v1/auth/login', requireInternalSecret, loginRateLimit, async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        error: 'Email and password are required',
        code: 'VALIDATION_ERROR',
      });
    }

    let user = await findUserByEmail(email);

    if (user) {
      if (!user.password_hash) return invalidCredentials(res);
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) return invalidCredentials(res);
    } else {
      // Pre-005 data: the account row is still the login identity. Verify
      // against it once, then promote it to a user + owner membership so
      // every later login takes the path above.
      const { rows } = await query(
        "SELECT id, name, email, password_hash FROM accounts WHERE email = $1 AND status = 'active'",
        [email]
      );
      if (rows.length === 0 || !rows[0].password_hash) return invalidCredentials(res);

      const account = rows[0];
      const valid = await bcrypt.compare(password, account.password_hash);
      if (!valid) return invalidCredentials(res);

      user = await ensureOwnerUser({
        accountId: account.id,
        name: account.name,
        email: account.email,
        passwordHash: account.password_hash,
      });
      if (!user) return invalidCredentials(res);
    }

    const accounts = await listAccountsForUser(user.id);

    res.json({
      user: { id: user.id, name: user.name, email: user.email },
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        plan: a.plan,
        role: a.role,
      })),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
