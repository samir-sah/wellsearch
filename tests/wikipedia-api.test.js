import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../src/app.js';
import { buildConfig } from '../src/config/config.js';
import { createServices } from '../src/services.js';
import { silentLogger } from '../src/utils/logger.js';
import { WikipediaClient } from '../src/wikipedia/client.js';

function article(title, content = `${title} is an encyclopedia article with detailed information about this subject and its history.`) {
  const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  return { id: url, title, url, content, categories: [], fetchedAt: '2026-10-27T00:00:00.000Z' };
}

function stubClient({ suggestions = {}, articles = {}, suggest, fetchArticle } = {}) {
  const calls = { suggest: [], fetchArticle: [] };
  return {
    calls,
    async suggest(query, limit) {
      calls.suggest.push({ query, limit });
      return suggest ? suggest(query, limit) : (suggestions[query] ?? []).slice(0, limit);
    },
    async fetchArticle(title) {
      calls.fetchArticle.push(title);
      return fetchArticle ? fetchArticle(title) : (articles[title] ?? null);
    },
  };
}

function batchPage(title, extra = {}) {
  const document = article(title);
  return { ns: 0, title, fullurl: document.url, extract: document.content,
    categories: [{ ns: 14, title: 'Category:Needlework' }], ...extra };
}

function batchClient(respond) {
  const calls = [];
  const client = new WikipediaClient({ fetcher: { async fetch(url, options) {
    calls.push({ url: new URL(url), options });
    return { ok: true, text: JSON.stringify(await respond(calls.length)), contentType: 'application/json' };
  } } });
  return { client, calls };
}

