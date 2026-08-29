/**
 * The shared URL frontier.
 *
 * Every worker pulls from this one object, which is what makes the crawl
 * concurrent rather than N independent crawls. It owns three concerns that are
 * easy to get wrong when spread across workers:
 *
 *   de-duplication  one canonical key per page, so two workers never fetch the
 *                   same URL and a link cycle cannot loop forever
 *   politeness      per-host pacing. Instead of one global queue (where 8
 *                   workers would hammer one host), URLs are bucketed by host
 *                   and served round-robin: hosts are crawled in parallel,
 *                   each host at most one request per CRAWL_DELAY_MS
 *   budgets         max depth, max pages, max pages per host, max queued
 *
 * `next()` returns one of:
 *   { item }        a URL that is ready to be fetched right now
 *   { waitMs }      URLs remain but every host is still cooling down
 *   null            the frontier is empty
 */

import { getHost, isHttpUrl, isSameSite, looksLikeDocument, normalizeUrl, urlKey } from '../utils/url.js';

/** How many hosts to inspect per `next()` call before giving up on "ready". */
const HOST_SCAN_LIMIT = 512;

export class URLQueue {
  constructor({
    maxDepth = 2,
    maxPages = 100,
    delayMs = 250,
    maxPagesPerHost = 100,
    sameHostOnly = false,
    maxQueued = 50_000,
    now = () => Date.now(),
  } = {}) {
    this.maxDepth = maxDepth;
    this.maxPages = maxPages;
    this.delayMs = delayMs;
    this.maxPagesPerHost = maxPagesPerHost;
    this.sameHostOnly = sameHostOnly;
    this.maxQueued = maxQueued;
    this.now = now;

    /** @type {Map<string, {items: object[], head: number, nextAllowedAt: number, enqueued: number, fetched: number}>} */
    this.hosts = new Map();
    /** @type {string[]} round-robin ring of host names */
    this.ring = [];
    this.cursor = 0;

    /** Canonical keys ever admitted to the frontier (queued, in flight or done). */
    this.seen = new Set();
    /** Canonical keys of seed pages, used for the same-host restriction. */
    this.seedUrls = [];

    this.pending = 0;
    this.dispatched = 0;
    this.processed = 0;
    this.successful = 0;
    this.failed = 0;
    this.skipped = 0;
    this.discovered = 0;
    this.retried = 0;
    this.rejected = { duplicate: 0, depth: 0, host: 0, offsite: 0, full: 0, invalid: 0, nonDocument: 0 };
  }

  /* ----------------------------------------------------------------------- */

  /** Seed the frontier. Returns the number of accepted seeds. */
  addSeeds(urls) {
    let accepted = 0;
    for (const url of urls) {
      const normalized = normalizeUrl(url);
      if (normalized === null) {
        this.rejected.invalid += 1;
        continue;
      }
      this.seedUrls.push(normalized);
      if (this.add(normalized, { depth: 0, parent: null }) === 'queued') accepted += 1;
    }
    return accepted;
  }

  /**
   * Offer a URL to the frontier.
   * @returns {'queued'|'duplicate'|'invalid'|'depth'|'host'|'offsite'|'full'|'nonDocument'}
   */
  add(url, { depth = 0, parent = null } = {}) {
    if (depth > this.maxDepth) {
      this.rejected.depth += 1;
      return 'depth';
    }
    if (this.seen.size >= this.maxQueued) {
      this.rejected.full += 1;
      return 'full';
    }

    const normalized = typeof url === 'string' && isHttpUrl(url) ? url : normalizeUrl(url, parent ?? undefined);
    if (normalized === null) {
      this.rejected.invalid += 1;
      return 'invalid';
    }
    if (!looksLikeDocument(normalized)) {
      this.rejected.nonDocument += 1;
      return 'nonDocument';
    }

    const key = urlKey(normalized);
    if (key === null) {
      this.rejected.invalid += 1;
      return 'invalid';
    }
    if (this.seen.has(key)) {
      this.rejected.duplicate += 1;
      return 'duplicate';
    }

    if (this.sameHostOnly && this.seedUrls.length > 0) {
      const onSite = this.seedUrls.some((seed) => isSameSite(seed, normalized));
      if (!onSite) {
        this.rejected.offsite += 1;
        return 'offsite';
      }
    }

    const host = getHost(normalized) ?? '';
    const bucket = this.#bucket(host);
    if (bucket.enqueued >= this.maxPagesPerHost) {
      this.rejected.host += 1;
      return 'host';
    }

    this.seen.add(key);
    bucket.items.push({
      url: normalized,
      key,
      host,
      depth,
      parent,
      attempts: 0,
      discoveredAt: this.now(),
    });
    bucket.enqueued += 1;
    this.pending += 1;
    if (depth > 0) this.discovered += 1;
    return 'queued';
  }

