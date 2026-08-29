/**
 * `GET /api/health` and `GET /api/stats`
 *
 * Health is the endpoint Render polls, so it is deliberately cheap: in-memory
 * counters only, no disk I/O, no locks. It answers "can this process serve a
 * search right now", which is the only question a load balancer is asking.
 *
 * Stats is the expensive one (it stats the data files) and backs the developer
 * dashboard. Every number in it is read from the live objects - the index, the
 * search engine's latency ring buffer, the crawler's queue counters. None of it
 * is hard-coded or estimated.
 */

import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler.js';
import { memoryUsage, publicConfig, VERSION } from '../../services.js';

export function createHealthRoutes({ services }) {
  const { config, indexManager, searchEngine, crawlManager, startedAt } = services;
  const router = Router();

  /** GET /api/health */
  router.get('/health', (request, response) => {
    const index = indexManager.index;
    const crawl = crawlManager.crawler;

    response.set('Cache-Control', 'no-store');
    response.json({
      status: 'ok',
      service: 'NixSearch',
      version: VERSION,
      env: config.env,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      timestamp: new Date().toISOString(),
      index: {
        documents: index.documentCount,
        terms: index.termCount,
        averageDocumentLength: round(index.averageDocumentLength, 2),
        lastSavedAt: indexManager.lastSavedAt,
      },
      crawler: {
        running: crawlManager.running,
        activeWorkers: crawl.activeWorkers,
        processed: crawl.queue ? crawl.queue.processed : 0,
      },
      search: {
        queries: searchEngine.queryCount,
        errors: searchEngine.errorCount,
      },
      memory: memoryUsage(),
    });
  });

  /** Liveness: the process is up. Never touches application state. */
  router.get('/health/live', (request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json({ status: 'ok', pid: process.pid });
  });

  /**
   * Readiness: the index finished loading. Distinct from liveness so a slow
   * cold start does not get the instance killed.
   */
  router.get('/health/ready', (request, response) => {
    const ready = services.load !== undefined;
    response.set('Cache-Control', 'no-store');
    response.status(ready ? 200 : 503).json({
      status: ready ? 'ready' : 'starting',
      documents: indexManager.index.documentCount,
      loadedFrom: indexManager.loadedFrom,
    });
  });

  /** GET /api/stats - everything the dashboard shows. */
  router.get('/stats', asyncHandler(async (request, response) => {
    response.set('Cache-Control', 'no-store');
    response.json(await services.stats());
  }));

  /** GET /api/config - non-secret effective configuration. */
  router.get('/config', (request, response) => {
    response.json(publicConfig(config));
  });

  return router;
}

function round(value, digits) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export default createHealthRoutes;
