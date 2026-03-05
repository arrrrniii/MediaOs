const express = require('express');
const helmet = require('helmet');
const corsMiddleware = require('./middleware/cors');
const rateLimit = require('./middleware/rateLimit');
const errorHandler = require('./middleware/errorHandler');
const healthRoutes = require('./routes/health');
const accountRoutes = require('./routes/accounts');
const projectRoutes = require('./routes/projects');
const apiKeyRoutes = require('./routes/apiKeys');
const uploadRoutes = require('./routes/upload');
const fileRoutes = require('./routes/files');
const serveRoutes = require('./routes/serve');
const webhookRoutes = require('./routes/webhooks');
const usageRoutes = require('./routes/usage');
const adminFileRoutes = require('./routes/adminFiles');
const adminWebhookRoutes = require('./routes/adminWebhooks');
const adminUsageRoutes = require('./routes/adminUsage');
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
  app.set('trust proxy', 1);

  // Health check (no auth)
  app.use(healthRoutes);

  // Setup route (no auth — only works when 0 accounts exist)
  app.use(setupRoutes);

  // Admin routes (master key auth)
  app.use(accountRoutes);
  app.use(projectRoutes);
  app.use(apiKeyRoutes);
  app.use(adminFileRoutes);
  app.use(adminWebhookRoutes);
  app.use(adminUsageRoutes);

  // File routes (API key auth + rate limiting)
  app.use('/api/v1/upload', rateLimit);
  app.use('/api/v1/files', rateLimit);
  app.use('/api/v1/webhooks', rateLimit);
  app.use('/api/v1/usage', rateLimit);
  app.use(uploadRoutes);
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
