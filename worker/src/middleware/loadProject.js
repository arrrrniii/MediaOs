const { query } = require('../db');

/**
 * Load the project named in :id, scoped to the account the caller is acting
 * on. A project belonging to another account is reported as 404 rather than
 * 403 so its existence stays hidden.
 *
 * Must be mounted after sessionAuth, which sets req.account.
 */
async function loadProject(req, res, next) {
  try {
    const { rows } = await query(
      "SELECT * FROM projects WHERE id = $1 AND account_id = $2 AND status != 'deleted'",
      [req.params.id, req.account.id]
    );
    if (rows.length === 0) {
      return res.status(404).json({
        error: 'Project not found',
        code: 'NOT_FOUND',
      });
    }
    req.project = rows[0];
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = loadProject;