async function withHarness(client, run, overrides = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'wellsearch-wikipedia-'));
  let services;
  let server;
  try {
    const config = buildConfig({
      NODE_ENV: 'test', DATA_DIR: dataDir, HOST: '127.0.0.1', PORT: '0',
      PERSIST_INTERVAL_MS: '0', SEARCH_RATE_LIMIT: '1000',
      ...overrides,
    });
    services = await createServices({ config, logger: silentLogger, wikipediaClient: client });
    server = await new Promise((resolve, reject) => {
      const instance = createApp({ services }).listen(0, '127.0.0.1', () => resolve(instance));
      instance.once('error', reject);
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const get = async (route) => {
      const response = await fetch(`${baseUrl}${route}`);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
      return { response, body: await response.json() };
    };
    await run({ config, services, get });
  } finally {
    try {
      if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    } finally {
      try { await services?.close(); }
      finally { await rm(dataDir, { recursive: true, force: true }); }
    }
  }
}

function assertFrontendContract(body) {
  assert.equal(typeof body.query, 'string');
  for (const key of ['terms', 'suggestions', 'warnings']) {
    assert.ok(Array.isArray(body[key]), key);
    assert.ok(body[key].every((value) => typeof value === 'string'), key);
  }
  for (const key of ['total', 'page', 'limit', 'totalPages', 'took']) assert.ok(Number.isFinite(body[key]), key);
  for (const key of ['parsing', 'retrieval', 'scoring', 'filtering', 'sorting', 'presentation', 'total']) {
    assert.ok(Number.isFinite(body.timings[key]), `timings.${key}`);
  }
  for (const key of ['documentCount', 'averageDocumentLength', 'candidates', 'postingsScanned']) {
    assert.ok(Number.isFinite(body.diagnostics[key]), `diagnostics.${key}`);
  }
  for (const key of ['truncated', 'proximityApplied']) assert.equal(typeof body.diagnostics[key], 'boolean', key);
  for (const key of ['unknownTerms', 'phrases', 'exclusions', 'hosts']) {
    assert.ok(Array.isArray(body.diagnostics[key]), key);
    assert.ok(body.diagnostics[key].every((value) => typeof value === 'string'), key);
  }
  assert.ok(Number.isFinite(body.diagnostics.bm25.k1));
  assert.ok(Number.isFinite(body.diagnostics.bm25.b));
  assert.ok(Array.isArray(body.results));
  for (const result of body.results) {
    for (const key of ['id', 'url', 'displayUrl', 'host', 'title', 'titleHtml', 'description', 'snippet', 'snippetHtml']) {
      assert.equal(typeof result[key], 'string', key);
    }
    for (const key of ['rank', 'score', 'bm25Score', 'proximityBoost', 'matchedTerms', 'documentLength']) {
      assert.ok(Number.isFinite(result[key]), key);
    }
    assert.ok(result.fetchedAt === null || typeof result.fetchedAt === 'string');
    assert.ok(result.depth === null || Number.isFinite(result.depth));
  }
}

test('default search source retrieves Wikipedia articles and preserves the current UI response contract', async () => {
  const client = stubClient({
    suggestions: { needle: ['Needle', 'Sewing'] },
    articles: {
      Needle: article('Needle', 'A needle is a slender tool. A sewing needle draws thread through fabric and guides stitches.'),
      Sewing: article('Sewing', 'Sewing joins fabric using a needle and thread. This craft creates clothing and embroidery.'),
    },
  });
  await withHarness(client, async ({ get }) => {
    const { response, body } = await get('/api/search?q=needle&explain=true');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assertFrontendContract(body);
    assert.equal(body.total, 2);
    assert.equal(body.diagnostics.documentCount, 2);
    assert.equal(body.results[0].title, 'Needle');
    assert.ok(body.results.every((result) => result.host === 'en.wikipedia.org' && result.bm25Score > 0));
    assert.ok(body.results[0].explain.contributions.length > 0);
    assert.match(body.results[0].snippet.toLowerCase(), /needle/);
    assert.deepEqual(client.calls.fetchArticle.sort(), ['Needle', 'Sewing']);
  });
});

test('Wikipedia titles with non-ASCII characters and punctuation remain valid canonical links', async () => {
  const title = 'Beyoncé & rhythm (music)';
  const page = article(title, 'Beyoncé is a singer whose music explores rhythm and performance across many musical traditions.');
  const client = stubClient({ suggestions: { rhythm: [title] }, articles: { [title]: page } });
  await withHarness(client, async ({ get }) => {
    const { body } = await get('/api/search?q=rhythm');
    assert.equal(body.total, 1);
    assert.equal(body.results[0].url, page.url);
    assert.equal(new URL(body.results[0].url).hostname, 'en.wikipedia.org');
    assert.equal(body.results[0].title, title);
    assert.ok(!body.results[0].titleHtml.includes('& rhythm'));
  });
});

test('repeat searches reuse cached articles and keep result identity stable', async () => {
  const client = stubClient({ suggestions: { needle: ['Needle'] }, articles: { Needle: article('Needle') } });
  await withHarness(client, async ({ get }) => {
    const first = await get('/api/search?q=needle');
    const second = await get('/api/search?q=needle');
    assert.equal(first.body.total, 1);
    assert.equal(second.body.results[0].id, first.body.results[0].id);
    assert.deepEqual(client.calls.fetchArticle, ['Needle']);
  });
});

test('an empty Wikipedia response does not leak documents from the local crawler index', async () => {
  const client = stubClient();
  await withHarness(client, async ({ services, get }) => {
    services.indexManager.indexDocument({
      title: 'Needle local fixture', url: 'https://fixture.invalid/needle',
      text: 'A sufficiently long local needle document exists only in the crawler index for this regression test.',
    });
    const { response, body } = await get('/api/search?q=needle');
    assert.equal(response.status, 200);
    assertFrontendContract(body);
    assert.equal(body.total, 0);
    assert.deepEqual(body.results, []);
    assert.equal(body.diagnostics.documentCount, 0);
    assert.equal(client.calls.suggest.length, 1);
  });
});

test('Wikipedia failures return a safe 502 JSON error without leaking upstream details', async () => {
  const secret = 'internal-upstream-host-and-secret-token';
  const client = stubClient({ suggest: async () => { throw new Error(secret); } });
  await withHarness(client, async ({ get }) => {
    const { response, body } = await get('/api/search?q=needle');
    assert.equal(response.status, 502);
    assert.equal(typeof body.error.code, 'string');
    assert.equal(typeof body.error.message, 'string');
    assert.ok(body.error.requestId);
    assert.ok(!JSON.stringify(body).includes(secret));
    assert.deepEqual(client.calls.fetchArticle, []);
  });
});

test('one unavailable article leaves usable BM25 results with a safe warning', async () => {
  const secret = 'private-article-download-error';
  const client = stubClient({
    suggestions: { needle: ['Needle', 'Unavailable'] },
    fetchArticle: async (title) => {
      if (title === 'Unavailable') throw new Error(secret);
      return article('Needle');
    },
  });
  await withHarness(client, async ({ get }) => {
    const { response, body } = await get('/api/search?q=needle');
    assert.equal(response.status, 200);
    assertFrontendContract(body);
    assert.equal(body.total, 1);
    assert.equal(body.results[0].title, 'Needle');
    assert.ok(body.warnings.length > 0);
    assert.ok(!JSON.stringify(body).includes(secret));
  });
});

test('Wikipedia results paginate without repeated article downloads', async () => {
  const titles = ['Needle Alpha', 'Needle Beta', 'Needle Gamma'];
  const client = stubClient({
    suggestions: { needle: titles },
    articles: Object.fromEntries(titles.map((title) => [title, article(title)])),
  });
  await withHarness(client, async ({ get }) => {
    const first = await get('/api/search?q=needle&page=1&limit=1');
    const second = await get('/api/search?q=needle&page=2&limit=1');
    assert.equal(first.body.total, 3);
    assert.equal(first.body.totalPages, 3);
    assert.equal(second.body.page, 2);
    assert.equal(second.body.results.length, 1);
    assert.equal(second.body.results[0].rank, 2);
    assert.notEqual(first.body.results[0].id, second.body.results[0].id);
    assert.equal(client.calls.fetchArticle.length, 3);
  });
});

test('search validation rejects malformed requests before contacting Wikipedia', async () => {
  const client = stubClient();
  await withHarness(client, async ({ get }) => {
    for (const route of [
      '/api/search', '/api/search?q[x]=needle', '/api/search?q=needle&page=-1',
      '/api/search?q=needle&limit=0', '/api/search?q=needle&explain=maybe',
      `/api/search?q=${'x'.repeat(8193)}`,
    ]) {
      const { response, body } = await get(route);
      assert.equal(response.status, 400, route.slice(0, 80));
      assert.equal(body.error.code, 'BAD_REQUEST');
    }
    assert.deepEqual(client.calls.suggest, []);
    assert.deepEqual(client.calls.fetchArticle, []);
  });
});

test('autocomplete exposes Wikipedia titles without downloading article bodies', async () => {
  const client = stubClient({ suggestions: { need: ['Needle', 'Needlework'] } });
  await withHarness(client, async ({ get }) => {
    const { response, body } = await get('/api/suggest?q=need');
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(body.prefix, 'need');
    assert.deepEqual(body.suggestions, ['Needle', 'Needlework']);
    assert.deepEqual(client.calls.fetchArticle, []);
  });
});

test('autocomplete validates malformed input and avoids upstream work for short prefixes', async () => {
  const client = stubClient();
  await withHarness(client, async ({ get }) => {
    for (const route of ['/api/suggest?q[x]=needle', `/api/suggest?q=${'x'.repeat(513)}`]) {
      const { response, body } = await get(route);
      assert.equal(response.status, 400, route);
      assert.equal(body.error.code, 'BAD_REQUEST');
    }
    for (const route of ['/api/suggest', '/api/suggest?q=n']) {
      const { response, body } = await get(route);
      assert.equal(response.status, 200);
      assert.deepEqual(body.suggestions, []);
    }
    assert.deepEqual(client.calls.suggest, []);
  });
});

test('autocomplete applies API rate limiting before making excessive Wikipedia requests', async () => {
  const client = stubClient({ suggestions: { need: ['Needle'] } });
  await withHarness(client, async ({ get }) => {
    assert.equal((await get('/api/suggest?q=need')).response.status, 200);
    const { response, body } = await get('/api/suggest?q=needle');
    assert.equal(response.status, 429);
    assert.equal(body.error.code, 'RATE_LIMITED');
    assert.ok(Number(response.headers.get('retry-after')) >= 1);
    assert.equal(client.calls.suggest.length, 1);
  }, { SEARCH_RATE_LIMIT: '1' });
});

test('overlapping Wikipedia queries use independent corpora and globally stable article IDs', async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  let started = 0;
  const client = stubClient({
    suggest: async (query) => [`${query} article`],
    fetchArticle: async (title) => {
      started += 1;
      if (started === 2) release();
      await barrier;
      return article(title, `${title} contains factual information about its own distinct subject in this encyclopedia article.`);
    },
  });
  await withHarness(client, async ({ get }) => {
    const [alpha, beta] = await Promise.all([get('/api/search?q=alpha'), get('/api/search?q=beta')]);
    assert.equal(alpha.response.status, 200);
    assert.equal(beta.response.status, 200);
    for (const [entry, query] of [[alpha, 'alpha'], [beta, 'beta']]) {
      assert.equal(entry.body.diagnostics.documentCount, 1);
      assert.equal(entry.body.total, 1);
      assert.equal(entry.body.results[0].title, `${query} article`);
    }
    assert.notEqual(alpha.body.results[0].id, beta.body.results[0].id);
    const repeated = await get('/api/search?q=alpha');
    assert.equal(repeated.body.results[0].id, alpha.body.results[0].id);
    assert.equal(client.calls.fetchArticle.length, 2);
  });
});

