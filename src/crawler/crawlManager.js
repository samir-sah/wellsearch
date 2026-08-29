/**
 * Crawl orchestration for the API and the CLI.
 *
 * `Crawler` knows how to run one crawl; this class owns the *lifecycle* around
 * it, which is what an HTTP endpoint actually needs:
 *
 *   - request validation, with clamping against the configured ceilings so a
 *     public deployment cannot be told to crawl a million pages
 *   - single flight: one crawl at a time, second request gets 409 rather than
 *     two worker pools fighting over the index
 *   - a job record (id, state, options, summary, error) that survives the crawl
 *     so `GET /api/crawl/status` can answer after the crawl has finished
 *   - fire-and-forget by default, so `POST /api/crawl` returns in milliseconds
 *     instead of holding a socket open for the whole crawl; `wait: true` is
 *     available for scripts and tests
 *
 * A crawl failure is data, not an exception: the job records it and the server
 * keeps serving searches.
 */

import { performance } from 'node:perf_hooks';
import { config as defaultConfig } from '../config/config.js';
import { logger as defaultLogger } from '../utils/logger.js';
import { Crawler } from './crawler.js';
import { badRequest, conflict } from '../utils/errors.js';
import { normalizeUrl } from '../utils/url.js';

const MAX_SEEDS = 50;
const HISTORY_LIMIT = 10;
/** Hard ceiling on `wait: true`, so a hung crawl cannot pin an HTTP request open. */
const MAX_WAIT_MS = 120_000;

export class CrawlManager {
  constructor({
    config = defaultConfig,
    logger = defaultLogger,
    indexManager,
    crawler,
    fetchImpl,
  } = {}) {
    this.config = config;
    this.logger = logger.child({ module: 'crawl-manager' });
    this.indexManager = indexManager;
    this.crawler = crawler ?? new Crawler({ config, logger, indexManager, fetchImpl });

    /** @type {object|null} the job currently running */
    this.activeJob = null;
    /** @type {Promise<object>|null} */
    this.activePromise = null;
    /** @type {object[]} newest first */
    this.history = [];
    this.jobCounter = 0;
    this.totals = { crawls: 0, pages: 0, failures: 0, indexed: 0 };
  }

  get running() {
    return this.activeJob !== null;
  }

  /* ----------------------------------------------------------------------- */

  /**
   * Validate and clamp a crawl request.
   * Throws `HttpError(400)` for anything unusable; returns `{options, warnings}`.
   */
  validate(raw = {}) {
    const warnings = [];
    const limits = this.config.crawler;

    const seeds = normalizeSeeds(raw.seeds ?? raw.urls ?? raw.url ?? raw.seedUrls, warnings);
    const resolved = seeds.length > 0 ? seeds : [...this.config.seeds];
    if (resolved.length === 0) {
      throw badRequest(
        'no seed URLs: provide "urls" in the request body or set SEED_URLS in the environment',
      );
    }
    if (seeds.length > MAX_SEEDS) {
      throw badRequest(`too many seed URLs (max ${MAX_SEEDS})`, { received: seeds.length });
    }

    const options = {
      seeds: resolved,
      maxPages: clampWithWarning(raw.maxPages, limits.maxPages, 1, limits.maxPages, 'maxPages', warnings),
      maxDepth: clampWithWarning(raw.maxDepth, limits.maxDepth, 0, limits.maxDepth, 'maxDepth', warnings),
      concurrency: clampWithWarning(
        raw.concurrency, limits.concurrency, 1, limits.concurrency, 'concurrency', warnings,
      ),
      delayMs: clampWithWarning(raw.delayMs, limits.delayMs, 0, 60_000, 'delayMs', warnings),
      sameHostOnly: toBoolean(raw.sameHostOnly, limits.sameHostOnly),
      clearIndex: toBoolean(raw.clear ?? raw.clearIndex, false),
    };

    if (options.delayMs < limits.delayMs) {
      // Politeness floor: a request may slow the crawl down, never speed it past
      // the operator's configured delay.
      warnings.push(`delayMs raised to the configured floor of ${limits.delayMs}ms`);
      options.delayMs = limits.delayMs;
    }

    return { options, warnings };
  }

