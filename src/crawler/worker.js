/**
 * One crawl worker: a single async loop that pulls URLs from the shared queue
 * until the frontier is empty.
 *
 * Concurrency model - there are no threads here, and none are needed. A crawl
 * is I/O bound: a worker spends its time awaiting a socket, and while it awaits,
 * the event loop runs the other workers. N workers therefore give close to N
 * times the throughput up to the point where the network or the target host
 * becomes the bottleneck, at a fraction of the memory of N processes.
 * `scripts/benchmark.js` measures exactly this (1 vs 4 vs 8 workers).
 *
 * The loop is written so that *nothing* a page can do stops it: fetch failures,
 * parse failures, indexing failures and unexpected exceptions are all caught,
 * counted and turned into the next iteration.
 */

import { sleep } from '../utils/async.js';

/** How long to wait before re-checking a queue that is empty but not drained. */
const IDLE_POLL_MS = 15;
/** Upper bound on a single politeness wait, so stop() stays responsive. */
const MAX_WAIT_SLICE_MS = 200;

export const WORKER_STATES = ['idle', 'waiting', 'robots', 'fetching', 'parsing', 'indexing', 'stopped'];

export class CrawlWorker {
  /**
   * @param {object} options
   * @param {number} options.id
   * @param {import('./urlQueue.js').URLQueue} options.queue
   * @param {import('./fetcher.js').Fetcher} options.fetcher
   * @param {import('./robots.js').RobotsCache} options.robots
   * @param {(page: object) => void|Promise<void>} options.onPage
   * @param {(event: object) => void} [options.onEvent]
   * @param {object} options.config
   * @param {object} options.logger
   * @param {AbortSignal} [options.signal]
   * @param {(html: string, url: string) => object} options.parse
   */
  constructor({ id, queue, fetcher, robots, onPage, onEvent, config, logger, signal, parse }) {
    this.id = id;
    this.queue = queue;
    this.fetcher = fetcher;
    this.robots = robots;
    this.onPage = onPage;
    this.onEvent = onEvent ?? (() => {});
    this.config = config;
    this.logger = logger;
    this.signal = signal;
    this.parse = parse;

    this.state = 'idle';
    this.currentUrl = null;
    this.startedAt = null;
    this.stats = {
      fetched: 0, failed: 0, skipped: 0, retries: 0, bytes: 0,
      fetchMs: 0, parseMs: 0, indexMs: 0, waitMs: 0, pages: 0,
    };
  }

  get busy() {
    return this.state === 'fetching' || this.state === 'parsing' ||
           this.state === 'indexing' || this.state === 'robots';
  }

  get stopped() {
    return this.state === 'stopped';
  }

  /** Run until the frontier is drained, the budget is spent, or we are aborted. */
  async run() {
    this.startedAt = Date.now();

    while (!this.signal?.aborted) {
      const next = this.queue.next();

      if (next === null) {
        // Nothing available. If other workers are still in flight they may add
        // links, so idle briefly instead of exiting.
        if (this.queue.inFlight === 0 || this.queue.remainingBudget === 0) break;
        this.state = 'idle';
        await sleep(IDLE_POLL_MS, this.signal);
        continue;
      }

      if (next.waitMs !== undefined) {
        this.state = 'waiting';
        const slice = Math.min(next.waitMs, MAX_WAIT_SLICE_MS);
        this.stats.waitMs += slice;
        await sleep(slice, this.signal);
        continue;
      }

      try {
        await this.#process(next.item);
      } catch (error) {
        // Truly unexpected: log, count, keep going. A crawl must never die
        // because of one page.
        this.queue.complete('failed');
        this.stats.failed += 1;
        this.logger.error('worker recovered from an unexpected error', {
          worker: this.id, url: next.item?.url, error,
        });
        this.onEvent({ type: 'error', url: next.item?.url, error: String(error?.message ?? error) });
      } finally {
        this.currentUrl = null;
      }
    }

    this.state = 'stopped';
    return this.stats;
  }

  async #process(item) {
    this.currentUrl = item.url;

    /* robots.txt ---------------------------------------------------------- */
    this.state = 'robots';
    const permission = await this.robots.isAllowed(item.url);
    if (!permission.allowed) {
      this.queue.complete('skipped');
      this.stats.skipped += 1;
      this.onEvent({ type: 'skipped', url: item.url, reason: `robots: ${permission.reason}` });
      return;
    }
    if (permission.crawlDelayMs) this.queue.setHostDelay(item.host, permission.crawlDelayMs);

