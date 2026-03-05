const { Router } = require('express');
const auth = require('../middleware/auth');
const { createWebhook, listWebhooks, deleteWebhook } = require('../services/webhookService');

const router = Router();

// POST /api/v1/webhooks — create webhook
router.post('/api/v1/webhooks', auth('admin'), async (req, res, next) => {
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

// GET /api/v1/webhooks — list webhooks
router.get('/api/v1/webhooks', auth('admin'), async (req, res, next) => {
  try {
    const webhooks = await listWebhooks(req.project.id);
    res.json({ data: webhooks });
  } catch (err) {
    next(err);
  }
});

// DELETE /api/v1/webhooks/:id — delete webhook
router.delete('/api/v1/webhooks/:id', auth('admin'), async (req, res, next) => {
  try {
    const deleted = await deleteWebhook(req.params.id, req.project.id);
    if (!deleted) {
      return res.status(404).json({
        error: 'Webhook not found',
        code: 'NOT_FOUND',
      });
    }
    res.json({ deleted: true, id: req.params.id });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
