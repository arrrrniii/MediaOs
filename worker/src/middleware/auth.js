const { validateKey } = require('../services/keyService');
const { query } = require('../db');

function auth(requiredScope) {
  return async (req, res, next) => {
    // 1. Extract key from request
    let key = req.headers['x-api-key'];
    if (!key) {
      const authHeader = req.headers['authorization'];
      if (authHeader && authHeader.startsWith('Bearer ')) {
        key = authHeader.slice(7);
      }
    }

    if (!key) {
      return res.status(401).json({
        error: 'API key required',
        code: 'AUTH_REQUIRED',
      });
    }

    // 2-6. Validate key (prefix lookup, SHA-256 compare, expiry check)
    const apiKey = await validateKey(key);
    if (!apiKey) {
      return res.status(403).json({
        error: 'Invalid or expired API key',
        code: 'AUTH_INVALID',
      });
    }

    // 7. Check scopes
    if (requiredScope && !apiKey.scopes.includes(requiredScope)) {
      return res.status(403).json({
        error: `Insufficient scope. Required: ${requiredScope}`,
        code: 'INSUFFICIENT_SCOPE',
      });
    }

    // 8. Load project
    const { rows } = await query(
      "SELECT * FROM projects WHERE id = $1 AND status = 'active'",
      [apiKey.project_id]
    );

    if (rows.length === 0) {
      return res.status(403).json({
        error: 'Project not found or inactive',
        code: 'PROJECT_INACTIVE',
      });
    }

    // 9-10. Set req.apiKey and req.project
    req.apiKey = apiKey;
    req.project = rows[0];

    // 11. Update last_used_at (fire-and-forget)
    query(
      'UPDATE api_keys SET last_used_at = NOW() WHERE id = $1',
      [apiKey.id]
    ).catch(() => {});

    next();
  };
}

module.exports = auth;
