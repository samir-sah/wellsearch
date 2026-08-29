/**
 * The crawler: a worker pool over one shared frontier.
 *
 *      seeds
 *        |
 *        v
 *   +----------------+      next()      +-----------+
 *   |    URLQueue    | <--------------->| worker 1  |--+
 *   |  (per-host     |                  +-----------+  |
 *   |   buckets,     |                  | worker 2  |--+--> fetch -> parse
 *   |   dedupe,      |                  +-----------+  |      |        |
 *   |   budgets)     |      add(links)  |    ...    |--+      |        v
 *   +----------------+ <----------------+-----------+         |    IndexManager
 *                                                            v
 *                                                        onEvent (dashboard)
 *
 * The pool is `CRAWLER_CONCURRENCY` async loops, not processes: a crawl is
 * I/O bound, so while one worker awaits a socket the others run. The crawl is
 * finished when the frontier is empty *and* no worker is in flight - checking
 * only "queue empty" would stop the crawl the moment the first page is being
 * parsed, before its links were discovered.
 *
 * Every number reported by `summary()` is measured, including throughput.
 */

import { performance } from 'node:perf_hooks';
import { config as defaultConfig } from '../config/config.js';
import { logger as defaultLogger } from '../utils/logger.js';
import { URLQueue } from './urlQueue.js';
import { Fetcher } from './fetcher.js';
import { RobotsCache } from './robots.js';
import { parseDocument } from './parser.js';
import { CrawlWorker } from './worker.js';
import { isSameSite } from '../utils/url.js';

/** Recent crawl events kept for the dashboard. */
const EVENT_BUFFER = 60;

export class Crawler {
  constructor({
    config = defaultConfig,
    logger = defaultLogger,
    indexManager,
    fetcher,
    robots,
    parse = parseDocument,
    fetchImpl,
  } = {}) {
    this.config = config;
    this.logger = logger.child({ module: 'crawler' });
    this.indexManager = indexManager;
    this.parse = parse;

    this.fetcher = fetcher ?? new Fetcher({ config, logger: this.logger, fetchImpl });
    this.robots = robots ?? new RobotsCache({ fetcher: this.fetcher, config, logger: this.logger });

    this.queue = null;
    this.workers = [];
    this.controller = null;
    this.running = false;
    this.startedAt = null;
    this.finishedAt = null;
    this.stopRequested = false;
    this.events = [];
    this.errorCounts = new Map();
    this.pageCounts = { indexed: 0, updated: 0, unchanged: 0, duplicates: 0, empty: 0, noindex: 0, tooShort: 0 };
    this.lastSummary = null;
    this.options = null;
  }

  /* ----------------------------------------------------------------------- */

