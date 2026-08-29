/**
 * `POST /api/crawl`, `GET /api/crawl/status`, `POST /api/crawl/stop`
 *
 * Writes are rate limited separately from searches (a crawl costs far more than
 * a query) and pass through admin auth, which is a no-op until `ADMIN_TOKEN` is
 * set. `GET /status` is read-only and open, because the dashboard polls it.
 */

import { Router } from 'express';
import { createCrawlController } from '../controllers/crawl.controller.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { createAdminAuth } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

export function createCrawlRoutes({ services }) {
  const { config, logger, crawlManager } = services;
  const controller = createCrawlController({ crawlManager, config, logger });

  const limiter = createRateLimiter({
    windowMs: config.api.rateLimitWindowMs,
    max: config.api.crawlRateLimit,
    name: 'crawl requests',
    logger,
  });
  const adminAuth = createAdminAuth({ config, logger });

  const router = Router();
  router.post('/', limiter, adminAuth, asyncHandler(controller.start));
  router.get('/status', asyncHandler(controller.status));
  router.post('/stop', limiter, adminAuth, asyncHandler(controller.stop));
  router.limiter = limiter;
  return router;
}

export default createCrawlRoutes;
