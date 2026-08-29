import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../src/app.js';
import { startServer } from '../src/server.js';
import { buildConfig } from '../src/config/config.js';
import { createServices } from '../src/services.js';
import { silentLogger } from '../src/utils/logger.js';

async function createHarness(overrides = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'nixsearch-test-'));
  const config = buildConfig({
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    HOST: '127.0.0.1',
    PORT: '0',
    PERSIST_INTERVAL_MS: '0',
    SEARCH_RATE_LIMIT: '1000',
    CRAWL_RATE_LIMIT: '1000',
    RATE_LIMIT_WINDOW_MS: '60000',
    ...overrides,
  });
  const services = await createServices({ config, logger: silentLogger });
  const app = createApp({ services });
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let closed = false;

  return {
    config,
    services,
    baseUrl,
    async close() {
      if (closed) return;
      closed = true;
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await services.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function withHarness(run, overrides) {
  const harness = await createHarness(overrides);
  try {
    await run(harness);
  } finally {
    await harness.close();
  }
}

async function json(response) {
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  return response.json();
}

test('GET /api/health exposes the live service contract', async () => {
  await withHarness(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.headers.get('x-request-id'));

    const body = await json(response);
    assert.deepEqual(Object.keys(body), [
      'status', 'service', 'version', 'env', 'uptimeSeconds', 'timestamp',
      'index', 'crawler', 'search', 'memory',
    ]);
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'NixSearch');
    assert.equal(body.version, '1.0.0');
    assert.equal(body.env, 'test');
    assert.equal(body.index.documents, 0);
    assert.equal(body.index.terms, 0);
    assert.equal(body.crawler.running, false);
    assert.deepEqual(body.search, { queries: 0, errors: 0 });
    assert.ok(Number.isFinite(body.uptimeSeconds));
    assert.ok(!Number.isNaN(Date.parse(body.timestamp)));
  });
});

test('GET /api/search rejects a missing query in the centralized error envelope', async () => {
  await withHarness(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/search`);
    assert.equal(response.status, 400);
    const body = await json(response);
    assert.equal(body.error.code, 'BAD_REQUEST');
    assert.equal(body.error.message, 'the "q" query parameter is required');
    assert.deepEqual(body.error.details, {
      example: '/api/search?q=bm25%20ranking&page=1&limit=10',
    });
    assert.ok(body.error.requestId);
  });
});

test('GET /api/search returns the exact empty-index/no-results contract', async () => {
  await withHarness(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/search?q=unfindable&page=2&limit=3`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await json(response);

    assert.equal(body.query, 'unfindable');
    assert.deepEqual(body.terms, ['unfind']);
    assert.deepEqual(body.results, []);
    assert.equal(body.total, 0);
    assert.equal(body.page, 2);
    assert.equal(body.limit, 3);
    assert.equal(body.totalPages, 1);
    assert.equal(body.diagnostics.reason, 'empty-index');
    assert.equal(body.diagnostics.documentCount, 0);
    assert.deepEqual(body.suggestions, []);
    assert.ok(body.warnings.includes('the index is empty - run a crawl first'));
    assert.ok(Number.isFinite(body.took));
    assert.ok(Number.isFinite(body.timings.total));
  });
});

test('GET /api/search returns a real result from the production index and ranking path', async () => {
  await withHarness(async ({ baseUrl, services }) => {
    const indexed = services.indexManager.indexDocument({
      url: 'https://fixture.invalid/guides/indexing',
      title: 'Deterministic Needle Guide',
      description: 'A local indexed document used for contract verification.',
      text: 'This sufficiently long local document explains the deterministic needle indexing path without network access.',
      source: 'test',
    });
    assert.equal(indexed.status, 'indexed');

    const response = await fetch(`${baseUrl}/api/search?q=deterministic%20needle&limit=5&explain=true`);
    assert.equal(response.status, 200);
    const body = await json(response);
    assert.equal(body.total, 1);
    assert.equal(body.results.length, 1);
    assert.equal(body.diagnostics.documentCount, 1);

    const result = body.results[0];
    assert.deepEqual(Object.keys(result), [
      'id', 'rank', 'url', 'displayUrl', 'host', 'title', 'titleHtml',
      'description', 'snippet', 'snippetHtml', 'score', 'bm25Score',
      'proximityBoost', 'matchedTerms', 'documentLength', 'fetchedAt', 'depth', 'explain',
    ]);
    assert.equal(result.id, indexed.id);
    assert.equal(result.rank, 1);
    assert.equal(result.url, 'https://fixture.invalid/guides/indexing');
    assert.equal(result.host, 'fixture.invalid');
    assert.equal(result.title, 'Deterministic Needle Guide');
    assert.ok(result.score > 0);
    assert.ok(result.matchedTerms >= 1);
    assert.ok(Array.isArray(result.explain.contributions));
    assert.ok(result.explain.contributions.length >= 1);
  });
});