  /**
   * Run a crawl to completion.
   *
   * @param {object} [options]
   * @param {string[]} [options.seeds]
   * @param {number} [options.maxPages]
   * @param {number} [options.maxDepth]
   * @param {number} [options.concurrency]
   * @param {boolean} [options.sameHostOnly]
   * @param {number} [options.delayMs]
   * @param {(event: object) => void} [options.onEvent]
   * @returns {Promise<object>} the crawl summary (never rejects for page-level problems)
   */
  async crawl(options = {}) {
    if (this.running) throw new Error('a crawl is already running');

    const seeds = (options.seeds ?? this.config.seeds).filter(Boolean);
    if (seeds.length === 0) throw new Error('no seed URLs: pass seeds or set SEED_URLS');

    const concurrency = clamp(options.concurrency ?? this.config.crawler.concurrency, 1, 64);
    const maxPages = clamp(options.maxPages ?? this.config.crawler.maxPages, 1, 1_000_000);
    const maxDepth = clamp(options.maxDepth ?? this.config.crawler.maxDepth, 0, 32);
    const delayMs = clamp(options.delayMs ?? this.config.crawler.delayMs, 0, 60_000);
    const sameHostOnly = options.sameHostOnly ?? this.config.crawler.sameHostOnly;

    this.running = true;
    this.stopRequested = false;
    this.startedAt = Date.now();
    this.finishedAt = null;
    this.events = [];
    this.errorCounts = new Map();
    for (const key of Object.keys(this.pageCounts)) this.pageCounts[key] = 0;
    this.controller = new AbortController();
    this.options = { seeds, concurrency, maxPages, maxDepth, delayMs, sameHostOnly };

    this.queue = new URLQueue({
      maxDepth,
      maxPages,
      delayMs,
      maxPagesPerHost: this.config.crawler.maxPagesPerHost,
      sameHostOnly,
      maxQueued: Math.max(maxPages * 20, 1_000),
    });

    const accepted = this.queue.addSeeds(seeds);
    if (accepted === 0) {
      this.running = false;
      this.finishedAt = Date.now();
      throw new Error(`none of the ${seeds.length} seed URL(s) were usable`);
    }

    const externalListener = typeof options.onEvent === 'function' ? options.onEvent : null;
    const onEvent = (event) => {
      this.#recordEvent(event);
      if (externalListener) {
        try {
          externalListener(event);
        } catch { /* a listener must not break the crawl */ }
      }
    };

    const startPerf = performance.now();
    this.logger.info('crawl started', { seeds: seeds.length, concurrency, maxPages, maxDepth, delayMs });

    this.workers = Array.from({ length: concurrency }, (_unused, position) => new CrawlWorker({
      id: position + 1,
      queue: this.queue,
      fetcher: this.fetcher,
      robots: this.robots,
      parse: this.parse,
      config: { ...this.config, crawler: { ...this.config.crawler, delayMs } },
      logger: this.logger,
      signal: this.controller.signal,
      onEvent,
      onPage: (page) => this.#indexPage(page),
    }));

    const progress = this.#startProgressLogging();
    let workerStats = [];
    try {
      workerStats = await Promise.all(this.workers.map((worker) => worker.run()));
    } finally {
      clearInterval(progress);
      this.running = false;
      this.finishedAt = Date.now();
    }

    const durationMs = performance.now() - startPerf;
    const summary = this.#buildSummary({ durationMs, workerStats });

    // Record the summary before the final flush so both the index and its
    // crawl metadata survive a clean restart together.
    try {
      this.indexManager?.recordCrawl(summary);
      await this.indexManager?.save({ force: true });
    } catch (error) {
      this.logger.error('post-crawl save failed', { error });
    }

    this.lastSummary = summary;
    this.logger.info('crawl finished', {
      processed: summary.processed,
      successful: summary.successful,
      failed: summary.failed,
      indexed: summary.pages.indexed,
      pagesPerSecond: summary.throughput.pagesPerSecond,
      seconds: summary.durationSeconds,
    });

    return summary;
  }

  /** Ask every worker to stop after its current page. */
  stop(reason = 'requested') {
    if (!this.running) return false;
    this.stopRequested = true;
    this.logger.warn('crawl stop requested', { reason });
    this.controller?.abort();
    return true;
  }

  /* ----------------------------------------------------------------------- */

  /**
   * Index one fetched page. Returns `{indexed: false}` when the page is
   * deliberately not indexed, which the worker counts as "skipped" rather than
   * as a failure.
   */
  async #indexPage(page) {
    if (page.noindex) {
      this.pageCounts.noindex += 1;
      return { indexed: false, reason: 'noindex' };
    }

    const tokens = page.text ? page.text.length : 0;
    if (tokens < this.config.index.minDocumentLength) {
      this.pageCounts.tooShort += 1;
      return { indexed: false, reason: 'too-short' };
    }

    // Honour a same-site canonical URL so /page and /page?ref=x collapse into
    // one document; a cross-site canonical is ignored as untrustworthy.
    const url = page.canonical && isSameSite(page.url, page.canonical) ? page.canonical : page.url;

    const outcome = this.indexManager.indexDocument({
      url,
      title: page.title,
      description: page.description || (page.headings?.[0] ?? ''),
      text: page.text,
      statusCode: page.statusCode,
      contentType: page.contentType,
      lang: page.lang,
      depth: page.depth,
      linkCount: page.linkCount,
      bytes: page.bytes,
      source: 'crawl',
    });

    if (outcome.status === 'indexed') this.pageCounts.indexed += 1;
    else if (outcome.status === 'updated') this.pageCounts.updated += 1;
    else if (outcome.status === 'unchanged') this.pageCounts.unchanged += 1;
    else if (outcome.status === 'duplicate') this.pageCounts.duplicates += 1;
    else if (outcome.status === 'empty') this.pageCounts.empty += 1;

