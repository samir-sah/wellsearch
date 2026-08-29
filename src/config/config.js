/**
 * Configuration loading + validation.
 *
 * Three design goals:
 *   1. Zero dependencies - the `.env` parser is ~30 lines and covers the
 *      subset of the format that matters (KEY=value, quotes, comments).
 *   2. Fail fast - every value is validated *once* at startup and all
 *      problems are reported together, rather than surfacing as a NaN
 *      somewhere deep inside the BM25 loop.
 *   3. Testable - `buildConfig(env)` is pure, so tests can construct a
 *      configuration without touching `process.env`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repository root, resolved from this file so the cwd does not matter. */
export const ROOT_DIR = path.resolve(HERE, '..', '..');

export class ConfigError extends Error {
  constructor(problems) {
    super(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

/**
 * Parse the contents of a `.env` file.
 * Supports `KEY=value`, `export KEY=value`, `#` comments, single/double
 * quoted values (with `\n` escapes inside double quotes) and blank lines.
 */
export function parseEnvFile(contents) {
  const out = Object.create(null);
  for (const rawLine of String(contents).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const eq = line.indexOf('=');
    if (eq === -1) continue;

    const key = line.slice(0, eq).replace(/^export\s+/, '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === '"' && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else if (value.length >= 2 && value[0] === "'" && value.endsWith("'")) {
      value = value.slice(1, -1);
    } else {
      // Strip trailing inline comments for unquoted values: `PORT=3000 # http`
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load `.env` into `target` without clobbering values that are already set
 * (real environment variables always win over the file).
 */
export function loadEnvFile(file = path.join(ROOT_DIR, '.env'), target = process.env) {
  let contents;
  try {
    contents = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      process.emitWarning(`could not read ${file}: ${error.message}`);
    }
    return {};
  }
  const parsed = parseEnvFile(contents);
  for (const [key, value] of Object.entries(parsed)) {
    if (target[key] === undefined) target[key] = value;
  }
  return parsed;
}

/* -------------------------------------------------------------------------- */
/* Typed readers                                                              */
/* -------------------------------------------------------------------------- */

function createReader(env, problems) {
  const raw = (key) => {
    const value = env[key];
    if (value === undefined || value === null) return undefined;
    const trimmed = String(value).trim();
    return trimmed === '' ? undefined : trimmed;
  };

  return {
    raw,

    int(key, fallback, { min = -Infinity, max = Infinity } = {}) {
      const value = raw(key);
      if (value === undefined) return fallback;
      if (!/^-?\d+$/.test(value)) {
        problems.push(`${key} must be an integer (got "${value}")`);
        return fallback;
      }
      const parsed = Number.parseInt(value, 10);
      if (parsed < min || parsed > max) {
        problems.push(`${key} must be between ${min} and ${max} (got ${parsed})`);
        return fallback;
      }
      return parsed;
    },

    float(key, fallback, { min = -Infinity, max = Infinity } = {}) {
      const value = raw(key);
      if (value === undefined) return fallback;
      const parsed = Number.parseFloat(value);
      if (!Number.isFinite(parsed)) {
        problems.push(`${key} must be a number (got "${value}")`);
        return fallback;
      }
      if (parsed < min || parsed > max) {
        problems.push(`${key} must be between ${min} and ${max} (got ${parsed})`);
        return fallback;
      }
      return parsed;
    },

    bool(key, fallback) {
      const value = raw(key);
      if (value === undefined) return fallback;
      const lower = value.toLowerCase();
      if (['1', 'true', 'yes', 'on'].includes(lower)) return true;
      if (['0', 'false', 'no', 'off'].includes(lower)) return false;
      problems.push(`${key} must be a boolean (got "${value}")`);
      return fallback;
    },

    string(key, fallback, { allow } = {}) {
      const value = raw(key);
      if (value === undefined) return fallback;
      if (allow && !allow.includes(value)) {
        problems.push(`${key} must be one of ${allow.join(', ')} (got "${value}")`);
        return fallback;
      }
      return value;
    },

    list(key, fallback = []) {
      const value = raw(key);
      if (value === undefined) return fallback;
      return value
        .split(/[,\s]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Configuration assembly                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Build a validated, frozen configuration object from an environment map.
 * Pure: no I/O, no reliance on `process.env`.
 *
 * @param {Record<string,string|undefined>} env
 * @param {{ throwOnError?: boolean }} [options]
 */
export function buildConfig(env = process.env, { throwOnError = true } = {}) {
  const problems = [];
  const read = createReader(env, problems);

  const nodeEnv = read.string('NODE_ENV', 'development');
  const isProduction = nodeEnv === 'production';
  const isTest = nodeEnv === 'test';

  const dataDirRaw = read.string('DATA_DIR', 'data');
  const dataDir = path.isAbsolute(dataDirRaw) ? dataDirRaw : path.resolve(ROOT_DIR, dataDirRaw);

  const config = {
    env: nodeEnv,
    isProduction,
    isTest,
    port: read.int('PORT', 3000, { min: 0, max: 65535 }),
    host: read.string('HOST', '0.0.0.0'),
    corsOrigins: read.list('CORS_ORIGINS', isProduction ? [] : ['http://localhost:3001']),

    paths: {
      root: ROOT_DIR,
      data: dataDir,
      public: path.resolve(ROOT_DIR, 'public'),
      index: path.join(dataDir, 'index.json'),
      documents: path.join(dataDir, 'documents.json'),
      stats: path.join(dataDir, 'stats.json'),
    },

    crawler: {
      concurrency: read.int('CRAWLER_CONCURRENCY', 8, { min: 1, max: 128 }),
      maxPages: read.int('MAX_PAGES', 500, { min: 1, max: 1_000_000 }),
      maxDepth: read.int('MAX_DEPTH', 2, { min: 0, max: 32 }),
      requestTimeout: read.int('REQUEST_TIMEOUT', 10_000, { min: 100, max: 300_000 }),
      maxRetries: read.int('MAX_RETRIES', 2, { min: 0, max: 10 }),
      delayMs: read.int('CRAWL_DELAY_MS', 250, { min: 0, max: 60_000 }),
      maxPagesPerHost: read.int('MAX_PAGES_PER_HOST', 100, { min: 0, max: 1_000_000 }),
      sameHostOnly: read.bool('SAME_HOST_ONLY', false),
      maxContentBytes: read.int('MAX_CONTENT_BYTES', 2 * 1024 * 1024, {
        min: 1024,
        max: 64 * 1024 * 1024,
      }),
      respectRobots: read.bool('RESPECT_ROBOTS', true),
      // Loopback/private destinations are an SSRF risk. The escape hatch is
      // intentionally test-only: setting it in development or production has
      // no effect, so local fixtures cannot weaken deployed defaults.
      allowPrivateNetwork: isTest && read.bool('ALLOW_PRIVATE_NETWORK', false),
      userAgent: read.string('USER_AGENT', 'NixSearchBot/1.0 (+https://github.com/nixsearch)'),
      maxRedirects: read.int('MAX_REDIRECTS', 5, { min: 0, max: 20 }),
    },

    seeds: read.list('SEED_URLS', []),

    bm25: {
      k1: read.float('BM25_K1', 1.5, { min: 0, max: 10 }),
      b: read.float('BM25_B', 0.75, { min: 0, max: 1 }),
    },

    index: {
      storePositions: read.bool('INDEX_POSITIONS', true),
      maxPositionsPerTerm: read.int('MAX_POSITIONS_PER_TERM', 64, { min: 1, max: 100_000 }),
      maxStoredText: read.int('MAX_STORED_TEXT', 20_000, { min: 200, max: 2_000_000 }),
      titleWeight: read.int('TITLE_WEIGHT', 3, { min: 1, max: 100 }),
      descriptionWeight: read.int('DESCRIPTION_WEIGHT', 2, { min: 1, max: 100 }),
      bodyWeight: read.int('BODY_WEIGHT', 1, { min: 1, max: 100 }),
      persistIntervalMs: read.int('PERSIST_INTERVAL_MS', 15_000, { min: 0, max: 3_600_000 }),
      persistBatchSize: read.int('PERSIST_BATCH_SIZE', 25, { min: 1, max: 100_000 }),
      minDocumentLength: read.int('MIN_DOCUMENT_LENGTH', 20, { min: 0, max: 100_000 }),
    },

    search: {
      defaultLimit: read.int('SEARCH_DEFAULT_LIMIT', 10, { min: 1, max: 200 }),
      maxLimit: read.int('SEARCH_MAX_LIMIT', 50, { min: 1, max: 500 }),
      maxQueryLength: read.int('SEARCH_MAX_QUERY_LENGTH', 512, { min: 8, max: 10_000 }),
      maxQueryTerms: read.int('SEARCH_MAX_QUERY_TERMS', 32, { min: 1, max: 512 }),
      snippetLength: read.int('SNIPPET_LENGTH', 280, { min: 40, max: 2000 }),
      phraseBoost: read.float('PHRASE_BOOST', 2, { min: 1, max: 20 }),
      suggestions: read.bool('SEARCH_SUGGESTIONS', true),
      minTokenLength: read.int('MIN_TOKEN_LENGTH', 1, { min: 1, max: 10 }),
      maxTokenLength: read.int('MAX_TOKEN_LENGTH', 48, { min: 4, max: 256 }),
      stemming: read.bool('STEMMING', true),
      stopWords: read.bool('STOP_WORDS', true),
      extraStopWords: read.list('STOP_WORDS_EXTRA', []),
    },

    log: {
      level: read.string('LOG_LEVEL', isTest ? 'silent' : 'info', {
        allow: ['silent', 'error', 'warn', 'info', 'debug'],
      }),
      format: read.string('LOG_FORMAT', isProduction ? 'json' : 'pretty', {
        allow: ['json', 'pretty'],
      }),
    },

    api: {
      crawlEnabled: read.bool('CRAWL_API_ENABLED', !isProduction),
      adminToken: read.string('ADMIN_TOKEN', ''),
      rateLimitWindowMs: read.int('RATE_LIMIT_WINDOW_MS', 60_000, { min: 1000, max: 3_600_000 }),
      searchRateLimit: read.int('SEARCH_RATE_LIMIT', 120, { min: 1, max: 1_000_000 }),
      crawlRateLimit: read.int('CRAWL_RATE_LIMIT', 5, { min: 1, max: 100_000 }),
      bodyLimit: read.string('BODY_LIMIT', '64kb'),
    },

    server: {
      requestTimeoutMs: read.int('SERVER_REQUEST_TIMEOUT_MS', 30_000, { min: 1_000, max: 300_000 }),
      headersTimeoutMs: read.int('SERVER_HEADERS_TIMEOUT_MS', 15_000, { min: 1_000, max: 120_000 }),
      keepAliveTimeoutMs: read.int('SERVER_KEEP_ALIVE_TIMEOUT_MS', 5_000, { min: 1_000, max: 120_000 }),
      shutdownTimeoutMs: read.int('SERVER_SHUTDOWN_TIMEOUT_MS', 10_000, { min: 1_000, max: 120_000 }),
    },
  };

  // Cross-field checks.
  if (config.search.defaultLimit > config.search.maxLimit) {
    problems.push(
      `SEARCH_DEFAULT_LIMIT (${config.search.defaultLimit}) must be <= SEARCH_MAX_LIMIT (${config.search.maxLimit})`,
    );
  }
  if (isProduction && config.api.crawlEnabled && config.api.adminToken.length < 32) {
    problems.push('production CRAWL_API_ENABLED=true requires ADMIN_TOKEN of at least 32 characters');
  }
  for (const seed of config.seeds) {
    if (!/^https?:\/\//i.test(seed)) {
      problems.push(`SEED_URLS entry "${seed}" must start with http:// or https://`);
    }
  }

  if (problems.length && throwOnError) throw new ConfigError(problems);

  config.problems = problems;
  return deepFreeze(config);
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/**
 * Human readable summary for the startup log. Secrets are redacted.
 */
export function describeConfig(config) {
  return {
    env: config.env,
    port: config.port,
    dataDir: path.relative(ROOT_DIR, config.paths.data) || '.',
    bm25: `k1=${config.bm25.k1} b=${config.bm25.b}`,
    crawler: `concurrency=${config.crawler.concurrency} maxPages=${config.crawler.maxPages} maxDepth=${config.crawler.maxDepth}`,
    positions: config.index.storePositions,
    stemming: config.search.stemming,
    robots: config.crawler.respectRobots,
    adminToken: config.api.adminToken ? 'set' : 'not set',
  };
}

// Load `.env` once, then export the process-wide configuration. Importing this
// module is therefore enough to get a validated config anywhere in the app.
loadEnvFile();

export const config = buildConfig(process.env);
export default config;
