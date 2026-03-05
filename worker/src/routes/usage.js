const { Router } = require('express');
const auth = require('../middleware/auth');
const { getCurrentUsage, getUsageHistory } = require('../services/usageService');

const router = Router();

// GET /api/v1/usage — current period usage
router.get('/api/v1/usage', auth('read'), async (req, res, next) => {
  try {
    const usage = await getCurrentUsage(req.project);
    res.json(usage);
  } catch (err) {
    next(err);
  }
});

// GET /api/v1/usage/history — daily usage history
router.get('/api/v1/usage/history', auth('read'), async (req, res, next) => {
  try {
    const days = Math.min(90, Math.max(1, parseInt(req.query.days) || 30));
    const history = await getUsageHistory(req.project.id, days);
    res.json(history);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