test('real batch parsing preserves the HTTP frontend contract and reuses retrieval across pagination and filters', async () => {
  const { client, calls } = batchClient(async () => ({ batchcomplete: true,
    query: { pages: [batchPage('Needle <theory>'), batchPage('Needle history')] } }));
  await withHarness(client, async ({ get }) => {
    const first = await get('/api/search?q=needle&limit=1&explain=true');
    const second = await get('/api/search?q=NEEDLE&page=2&limit=1');
    const filtered = await get('/api/search?q=needle&host=example.com');
    for (const entry of [first, second, filtered]) {
      assert.equal(entry.response.status, 200);
      assertFrontendContract(entry.body);
      assert.deepEqual(entry.body.warnings, []);
    }
    assert.equal(first.body.total, 2);
    assert.equal(first.body.totalPages, 2);
    assert.equal(first.body.results[0].rank, 1);
    assert.ok(first.body.results[0].explain.contributions.length > 0);
    assert.equal(second.body.results[0].rank, 2);
    assert.notEqual(first.body.results[0].id, second.body.results[0].id);
    assert.equal(second.body.query, 'NEEDLE');
    assert.equal(filtered.body.total, 0);
    assert.equal(filtered.body.diagnostics.documentCount, 2);
    assert.equal(calls.length, 1, 'a cached corpus must not trigger title lookup or HTML downloads');
    assert.equal(calls[0].url.origin, 'https://en.wikipedia.org');
    assert.equal(calls[0].url.pathname, '/w/api.php');
    assert.equal(calls[0].url.searchParams.get('generator'), 'prefixsearch');
    assert.equal(calls[0].options.allowedOrigin, 'https://en.wikipedia.org');
    assert.deepEqual(first.body.results[0].categories, ['Needlework']);
  });
});