    /* fetch --------------------------------------------------------------- */
    this.state = 'fetching';
    const fetchStart = performance.now();
    const response = await this.fetcher.fetch(item.url);
    this.stats.fetchMs += performance.now() - fetchStart;

    if (!response.ok) {
      this.#handleFailure(item, response);
      return;
    }

    this.stats.bytes += response.bytes ?? 0;

    /* parse --------------------------------------------------------------- */
    this.state = 'parsing';
    const parseStart = performance.now();
    let parsed;
    try {
      parsed = this.parse(response.text, response.url ?? item.url);
    } catch (error) {
      // Malformed markup should be survivable by construction; if the parser
      // ever throws we still count the page as failed rather than crashing.
      this.stats.parseMs += performance.now() - parseStart;
      this.queue.complete('failed');
      this.stats.failed += 1;
      this.logger.warn('parse failed', { url: item.url, error });
      this.onEvent({ type: 'failed', url: item.url, reason: `parse: ${error.message}` });
      return;
    }
    this.stats.parseMs += performance.now() - parseStart;

    /* enqueue discovered links -------------------------------------------- */
    let queued = 0;
    if (!parsed.nofollow && item.depth < this.queue.maxDepth) {
      for (const link of parsed.links) {
        if (this.queue.add(link, { depth: item.depth + 1, parent: item.url }) === 'queued') queued += 1;
      }
    }

    /* index --------------------------------------------------------------- */
    this.state = 'indexing';
    const indexStart = performance.now();
    let outcome = 'success';
    try {
      const result = await this.onPage({
        url: response.url ?? item.url,
        requestedUrl: item.url,
        canonical: parsed.canonical,
        depth: item.depth,
        title: parsed.title,
        description: parsed.description,
        text: parsed.text,
        lang: parsed.lang,
        noindex: parsed.noindex,
        headings: parsed.headings,
        statusCode: response.status,
        contentType: response.contentType,
        bytes: response.bytes,
        linkCount: parsed.linkCount,
        discoveredLinks: queued,
        fetchMs: response.durationMs,
        redirects: response.redirectCount,
        truncated: response.truncated,
      });
      if (result && result.indexed === false) outcome = 'skipped';
    } catch (error) {
      outcome = 'failed';
      this.logger.error('indexing failed', { url: item.url, error });
    }
    this.stats.indexMs += performance.now() - indexStart;

    this.queue.complete(outcome);
    if (outcome === 'success') {
      this.stats.fetched += 1;
      this.stats.pages += 1;
    } else if (outcome === 'skipped') {
      this.stats.skipped += 1;
    } else {
      this.stats.failed += 1;
    }

    this.onEvent({
      type: outcome,
      url: item.url,
      status: response.status,
      depth: item.depth,
      bytes: response.bytes,
      ms: response.durationMs,
      discovered: queued,
      title: parsed.title,
    });
  }

  /** Retry transient failures, give up on permanent ones. */
  #handleFailure(item, response) {
    if (response.errorType === 'http' && response.retryAfterMs) {
      this.queue.delayHost(item.host, response.retryAfterMs);
    }

    const canRetry = response.retryable && item.attempts < this.config.crawler.maxRetries;
    if (canRetry) {
      // Exponential-ish backoff for this host so a retry storm cannot form.
      this.queue.delayHost(item.host, this.config.crawler.delayMs * (item.attempts + 1));
      this.queue.requeue(item);
      this.stats.retries += 1;
      this.logger.debug('retrying', {
        url: item.url, attempt: item.attempts, reason: response.errorType,
      });
      this.onEvent({ type: 'retry', url: item.url, reason: response.errorType, attempt: item.attempts });
      return;
    }

    this.queue.complete('failed');
    this.stats.failed += 1;
    this.logger.debug('fetch failed', {
      url: item.url, status: response.status, type: response.errorType, error: response.error,
    });
    this.onEvent({
      type: 'failed',
      url: item.url,
      status: response.status,
      reason: response.errorType,
      error: response.error,
    });
  }

  snapshot() {
    return {
      id: this.id,
      state: this.state,
      url: this.currentUrl,
      pages: this.stats.pages,
      failed: this.stats.failed,
      skipped: this.stats.skipped,
      retries: this.stats.retries,
      bytes: this.stats.bytes,
    };
  }
}

export default CrawlWorker;