  #bucket(host) {
    let bucket = this.hosts.get(host);
    if (bucket === undefined) {
      bucket = { items: [], head: 0, nextAllowedAt: 0, enqueued: 0, fetched: 0, delayMs: null };
      this.hosts.set(host, bucket);
      this.ring.push(host);
    }
    return bucket;
  }

  /**
   * Per-host pacing override, used for a robots.txt `Crawl-delay`. Only ever
   * slows us down: a site asking for less delay than CRAWL_DELAY_MS is ignored.
   */
  setHostDelay(host, delayMs) {
    if (!Number.isFinite(delayMs) || delayMs <= this.delayMs) return false;
    this.#bucket(host).delayMs = Math.min(delayMs, 60_000);
    return true;
  }

  /** Back off a host after a 429/503, honouring `Retry-After` when present. */
  delayHost(host, waitMs) {
    if (!Number.isFinite(waitMs) || waitMs <= 0) return;
    const bucket = this.#bucket(host);
    bucket.nextAllowedAt = Math.max(bucket.nextAllowedAt, this.now() + Math.min(waitMs, 60_000));
  }

  /**
   * Take the next fetchable URL.
   * Reserves the host's next slot immediately, so two workers calling `next()`
   * in the same tick cannot both get a URL from the same host.
   */
  next() {
    if (this.processed + this.inFlight >= this.maxPages) return null;
    if (this.pending === 0) return null;

    const now = this.now();
    let soonest = Infinity;
    const hostCount = this.ring.length;
    const scanLimit = Math.min(hostCount, HOST_SCAN_LIMIT);

    for (let step = 0; step < scanLimit; step += 1) {
      const host = this.ring[(this.cursor + step) % hostCount];
      const bucket = this.hosts.get(host);
      if (bucket === undefined || bucket.head >= bucket.items.length) continue;

      if (bucket.nextAllowedAt > now) {
        if (bucket.nextAllowedAt < soonest) soonest = bucket.nextAllowedAt;
        continue;
      }

      const item = bucket.items[bucket.head];
      bucket.items[bucket.head] = undefined; // release the reference
      bucket.head += 1;
      if (bucket.head > 64 && bucket.head * 2 >= bucket.items.length) {
        bucket.items = bucket.items.slice(bucket.head);
        bucket.head = 0;
      }

      bucket.nextAllowedAt = now + (bucket.delayMs ?? this.delayMs);
      bucket.fetched += 1;
      this.pending -= 1;
      this.dispatched += 1;
      this.cursor = (this.cursor + step + 1) % hostCount;
      return { item };
    }

    if (soonest !== Infinity) return { waitMs: Math.max(1, soonest - now) };
    return null;
  }

  /** Put a failed item back for another attempt. */
  requeue(item) {
    const bucket = this.#bucket(item.host);
    item.attempts += 1;
    // Push to the front of the host bucket so a retry is not starved by a long
    // queue, but after the cooldown so we do not immediately re-hammer a host.
    if (bucket.head > 0) {
      bucket.head -= 1;
      bucket.items[bucket.head] = item;
    } else {
      bucket.items.unshift(item);
    }
    this.pending += 1;
    this.retried += 1;
  }

  /** Record the outcome of a fetch. */
  complete(outcome) {
    this.processed += 1;
    if (outcome === 'success') this.successful += 1;
    else if (outcome === 'skipped') this.skipped += 1;
    else this.failed += 1;
  }

  /** URLs handed to workers but not yet completed. */
  get inFlight() {
    return this.dispatched - this.processed - this.retried;
  }

  get size() {
    return this.pending;
  }

  /** True when no URL will ever become available again. */
  isDrained() {
    if (this.processed >= this.maxPages) return true;
    return this.pending === 0 && this.inFlight === 0;
  }

  get remainingBudget() {
    return Math.max(0, this.maxPages - this.processed);
  }

  stats() {
    return {
      queued: this.pending,
      inFlight: this.inFlight,
      processed: this.processed,
      successful: this.successful,
      failed: this.failed,
      skipped: this.skipped,
      discovered: this.discovered,
      retried: this.retried,
      seen: this.seen.size,
      hosts: this.hosts.size,
      maxPages: this.maxPages,
      maxDepth: this.maxDepth,
      rejected: { ...this.rejected },
    };
  }

  /** Per-host progress, for the dashboard. */
  hostStats(limit = 10) {
    return [...this.hosts.entries()]
      .map(([host, bucket]) => ({
        host,
        queued: bucket.items.length - bucket.head,
        fetched: bucket.fetched,
        enqueued: bucket.enqueued,
      }))
      .sort((a, b) => b.fetched - a.fetched)
      .slice(0, limit);
  }

  clear() {
    this.hosts.clear();
    this.ring = [];
    this.cursor = 0;
    this.seen.clear();
    this.seedUrls = [];
    this.pending = 0;
    this.dispatched = 0;
    this.processed = 0;
    this.successful = 0;
    this.failed = 0;
    this.skipped = 0;
    this.discovered = 0;
    this.retried = 0;
    for (const key of Object.keys(this.rejected)) this.rejected[key] = 0;
  }
}

export default URLQueue;
