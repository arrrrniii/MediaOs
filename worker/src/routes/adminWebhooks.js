const { Router } = require('express');
const adminAuth = require('../middleware/adminAuth');
const loadProject = require('../middleware/loadProject');
const { createWebhook, listWebhooks, deleteWebhook } = require('../services/webhookService');

const router = Router();

// GET /api/v1/projects/:id/webhooks — list webhooks (admin)
router.get('/api/v1/projects/:id/webhooks', adminAuth, loadProject, async (req, res, next) => {
  try {
    const webhooks = await listWebhooks(req.project.id);
    res.json({ data: webhooks });
  } catch (err) {
    next(err);
  }
});

// POST /api/v1/projects/:id/webhooks — create webhook (admin)
router.post('/api/v1/projects/:id/webhooks', adminAuth, loadProject, async (req, res, next) => {
  try {
    const { url, events } = req.body;
    if (!url) {
      return res.status(400).json({
        error: 'URL is required',
        code: 'VALIDATION_ERROR',
      });
    }
    const webhook = await createWebhook(req.project.id, url, events);
    res.status(201).json(webhook);
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/projects/:id/webhooks/:webhookId — delete webhook (admin)
router.delete('/api/v1/projects/:id/webhooks/:webhookId', adminAuth, loadProject, async (req, res, next) => {
  try {
    const deleted = await deleteWebhook(req.params.webhookId, req.project.id);
    if (!deleted) {
      return res.status(404).json({
        error: 'Webhook not found',
        code: 'NOT_FOUND',
      });
    }
    res.json({ deleted: true, id: req.params.webhookId });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
