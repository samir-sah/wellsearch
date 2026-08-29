/**
 * Search endpoint.
 *
 * The controller is a thin adapter: validate and coerce query parameters, call
 * the engine, hand back its response. All ranking, timing and snippet work
 * lives in `SearchEngine` so it can be unit tested without HTTP.
 *
 * `took` in the response body is the engine's own `performance.now()`
 * measurement of the search - it is a real number, not a constant, and the
 * per-phase breakdown in `timings` sums to it.
 */

import { badRequest } from '../../utils/errors.js';

/** Absurdly long query strings are rejected before any work is done. */
const HARD_QUERY_LIMIT = 8192;

export function createSearchController({ searchEngine, config, logger }) {
  const log = logger.child({ module: 'search-api' });

  /** GET /api/search */
  function search(request, response) {
    const raw = firstValue(request.query.q ?? request.query.query, 'q');

    if (raw === undefined) {
      throw badRequest('the "q" query parameter is required', {
        example: '/api/search?q=bm25%20ranking&page=1&limit=10',
      });
    }
    if (raw.length > HARD_QUERY_LIMIT) {
      throw badRequest(`query is too long (${raw.length} characters, limit ${HARD_QUERY_LIMIT})`);
    }

    const page = readInt(request.query.page, 'page', 1, 10_000);
    const limit = readInt(request.query.limit, 'limit', 1, config.search.maxLimit);
    const host = firstValue(request.query.site ?? request.query.host, 'site');
    const explain = readBool(request.query.explain, 'explain');

    let result;
    try {
      result = searchEngine.search(raw, { page, limit, host, explain });
    } catch (error) {
      // Count it in the engine's own telemetry, then let the error middleware
      // shape the response.
      searchEngine.recordError(error);
      throw error;
    }

    // Search results reflect a live index; caching them would show stale
    // rankings right after a crawl.
    response.set('Cache-Control', 'no-store');
    response.json(result);

    if (result.diagnostics?.truncated) {
      log.warn('posting scan limit reached', { query: result.query, terms: result.terms });
    }
  }

  return { search };
}

/* -------------------------------------------------------------------------- */

/**
 * Express turns `?q=a&q=b` into an array and `?q[x]=1` into an object.
 * Take the last scalar (browser-form semantics) and reject the object form
 * rather than stringifying `[object Object]` into a query.
 */
function firstValue(value, name) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const last = value.filter((entry) => typeof entry === 'string').pop();
    if (last === undefined) throw badRequest(`"${name}" must be a string`);
    return last;
  }
  throw badRequest(`"${name}" must be a string`);
}

function readInt(value, name, min, max) {
  const raw = firstValue(value, name);
  if (raw === undefined || raw === '') return undefined;
  if (!/^\d+$/.test(raw.trim())) {
    throw badRequest(`"${name}" must be a positive integer (got "${clip(raw)}")`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed < min || parsed > max) {
    throw badRequest(`"${name}" must be between ${min} and ${max} (got ${parsed})`);
  }
  return parsed;
}

function readBool(value, name) {
  const raw = firstValue(value, name);
  if (raw === undefined || raw === '') return false;
  const lower = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
  if (['0', 'false', 'no', 'off'].includes(lower)) return false;
  throw badRequest(`"${name}" must be true or false (got "${clip(lower)}")`);
}

function clip(value, max = 40) {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export default createSearchController;
