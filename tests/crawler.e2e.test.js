import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../src/app.js';
import { buildConfig } from '../src/config/config.js';
import { createServices } from '../src/services.js';
import { Fetcher } from '../src/crawler/fetcher.js';
import { silentLogger } from '../src/utils/logger.js';

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
    server.once('error', reject);
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function startApi(config) {
  const services = await createServices({ config, logger: silentLogger });
  const app = createApp({ services });
  const running = await listen(app);
  return {
    ...running,
    services,
    async close() {
      await closeServer(running.server);
      await services.close();
    },
  };
}

async function responseJson(response) {
  assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
  return response.json();
}

function fixturePage({ title, body, links = [] }) {
  return `<!doctype html><html lang="en"><head><title>${title}</title><meta name="description" content="Fixture ${title}"></head><body><main><h1>${title}</h1><p>${body}</p>${links.map((href) => `<a href="${href}">${href}</a>`).join('')}</main></body></html>`;
}

test('private-network crawl opt-in is test-only and production remains SSRF-safe', async () => {
  const production = buildConfig({ NODE_ENV: 'production', ALLOW_PRIVATE_NETWORK: 'true' });
  const testConfig = buildConfig({ NODE_ENV: 'test', ALLOW_PRIVATE_NETWORK: 'true' });
  assert.equal(production.crawler.allowPrivateNetwork, false);
  assert.equal(testConfig.crawler.allowPrivateNetwork, true);

  let requested = false;
  const fetcher = new Fetcher({
    config: production,
    fetchImpl: async () => {
      requested = true;
      return new Response('should not be reached');
    },
  });
  const result = await fetcher.fetch('http://127.0.0.1:9999/internal');
  assert.equal(result.ok, false);
  assert.equal(result.errorType, 'private-network');
  assert.equal(requested, false);
});

test('local crawl API fetches, parses, deduplicates, indexes, searches, and survives restart', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'wellsearch-crawler-e2e-'));
  const hits = new Map();
  const fixture = await listen((request, response) => {
    const pathname = new URL(request.url, 'http://fixture').pathname;
    hits.set(pathname, (hits.get(pathname) ?? 0) + 1);
    response.setHeader('content-type', 'text/html; charset=utf-8');

    if (pathname === '/robots.txt') {
      response.setHeader('content-type', 'text/plain');
      response.end('User-agent: *\nAllow: /\n');
    } else if (pathname === '/') {
      response.end(fixturePage({
        title: 'Fixture Atlas',
        body: 'The atlas gateway contains a sufficiently long introduction to the isolated crawler verification corpus.',
        links: ['/alpha', '/alpha/', '/beta', '/broken'],
      }));
    } else if (pathname === '/alpha') {
      response.end(fixturePage({
        title: 'Quasarneedle Quasarneedle Handbook',
        body: 'Quasarneedle appears repeatedly in this focused quasarneedle guide so the title-weighted document ranks first with a highlighted snippet.',
        links: ['/', '/beta'],
      }));
    } else if (pathname === '/beta') {
      response.end(fixturePage({
        title: 'Secondary Observatory',
        body: 'This sufficiently long observatory note mentions quasarneedle once and links back into the cross-linked fixture graph.',
        links: ['/alpha'],
      }));
    } else if (pathname === '/broken') {
      response.statusCode = 500;
      response.statusMessage = 'Fixture Failure';
      response.end('intentional crawler failure');
    } else {
      response.statusCode = 404;
      response.end('not found');
    }
  });

  const config = buildConfig({
    NODE_ENV: 'test',
    ALLOW_PRIVATE_NETWORK: 'true',
    SEARCH_SOURCE: 'local',
    DATA_DIR: dataDir,
    PERSIST_INTERVAL_MS: '0',
    CRAWL_DELAY_MS: '0',
    CRAWLER_CONCURRENCY: '2',
    MAX_PAGES: '10',
    MAX_DEPTH: '2',
    MAX_RETRIES: '0',
    RESPECT_ROBOTS: 'true',
    SEARCH_RATE_LIMIT: '1000',
    CRAWL_RATE_LIMIT: '1000',
  });

  let api;
  let restarted;
  try {
    api = await startApi(config);
    const crawlResponse = await fetch(`${api.baseUrl}/api/crawl`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        urls: [`${fixture.baseUrl}/`, `${fixture.baseUrl}/`],
        wait: true,
        waitMs: 10_000,
        maxPages: 10,
        maxDepth: 2,
        concurrency: 2,
        sameHostOnly: true,
      }),
    });
    assert.equal(crawlResponse.status, 200);
    const crawl = await responseJson(crawlResponse);
    assert.equal(crawl.status, 'completed');
    assert.equal(crawl.result.processed, 4);
    assert.equal(crawl.result.indexed, 3);
    assert.equal(crawl.result.failed, 1);
    assert.equal(crawl.result.duplicates, 0);
    assert.ok(crawl.warnings.some((warning) => warning.startsWith('duplicate seed ignored:')));
    assert.deepEqual(crawl.summary.errors, [{ reason: 'http', count: 1 }]);
    assert.equal(crawl.summary.queue.rejected.duplicate, 4);
    assert.equal(hits.get('/alpha'), 1);
    assert.equal(hits.get('/alpha/'), undefined);
    assert.equal(hits.get('/broken'), 1);

    const searchResponse = await fetch(`${api.baseUrl}/api/search?q=quasarneedle&limit=10`);
    assert.equal(searchResponse.status, 200);
    const search = await responseJson(searchResponse);
    assert.equal(search.query, 'quasarneedle');
    assert.equal(search.total, 2);
    assert.deepEqual(search.results.map((result) => result.url), [
      `${fixture.baseUrl}/alpha`,
      `${fixture.baseUrl}/beta`,
    ]);
    assert.equal(search.results[0].rank, 1);
    assert.ok(search.results[0].score > search.results[1].score);
    assert.match(search.results[0].snippetHtml, /<mark>Quasarneedle<\/mark>/i);

    await api.close();
    api = null;

    restarted = await startApi(config);
    assert.equal(restarted.services.load.documents, 3);
    assert.equal(restarted.services.load.rebuilt, false);
    const persistedResponse = await fetch(`${restarted.baseUrl}/api/search?q=quasarneedle&limit=10`);
    assert.equal(persistedResponse.status, 200);
    const persisted = await responseJson(persistedResponse);
    assert.equal(persisted.total, 2);
    assert.deepEqual(
      persisted.results.map(({ url, rank }) => ({ url, rank })),
      [
        { url: `${fixture.baseUrl}/alpha`, rank: 1 },
        { url: `${fixture.baseUrl}/beta`, rank: 2 },
      ],
    );
  } finally {
    if (api) await api.close();
    if (restarted) await restarted.close();
    await closeServer(fixture.server);
    await rm(dataDir, { recursive: true, force: true });
  }
});
