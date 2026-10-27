/**
 * `GET /api/search`
 */

import { Router } from 'express';
import { createSearchController } from '../controllers/search.controller.js';
import { createRateLimiter } from '../middleware/rateLimit.js';
import { asyncHandler } from '../middleware/asyncHandler.js';

export function createSearchRoutes({ services }) {
  const { config, logger, searchEngine, wikipediaSearch } = services;
  const controller = createSearchController({ searchEngine, wikipediaSearch, config, logger });

  const limiter = createRateLimiter({
    windowMs: config.api.rateLimitWindowMs,
    max: config.api.searchRateLimit,
    name: 'searches',
    logger,
  });

  const router = Router();
  router.get('/', limiter, asyncHandler(controller.search));
  router.limiter = limiter;
  return router;
}

export default createSearchRoutes;

export function createSuggestRoutes({ services }) {
  const { config, logger, searchEngine, wikipediaSearch } = services;
  const controller = createSearchController({ searchEngine, wikipediaSearch, config, logger });
  const limiter = createRateLimiter({
    windowMs: config.api.rateLimitWindowMs,
    max: config.api.searchRateLimit,
    name: 'suggestions',
    logger,
  });
  const router = Router();
  router.get('/', limiter, asyncHandler(controller.suggest));
  router.limiter = limiter;
  return router;
}