test('real batch HTTP failures and partial results remain safe and recover on the next search', async () => {
  const secret = 'private-batch-upstream-token';
  const { client, calls } = batchClient(async (attempt) => {
    if (attempt === 1) return { batchcomplete: true, query: { pages: [
      batchPage('Needle one'), batchPage('Needle two', { extract: undefined }),
    ] } };
    if (attempt === 2) return { error: { code: 'upstream-failure', info: secret } };
    return { batchcomplete: true, query: { pages: [batchPage('Needle one'), batchPage('Needle two')] } };
  });
  await withHarness(client, async ({ get }) => {
    const partial = await get('/api/search?q=needle');
    assert.equal(partial.response.status, 200);
    assertFrontendContract(partial.body);
    assert.equal(partial.body.total, 1);
    assert.ok(partial.body.warnings.length > 0);
    const failed = await get('/api/search?q=needle');
    assert.equal(failed.response.status, 502);
    assert.equal(failed.body.error.code, 'WIKIPEDIA_UNAVAILABLE');
    assert.ok(failed.body.error.requestId);
    assert.ok(!JSON.stringify(failed.body).includes(secret));
    const recovered = await get('/api/search?q=needle');
    assert.equal(recovered.response.status, 200);
    assertFrontendContract(recovered.body);
    assert.equal(recovered.body.total, 2);
    assert.deepEqual(recovered.body.warnings, []);
    const cached = await get('/api/search?q=needle');
    assert.deepEqual(cached.body.results, recovered.body.results);
    assert.equal(calls.length, 3);
  });
});

test('namespace-prefixed batch queries produce normal no-results responses instead of a false outage', async () => {
  const { client, calls } = batchClient(async () => ({ batchcomplete: true,
    query: { pages: [{ ns: 14, title: 'Category:Physics' }] } }));
  await withHarness(client, async ({ get }) => {
    const { response, body } = await get('/api/search?q=Category%3APhysics');
    assert.equal(response.status, 200);
    assertFrontendContract(body);
    assert.equal(body.total, 0);
    assert.equal(body.diagnostics.reason, 'no-wikipedia-articles');
    assert.deepEqual(body.warnings, []);
    assert.deepEqual(body.suggestions, []);
    assert.equal(calls.length, 1);
  });
});
