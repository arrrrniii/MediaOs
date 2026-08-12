/**
 * GET /metrics — Prometheus exposition.
 *
 * Gating (documented for the operator):
 *   - METRICS_PUBLIC=true            → no auth (bind the port privately).
 *   - else METRICS_TOKEN set         → require that token via X-Metrics-Token
 *                                      or `Authorization: Bearer <token>`.
 *   - else                           → require MASTER_KEY (adminAuth).
 * The default (nothing set) therefore requires the master key, so an exposed
 * worker never leaks metrics unauthenticated.
 */

const { Router } = require('express');
const adminAuth = require('../middleware/adminAuth');
const metrics = require('../observability/metrics');
const { constantTimeCompare } = require('../utils/crypto');

const router = Router();

const METRICS_PUBLIC = process.env.METRICS_PUBLIC === 'true';
const METRICS_TOKEN = process.env.METRICS_TOKEN || '';

function gate(req, res, next) {
  if (METRICS_PUBLIC) return next();

  if (METRICS_TOKEN) {
    let token = req.headers['x-metrics-token'];
    if (!token) {
      const auth = req.headers['authorization'];
      if (auth && auth.startsWith('Bearer ')) token = auth.slice(7);
    }
    if (token && constantTimeCompare(token, METRICS_TOKEN)) return next();
    return res.status(401).json({ error: 'Metrics token required', code: 'AUTH_REQUIRED' });
  }

  return adminAuth(req, res, next);
}

router.get('/metrics', gate, async (_req, res, next) => {
  try {
    res.set('Content-Type', metrics.register.contentType);
    res.end(await metrics.register.metrics());
  } catch (err) {
    next(err);
  }
});

module.exports = router;