test('POST /api/crawl requires configured admin authentication before validation', async () => {
  await withHarness(async ({ baseUrl }) => {
    const missing = await fetch(`${baseUrl}/api/crawl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(missing.status, 401);
    const missingBody = await json(missing);
    assert.equal(missingBody.error.code, 'UNAUTHORIZED');
    assert.equal(missingBody.error.message, 'a valid admin token is required for this endpoint');

    const invalid = await fetch(`${baseUrl}/api/crawl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-token': 'wrong' },
      body: '{}',
    });
    assert.equal(invalid.status, 401);

    const authorized = await fetch(`${baseUrl}/api/crawl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer test-admin-token' },
      body: '{}',
    });
    assert.equal(authorized.status, 400);
    const authorizedBody = await json(authorized);
    assert.equal(authorizedBody.error.code, 'BAD_REQUEST');
    assert.equal(
      authorizedBody.error.message,
      'no seed URLs: provide "urls" in the request body or set SEED_URLS in the environment',
    );
  }, { ADMIN_TOKEN: 'test-admin-token' });
});

test('POST /api/crawl validates request bodies without starting a crawl', async () => {
  await withHarness(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/api/crawl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '[]',
    });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('x-admin-auth'), 'disabled');
    const body = await json(response);
    assert.equal(body.error.code, 'BAD_REQUEST');
    assert.equal(body.error.message, 'the request body must be a JSON object');
  });
});

test('unmatched routes and unexpected failures use JSON error contracts', async () => {
  await withHarness(async ({ baseUrl, services }) => {
    const missing = await fetch(`${baseUrl}/api/does-not-exist`);
    assert.equal(missing.status, 404);
    const missingBody = await json(missing);
    assert.equal(missingBody.error.code, 'NOT_FOUND');
    assert.equal(missingBody.error.message, 'no route for GET /api/does-not-exist');
    assert.ok(missingBody.error.requestId);

    const originalSearch = services.searchEngine.search;
    services.searchEngine.search = () => { throw new Error('private implementation detail'); };
    try {
      const failed = await fetch(`${baseUrl}/api/search?q=trigger`);
      assert.equal(failed.status, 500);
      const failedBody = await json(failed);
      assert.equal(failedBody.error.code, 'INTERNAL_ERROR');
      assert.equal(failedBody.error.message, 'internal server error');
      assert.ok(failedBody.error.requestId);
      assert.equal(JSON.stringify(failedBody).includes('private implementation detail'), false);
      assert.equal('stack' in failedBody.error, false);
    } finally {
      services.searchEngine.search = originalSearch;
    }
  });
});

test('startServer binds an ephemeral port and closes supplied resources exactly once', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'nixsearch-lifecycle-'));
  const config = buildConfig({
    NODE_ENV: 'test', DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: '0', PERSIST_INTERVAL_MS: '0',
  });
  const services = await createServices({ config, logger: silentLogger });
  const realClose = services.close.bind(services);
  let closeCalls = 0;
  services.close = async () => {
    closeCalls += 1;
    return realClose();
  };

  const running = await startServer({ serverConfig: config, serverLogger: silentLogger, services });
  try {
    const address = running.server.address();
    assert.equal(typeof address, 'object');
    assert.ok(address.port > 0);
    assert.equal(running.server.requestTimeout, config.server.requestTimeoutMs);
    assert.equal(running.server.headersTimeout, config.server.headersTimeoutMs);
    assert.equal(running.server.keepAliveTimeout, config.server.keepAliveTimeoutMs);
    assert.equal(running.server.maxRequestsPerSocket, 1_000);
    const response = await fetch(`http://127.0.0.1:${address.port}/api/health/live`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', pid: process.pid });

    await Promise.all([running.close('test'), running.close('duplicate')]);
    assert.equal(closeCalls, 1);
  } finally {
    if (running.server.listening) await running.close('cleanup');
    await rm(dataDir, { recursive: true, force: true });
  }
});
