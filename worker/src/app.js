const express = require('express');
const helmet = require('helmet');
const corsMiddleware = require('./middleware/cors');
const errorHandler = require('./middleware/errorHandler');
const healthRoutes = require('./routes/health');
const authRoutes = require('./routes/authRoutes');
const accountRoutes = require('./routes/accounts');
const projectRoutes = require('./routes/projects');
const apiKeyRoutes = require('./routes/apiKeys');
const uploadRoutes = require('./routes/upload');
const uploadsRoutes = require('./routes/uploads');
const deliveryRoutes = require('./routes/delivery');
const fileRoutes = require('./routes/files');
const serveRoutes = require('./routes/serve');
const webhookRoutes = require('./routes/webhooks');
const usageRoutes = require('./routes/usage');
const adminFileRoutes = require('./routes/adminFiles');
const adminWebhookRoutes = require('./routes/adminWebhooks');
const adminUsageRoutes = require('./routes/adminUsage');
const jobRoutes = require('./routes/jobs');
const lifecycleRoutes = require('./routes/lifecycle');
const backendRoutes = require('./routes/backends');
const systemRoutes = require('./routes/system');
const setupRoutes = require('./routes/setup');
const Queue = require('./services/queue');
const config = require('./config');

function createApp() {
  const app = express();

  // Initialize processing queue
  app.locals.queue = new Queue(config.concurrency);

  // Security headers — relax CSP & CORP for CDN file-serving routes
  const cdnHelmet = helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });
  app.use('/f/', cdnHelmet);
  app.use('/img/', cdnHelmet);
  const defaultHelmet = helmet();
  app.use((req, res, next) => {
    if (req.path.startsWith('/f/') || req.path.startsWith('/img/')) return next();
    defaultHelmet(req, res, next);
  });

  // Body parsing
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // CORS
  app.use(corsMiddleware);

  // Trust proxy for rate limiting
  // Trust X-Forwarded-For only from private-range peers (nginx/compose
  // network), never from a directly-connecting public client. A hop count of 1
  // would trust the socket peer's XFF unconditionally, letting anyone reaching
  // the worker directly spoof req.ip and mint a fresh rate-limit bucket per
  // request. Combined with binding the published port to loopback (compose),
  // this keeps the per-IP limiters honest.
  app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);

  // Health check (no auth)
  app.use(healthRoutes);

  // Setup route (no auth — only works when 0 accounts exist)
  app.use(setupRoutes);

  // Dashboard login (internal secret auth)
  app.use(authRoutes);

  // Account routes: system-admin provisioning (master key) + legacy login
  // + the session-scoped password change.
  app.use(accountRoutes);

  // System health + reconciliation control (master key — operator, not tenant).
  app.use(systemRoutes);

  // Customer routes (session auth — scoped to an account membership)
  app.use(projectRoutes);
  app.use(apiKeyRoutes);
  app.use(adminFileRoutes);
  app.use(adminWebhookRoutes);
  app.use(adminUsageRoutes);
  app.use(jobRoutes);
  app.use(lifecycleRoutes);
  app.use(backendRoutes);

  // Delivery management (variants CRUD, purge-cache, srcset): session-scoped
  // routes mount alongside the other customer routes; the file carries the
  // API-key variants too.
  app.use(deliveryRoutes);

  // File routes (API key auth; the per-key rate limit runs inside auth(),
  // which is the first point at which the key — and its limit — is known)
  app.use(uploadRoutes);
  app.use(uploadsRoutes);
  app.use(fileRoutes);

  // Webhook & usage routes (API key auth)
  app.use(webhookRoutes);
  app.use(usageRoutes);

  // Public serving routes
  app.use(serveRoutes);

  // Error handler
  app.use(errorHandler);

  return app;
}

module.exports = createApp;
