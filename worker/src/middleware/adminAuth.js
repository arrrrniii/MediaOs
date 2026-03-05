const config = require('../config');
const { constantTimeCompare } = require('../utils/crypto');

function adminAuth(req, res, next) {
  if (!config.masterKey) {
    return res.status(503).json({
      error: 'Admin API not configured. Set MASTER_KEY environment variable.',
      code: 'ADMIN_NOT_CONFIGURED',
    });
  }

  // Extract key
  let key = req.headers['x-api-key'];
  if (!key) {
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      key = authHeader.slice(7);
    }
  }

  if (!key) {
    return res.status(401).json({
      error: 'Admin key required',
      code: 'AUTH_REQUIRED',
    });
  }

  if (!constantTimeCompare(key, config.masterKey)) {
    return res.status(403).json({
      error: 'Invalid admin key',
      code: 'AUTH_INVALID',
    });
  }

  next();
}

module.exports = adminAuth;
