/**
 * Service container.
 *
 * One place that builds the object graph - index -> search -> crawl - so the
 * server, the CLI scripts and the tests all get an identically wired system.
 * Tests can pass their own `config` (pointing `DATA_DIR` at a temp dir) and a
 * `fetchImpl` stub, and get the real production wiring around them.
 *
 * The index is loaded from disk *before* the HTTP server starts listening, so
 * the first request never sees a half-loaded index.
 */

import { config as defaultConfig } from './config/config.js';
import { logger as defaultLogger } from './utils/logger.js';
import { IndexManager } from './index/indexManager.js';
import { SearchEngine } from './search/searchEngine.js';
import { CrawlManager } from './crawler/crawlManager.js';

export async function createServices({
  config = defaultConfig,
  logger = defaultLogger,
  fetchImpl,
  load = true,
} = {}) {
  const startedAt = Date.now();

  const indexManager = new IndexManager({ config, logger });
  const loadResult = load ? await indexManager.load() : { skipped: true };

  // The *same* analyzer instance indexes and searches: one stop-word list, one
  // stemmer cache, so a query can never be tokenised differently to a document.
  const searchEngine = new SearchEngine({
    indexManager,
    config,
    logger,
    analyzer: indexManager.analyzer,
  });

  const crawlManager = new CrawlManager({ config, logger, indexManager, fetchImpl });

  return {
    config,
    logger,
    indexManager,
    searchEngine,
    crawlManager,
    startedAt,
    load: loadResult,

    /** Aggregate snapshot used by /api/stats and the dashboard. */
    async stats() {
      const index = await indexManager.stats();
      return {
        service: {
          name: 'NixSearch',
          version: VERSION,
          env: config.env,
          startedAt: new Date(startedAt).toISOString(),
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          nodeVersion: process.version,
          pid: process.pid,
        },
        index,
        search: searchEngine.stats(),
        crawler: crawlManager.status(),
        memory: memoryUsage(),
        config: publicConfig(config),
        load: loadResult,
      };
    },

    async close() {
      crawlManager.crawler.stop('shutdown');
      await crawlManager.wait(5_000);
      await indexManager.close();
    },
  };
}

export const VERSION = '1.0.0';

export function memoryUsage() {
  const usage = process.memoryUsage();
  return {
    rssMb: round(usage.rss / 1024 / 1024),
    heapUsedMb: round(usage.heapUsed / 1024 / 1024),
    heapTotalMb: round(usage.heapTotal / 1024 / 1024),
    externalMb: round(usage.external / 1024 / 1024),
  };
}

/** Config that is safe to expose: no tokens, no absolute paths. */
export function publicConfig(config) {
  return {
    bm25: { k1: config.bm25.k1, b: config.bm25.b },
    analyzer: {
      stemming: config.search.stemming,
      stopWords: config.search.stopWords,
      minTokenLength: config.search.minTokenLength,
      maxTokenLength: config.search.maxTokenLength,
    },
    fieldWeights: {
      title: config.index.titleWeight,
      description: config.index.descriptionWeight,
      body: config.index.bodyWeight,
    },
    index: {
      positions: config.index.storePositions,
      maxPositionsPerTerm: config.index.maxPositionsPerTerm,
      persistIntervalMs: config.index.persistIntervalMs,
      persistBatchSize: config.index.persistBatchSize,
      minDocumentLength: config.index.minDocumentLength,
    },
    search: {
      defaultLimit: config.search.defaultLimit,
      maxLimit: config.search.maxLimit,
      maxQueryLength: config.search.maxQueryLength,
      snippetLength: config.search.snippetLength,
      phraseBoost: config.search.phraseBoost,
    },
    crawler: {
      concurrency: config.crawler.concurrency,
      maxPages: config.crawler.maxPages,
      maxDepth: config.crawler.maxDepth,
      delayMs: config.crawler.delayMs,
      requestTimeout: config.crawler.requestTimeout,
      maxRetries: config.crawler.maxRetries,
      respectRobots: config.crawler.respectRobots,
      sameHostOnly: config.crawler.sameHostOnly,
      userAgent: config.crawler.userAgent,
    },
    api: {
      crawlEnabled: config.api.crawlEnabled,
      adminTokenRequired: Boolean(config.api.adminToken),
      searchRateLimit: config.api.searchRateLimit,
      crawlRateLimit: config.api.crawlRateLimit,
      rateLimitWindowMs: config.api.rateLimitWindowMs,
    },
  };
}

function round(value) {
  return Math.round(value * 10) / 10;
}

export default createServices;