    if (outcome.status === 'duplicate' || outcome.status === 'empty') {
      return { indexed: false, reason: outcome.status };
    }
    return { indexed: true, id: outcome.id };
  }

  #recordEvent(event) {
    const entry = { ...event, at: new Date().toISOString() };
    this.events.push(entry);
    if (this.events.length > EVENT_BUFFER) this.events.shift();

    if (event.type === 'failed' || event.type === 'retry') {
      const key = event.reason ?? 'unknown';
      this.errorCounts.set(key, (this.errorCounts.get(key) ?? 0) + 1);
    }
  }

  #startProgressLogging() {
    const timer = setInterval(() => {
      if (!this.queue) return;
      const stats = this.queue.stats();
      this.logger.info('crawl progress', {
        processed: stats.processed,
        successful: stats.successful,
        failed: stats.failed,
        queued: stats.queued,
        activeWorkers: this.activeWorkers,
      });
    }, 5_000);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  get activeWorkers() {
    return this.workers.reduce((total, worker) => total + (worker.busy ? 1 : 0), 0);
  }

  #buildSummary({ durationMs, workerStats }) {
    const queueStats = this.queue.stats();
    const seconds = durationMs / 1000;
    const totals = workerStats.reduce((accumulator, stats) => ({
      bytes: accumulator.bytes + stats.bytes,
      fetchMs: accumulator.fetchMs + stats.fetchMs,
      parseMs: accumulator.parseMs + stats.parseMs,
      indexMs: accumulator.indexMs + stats.indexMs,
      waitMs: accumulator.waitMs + stats.waitMs,
      retries: accumulator.retries + stats.retries,
    }), { bytes: 0, fetchMs: 0, parseMs: 0, indexMs: 0, waitMs: 0, retries: 0 });

    const fetches = Math.max(1, queueStats.successful + queueStats.failed);

    return {
      ok: true,
      stopped: this.stopRequested,
      startedAt: new Date(this.startedAt).toISOString(),
      finishedAt: new Date(this.finishedAt).toISOString(),
      durationMs: round(durationMs, 1),
      durationSeconds: round(seconds, 2),
      options: this.options,
      processed: queueStats.processed,
      successful: queueStats.successful,
      failed: queueStats.failed,
      skipped: queueStats.skipped,
      discovered: queueStats.discovered,
      queued: queueStats.queued,
      retries: totals.retries,
      queue: queueStats,
      pages: { ...this.pageCounts },
      throughput: {
        pagesPerSecond: round(queueStats.processed / Math.max(seconds, 0.001), 2),
        bytesPerSecond: Math.round(totals.bytes / Math.max(seconds, 0.001)),
        totalBytes: totals.bytes,
        averageFetchMs: round(totals.fetchMs / fetches, 2),
        averageParseMs: round(totals.parseMs / fetches, 2),
        averageIndexMs: round(totals.indexMs / fetches, 2),
        workerWaitMs: round(totals.waitMs, 1),
      },
      errors: [...this.errorCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => ({ reason, count })),
      hosts: this.queue.hostStats(10),
      workers: this.workers.map((worker) => worker.snapshot()),
      fetcher: this.fetcher.stats(),
      robots: this.robots.stats(),
      index: this.indexManager ? this.indexManager.index.stats() : null,
    };
  }

  /** Live status for `GET /api/crawl/status`. */
  status() {
    const queueStats = this.queue ? this.queue.stats() : null;
    return {
      running: this.running,
      stopRequested: this.stopRequested,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      finishedAt: this.finishedAt ? new Date(this.finishedAt).toISOString() : null,
      elapsedMs: this.startedAt ? (this.finishedAt ?? Date.now()) - this.startedAt : 0,
      options: this.options,
      activeWorkers: this.activeWorkers,
      concurrency: this.workers.length,
      queued: queueStats?.queued ?? 0,
      processed: queueStats?.processed ?? 0,
      successful: queueStats?.successful ?? 0,
      failed: queueStats?.failed ?? 0,
      skipped: queueStats?.skipped ?? 0,
      discovered: queueStats?.discovered ?? 0,
      pages: { ...this.pageCounts },
      workers: this.workers.map((worker) => worker.snapshot()),
      hosts: this.queue ? this.queue.hostStats(5) : [],
      recentEvents: this.events.slice(-20).reverse(),
      errors: [...this.errorCounts.entries()].map(([reason, count]) => ({ reason, count })),
      lastCrawl: this.lastSummary
        ? {
          startedAt: this.lastSummary.startedAt,
          finishedAt: this.lastSummary.finishedAt,
          processed: this.lastSummary.processed,
          successful: this.lastSummary.successful,
          failed: this.lastSummary.failed,
          durationSeconds: this.lastSummary.durationSeconds,
          pagesPerSecond: this.lastSummary.throughput.pagesPerSecond,
          concurrency: this.lastSummary.options.concurrency,
          stopped: this.lastSummary.stopped,
        }
        : null,
    };
  }
}

function clamp(value, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export default Crawler;
