const { Router } = require('express');
const adminAuth = require('../middleware/adminAuth');
const loadProject = require('../middleware/loadProject');
const { getCurrentUsage, getUsageHistory } = require('../services/usageService');

const router = Router();

// GET /api/v1/projects/:id/usage — current usage (admin)
router.get('/api/v1/projects/:id/usage', adminAuth, loadProject, async (req, res, next) => {
  try {
    const usage = await getCurrentUsage(req.project);
    res.json(usage);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/projects/:id/usage/history — usage history (admin)
router.get('/api/v1/projects/:id/usage/history', adminAuth, loadProject, async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 30));
    const history = await getUsageHistory(req.project.id, days);
    res.json(history);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
