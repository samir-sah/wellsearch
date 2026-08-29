/**
 * In-memory fixed-window rate limiting.
 *
 * Enough to stop one client from monopolising a small free-tier instance, and
 * honest about what it is not: per-process (two instances = two budgets) and
 * keyed on a client IP that a proxy can forge. For a single-instance deployment
 * behind Render's proxy that is the right trade - no Redis, no dependency.
 *
 * Buckets are swept lazily plus on a slow interval, so an idle server does not
 * hold a map entry for every IP that ever visited.
 */

import { rateLimited } from '../../utils/errors.js';

const SWEEP_INTERVAL_MS = 60_000;
const MAX_TRACKED_KEYS = 20_000;

export function createRateLimiter({
  windowMs,
  max,
  name = 'requests',
  logger,
  now = () => Date.now(),
}) {
  /** @type {Map<string, {count: number, resetAt: number, warned: boolean}>} */
  const buckets = new Map();

  const sweep = setInterval(() => {
    const timestamp = now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= timestamp) buckets.delete(key);
    }
  }, SWEEP_INTERVAL_MS);
  if (typeof sweep.unref === 'function') sweep.unref();

  const middleware = function rateLimit(request, response, next) {
    const key = clientKey(request);
    const timestamp = now();

    let bucket = buckets.get(key);
    if (bucket === undefined || bucket.resetAt <= timestamp) {
      // A full map means we are under something abnormal; drop the oldest half
      // rather than growing without bound.
      if (buckets.size >= MAX_TRACKED_KEYS) {
        let removed = 0;
        for (const existing of buckets.keys()) {
          buckets.delete(existing);
          if (++removed >= MAX_TRACKED_KEYS / 2) break;
        }
      }
      bucket = { count: 0, resetAt: timestamp + windowMs, warned: false };
      buckets.set(key, bucket);
    }

    bucket.count += 1;
    const remaining = Math.max(0, max - bucket.count);
    const resetSeconds = Math.ceil((bucket.resetAt - timestamp) / 1000);

    response.setHeader('X-RateLimit-Limit', String(max));
    response.setHeader('X-RateLimit-Remaining', String(remaining));
    response.setHeader('X-RateLimit-Reset', String(resetSeconds));

    if (bucket.count > max) {
      response.setHeader('Retry-After', String(Math.max(1, resetSeconds)));
      if (!bucket.warned) {
        bucket.warned = true;
        logger?.warn('rate limit exceeded', { key, name, limit: max, windowMs });
      }
      next(rateLimited(`too many ${name}: limit is ${max} per ${Math.round(windowMs / 1000)}s`, {
        limit: max,
        windowMs,
        retryAfterSeconds: Math.max(1, resetSeconds),
      }));
      return;
    }

    next();
  };

  middleware.reset = () => buckets.clear();
  middleware.size = () => buckets.size;
  middleware.stop = () => clearInterval(sweep);
  return middleware;
}

/**
 * Client identity for limiting. `request.ip` already honours `trust proxy`,
 * which app.js configures for the hosting environment.
 */
function clientKey(request) {
  return request.ip || request.socket?.remoteAddress || 'unknown';
}

export default createRateLimiter;
