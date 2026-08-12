/**
 * Account-scoped authentication for dashboard-originated requests.
 *
 * The dashboard's Next.js server holds the user's session and forwards three
 * headers on every customer operation:
 *
 *   x-internal-secret  shared secret proving the call came from the dashboard
 *                      server rather than a browser
 *   x-user-id          the authenticated user
 *   x-account-id       the account they are acting on
 *
 * The user id alone grants nothing: this middleware requires an
 * account_memberships row joining the two, and hangs req.account off that
 * membership so route handlers can scope every query by account.
 */

const config = require('../config');
const { constantTimeCompare } = require('../utils/crypto');
const { query } = require('../db');
const ipRateLimit = require('./ipRateLimit');

// Higher number = more privilege. requireRole('admin') admits owner and admin.
const ROLE_RANK = { viewer: 1, editor: 2, admin: 3, owner: 4 };

function requireInternalSecret(req, res, next) {
  if (!config.internalApiSecret) {
    return res.status(503).json({
      error: 'Internal API not configured. Set INTERNAL_API_SECRET environment variable.',
      code: 'INTERNAL_AUTH_NOT_CONFIGURED',
    });
  }

  const provided = req.headers['x-internal-secret'];
  if (!provided) {
    return res.status(401).json({
      error: 'Internal secret required',
      code: 'INTERNAL_SECRET_REQUIRED',
    });
  }

  if (!constantTimeCompare(String(provided), config.internalApiSecret)) {
    return res.status(403).json({
      error: 'Invalid internal secret',
      code: 'INTERNAL_SECRET_INVALID',
    });
  }

  next();
}

async function sessionAuth(req, res, next) {
  requireInternalSecret(req, res, async () => {
    try {
      const userId = req.headers['x-user-id'];
      const accountId = req.headers['x-account-id'];

      if (!userId || !accountId) {
        return res.status(401).json({
          error: 'x-user-id and x-account-id headers are required',
          code: 'SESSION_REQUIRED',
        });
      }

      const { rows: users } = await query(
        "SELECT id, email, name, status FROM users WHERE id = $1 AND status = 'active'",
        [userId]
      );
      if (users.length === 0) {
        return res.status(401).json({
          error: 'User not found or inactive',
          code: 'USER_INVALID',
        });
      }

      // One query answers both "is this account real and active" and
      // "may this user act on it" — a missing membership is indistinguishable
      // from a missing account, so nothing leaks about other tenants.
      const { rows: memberships } = await query(
        `SELECT m.role, a.id AS account_id, a.name AS account_name, a.plan, a.status
         FROM account_memberships m
         JOIN accounts a ON a.id = m.account_id
         WHERE m.user_id = $1 AND m.account_id = $2 AND a.status = 'active'`,
        [userId, accountId]
      );
      if (memberships.length === 0) {
        return res.status(403).json({
          error: 'You are not a member of this account',
          code: 'NOT_A_MEMBER',
        });
      }

      const membership = memberships[0];
      req.user = users[0];
      req.account = {
        id: membership.account_id,
        name: membership.account_name,
        plan: membership.plan,
        status: membership.status,
      };
      req.membershipRole = membership.role;

      next();
    } catch (err) {
      next(err);
    }
  });
}

/**
 * Gate a route on the caller's role in the active account. Roles are ranked,
 * so requireRole('editor') admits editor, admin, and owner.
 */
function requireRole(...roles) {
  const minRank = Math.min(...roles.map((r) => ROLE_RANK[r] || Infinity));

  return function requireRoleMiddleware(req, res, next) {
    const rank = ROLE_RANK[req.membershipRole] || 0;
    if (rank < minRank) {
      return res.status(403).json({
        error: `Insufficient role. Required: ${roles.join(' or ')}`,
        code: 'INSUFFICIENT_ROLE',
      });
    }
    next();
  };
}

// Counted per user rather than per IP: the dashboard reaches the worker
// server-side, so without this every customer would share one bucket.
const sessionRateLimit = ipRateLimit('session', config.sessionRateLimit, {
  identifiers: (req, ip) =>
    [req.headers['x-user-id'] ? `user:${req.headers['x-user-id']}` : ip],
});

// Every account-scoped route mounts these three, in this order. The secret
// check comes first so an unauthenticated caller cannot exhaust the limiter's
// buckets and lock the dashboard out.
const sessionScope = [
  requireInternalSecret,
  sessionRateLimit,
  sessionAuth,
];

module.exports = sessionAuth;
module.exports.sessionAuth = sessionAuth;
module.exports.sessionScope = sessionScope;
module.exports.requireRole = requireRole;
module.exports.requireInternalSecret = requireInternalSecret;
module.exports.ROLE_RANK = ROLE_RANK;
