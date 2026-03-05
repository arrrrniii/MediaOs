const { query } = require('../db');

async function loadProject(req, res, next) {
  try {
    const { rows } = await query(
      "SELECT * FROM projects WHERE id = $1 AND status != 'deleted'",
      [req.params.id]
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
