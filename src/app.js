import express from 'express';
import { createRequestLogger } from './api/middleware/requestLogger.js';
import { createErrorHandler, notFoundHandler } from './api/middleware/errorHandler.js';
import { createCors } from './api/middleware/cors.js';
import { createHealthRoutes } from './api/routes/health.routes.js';
import { createSearchRoutes } from './api/routes/search.routes.js';
import { createCrawlRoutes } from './api/routes/crawl.routes.js';

/** Compose the HTTP application separately from the listening server. */
export function createApp({ services }) {
  if (!services) throw new TypeError('createApp: services are required');

  const { config, logger } = services;
  const app = express();

  // request.ip should use the platform proxy address only in production.
  if (config.isProduction) app.set('trust proxy', 1);

  app.disable('x-powered-by');
  app.use(createRequestLogger({ logger }));
  app.use(createCors({ config }));
  app.use(express.json({ limit: config.api.bodyLimit }));

  // Health remains unauthenticated and is not subject to endpoint rate limits.
  app.use('/api', createHealthRoutes({ services }));
  app.use('/api/search', createSearchRoutes({ services }));
  app.use('/api/crawl', createCrawlRoutes({ services }));

  app.use(notFoundHandler);
  app.use(createErrorHandler({ logger, config }));

  return app;
}

export default createApp;