  /**
   * Start a crawl.
   *
   * @param {object} [raw] request options (see `validate`)
   * @param {{ wait?: boolean, waitMs?: number }} [control]
   * @returns {Promise<object>} the job record; with `wait` it includes `summary`
   */
  async start(raw = {}, { wait = false, waitMs = MAX_WAIT_MS } = {}) {
    if (this.running) {
      throw conflict('a crawl is already running', {
        jobId: this.activeJob.id,
        startedAt: this.activeJob.startedAt,
        processed: this.crawler.status().processed,
      });
    }

    const { options, warnings } = this.validate(raw);

    this.jobCounter += 1;
    const job = {
      id: `crawl_${this.jobCounter}`,
      state: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      options,
      warnings,
      summary: null,
      error: null,
    };

    this.activeJob = job;
    this.#pushHistory(job);

    if (options.clearIndex) {
      this.logger.warn('clearing the index before crawling', { jobId: job.id });
      await this.indexManager.clear();
    }

    const startedPerf = performance.now();
    this.activePromise = this.crawler.crawl(options)
      .then((summary) => {
        job.state = summary.stopped ? 'stopped' : 'completed';
        job.summary = summary;
        this.totals.crawls += 1;
        this.totals.pages += summary.processed;
        this.totals.failures += summary.failed;
        this.totals.indexed += summary.pages.indexed + summary.pages.updated;
        return summary;
      })
      .catch((error) => {
        // A crawl that blows up is recorded and reported; it must not become an
        // unhandled rejection that takes the process down.
        job.state = 'failed';
        job.error = { message: error?.message ?? String(error), name: error?.name ?? 'Error' };
        this.logger.error('crawl failed', { jobId: job.id, error });
        return null;
      })
      .finally(() => {
        job.finishedAt = new Date().toISOString();
        job.durationMs = Math.round(performance.now() - startedPerf);
        this.activeJob = null;
        this.activePromise = null;
      });

    if (!wait) {
      // Detached: the promise above already handles its own errors.
      return { ...jobView(job), accepted: true, waiting: false };
    }

    const finished = await withTimeout(this.activePromise, Math.min(waitMs, MAX_WAIT_MS));
    if (finished === TIMED_OUT) {
      return { ...jobView(job), accepted: true, waiting: true, timedOut: true, status: this.status() };
    }
    return { ...jobView(job), accepted: true, waiting: false, summary: job.summary };
  }

  /** Request that the running crawl stop after its in-flight pages. */
  stop() {
    if (!this.running) return { stopped: false, reason: 'no crawl is running' };
    this.crawler.stop('api');
    return { stopped: true, jobId: this.activeJob.id };
  }

  /** Wait for the current crawl, if any. Used by tests and by shutdown. */
  async wait(waitMs = MAX_WAIT_MS) {
    if (!this.activePromise) return null;
    const result = await withTimeout(this.activePromise, waitMs);
    return result === TIMED_OUT ? null : result;
  }

  /** Everything `GET /api/crawl/status` reports. */
  status() {
    const live = this.crawler.status();
    return {
      ...live,
      job: this.activeJob ? jobView(this.activeJob) : (this.history[0] ? jobView(this.history[0]) : null),
      history: this.history.map(jobView),
      totals: { ...this.totals },
      limits: {
        maxPages: this.config.crawler.maxPages,
        maxDepth: this.config.crawler.maxDepth,
        concurrency: this.config.crawler.concurrency,
        delayMs: this.config.crawler.delayMs,
        respectRobots: this.config.crawler.respectRobots,
        userAgent: this.config.crawler.userAgent,
        seeds: this.config.seeds,
      },
    };
  }

  #pushHistory(job) {
    this.history.unshift(job);
    if (this.history.length > HISTORY_LIMIT) this.history.pop();
  }
}

/* -------------------------------------------------------------------------- */

/** Public view of a job: no summary payload, which can be large. */
function jobView(job) {
  return {
    id: job.id,
    state: job.state,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    durationMs: job.durationMs,
    options: job.options,
    warnings: job.warnings,
    error: job.error,
    result: job.summary
      ? {
        processed: job.summary.processed,
        successful: job.summary.successful,
        failed: job.summary.failed,
        skipped: job.summary.skipped,
        discovered: job.summary.discovered,
        indexed: job.summary.pages.indexed,
        updated: job.summary.pages.updated,
        duplicates: job.summary.pages.duplicates,
        durationSeconds: job.summary.durationSeconds,
        pagesPerSecond: job.summary.throughput.pagesPerSecond,
        errors: job.summary.errors,
      }
      : null,
  };
}

function normalizeSeeds(input, warnings) {
  if (input === undefined || input === null) return [];

  const raw = Array.isArray(input)
    ? input
    : String(input).split(/[\s,]+/);

  const seeds = [];
  const seen = new Set();
  for (const entry of raw) {
    if (typeof entry !== 'string' || entry.trim() === '') continue;
    const candidate = entry.trim();

    if (!/^https?:\/\//i.test(candidate)) {
      throw badRequest(`seed URL must start with http:// or https://: "${truncate(candidate)}"`);
    }
    const normalized = normalizeUrl(candidate);
    if (normalized === null) {
      throw badRequest(`seed URL could not be parsed: "${truncate(candidate)}"`);
    }
    if (seen.has(normalized)) {
      warnings.push(`duplicate seed ignored: ${normalized}`);
      continue;
    }
    seen.add(normalized);
    seeds.push(normalized);
  }
  return seeds;
}

function clampWithWarning(value, fallback, min, max, label, warnings) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed)) {
    throw badRequest(`${label} must be a number (got "${truncate(String(value))}")`);
  }
  const truncated = Math.trunc(parsed);
  if (truncated < min) {
    warnings.push(`${label} raised to the minimum of ${min}`);
    return min;
  }
  if (truncated > max) {
    warnings.push(`${label} lowered to the configured maximum of ${max}`);
    return max;
  }
  return truncated;
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const lower = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
  if (['0', 'false', 'no', 'off'].includes(lower)) return false;
  throw badRequest(`expected a boolean (got "${truncate(lower)}")`);
}

function truncate(value, max = 80) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

const TIMED_OUT = Symbol('timed-out');

function withTimeout(promise, ms) {
  if (!(ms > 0)) return Promise.resolve(TIMED_OUT);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(TIMED_OUT), ms);
    if (typeof timer.unref === 'function') timer.unref();
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

export default CrawlManager;
