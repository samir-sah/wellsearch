import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../src/config/config.js';
import { WikipediaSearchService } from '../src/wikipedia/searchService.js';

function page(title, content = `${title} is a subject described by this encyclopedia article with factual background and history.`) {
  const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  return { id: url, url, title, content, categories: [], fetchedAt: '2026-10-27T00:00:00.000Z' };
}

function fixture(overrides = {}, clientOverrides = {}) {
  const calls = { suggest: [], fetchArticle: [] };
  const config = buildConfig({ NODE_ENV: 'test', ...overrides });
  const client = {
    async suggest(query, limit) { calls.suggest.push([query, limit]); return [`${query} article`]; },
    async fetchArticle(title) { calls.fetchArticle.push(title); return page(title); },
    ...clientOverrides,
  };
  let now = 1_000;
  const service = new WikipediaSearchService({ config, client, now: () => now });
  return { calls, config, service, advance: (milliseconds) => { now += milliseconds; } };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('Wikipedia query, suggestion, and article caches expire using the configured TTL', async () => {
  const { calls, service, advance } = fixture({ WIKIPEDIA_CACHE_TTL_MS: '1000' });
  try {
    await service.search('needle');
    advance(999);
    const cached = await service.search('needle');
    assert.equal(cached.total, 1);
    assert.equal(calls.suggest.length, 1);
    assert.equal(calls.fetchArticle.length, 1);
    advance(1);
    const refreshed = await service.search('needle');
    assert.equal(refreshed.total, 1);
    assert.equal(calls.suggest.length, 2);
    assert.equal(calls.fetchArticle.length, 2);
  } finally { await service.close(); }
});

test('setting the Wikipedia cache TTL to zero disables stored query and article caching', async () => {
  const { calls, service } = fixture({ WIKIPEDIA_CACHE_TTL_MS: '0' });
  try {
    await service.search('needle');
    await service.search('needle');
    assert.equal(calls.fetchArticle.length, 2);
    assert.equal(calls.suggest.length, 2);
    assert.equal(service.stats().cachedArticles, 0);
    assert.equal(service.stats().cachedQueries, 0);
  } finally { await service.close(); }
});

test('Wikipedia caches evict old entries to stay within the configured article capacity', async () => {
  const { calls, service } = fixture({ WIKIPEDIA_MAX_CACHED_ARTICLES: '8' });
  try {
    for (let index = 0; index < 10; index += 1) await service.search(`subject${index}`);
    assert.ok(service.stats().cachedArticles <= 8);
    assert.ok(service.stats().cachedQueries <= 8);
    await service.search('subject0');
    assert.equal(calls.fetchArticle.filter((title) => title === 'subject0 article').length, 2);
    assert.ok(service.stats().cachedArticles <= 8);
  } finally { await service.close(); }
});

test('simultaneous searches for the same query coalesce before consuming additional concurrency', async () => {
  const entered = deferred();
  const gate = deferred();
  let suggestions = 0;
  const { calls, service } = fixture({ WIKIPEDIA_MAX_CONCURRENT_SEARCHES: '1' }, {
    async suggest() {
      suggestions += 1;
      entered.resolve();
      await gate.promise;
      return ['Needle'];
    },
  });
  const first = service.search('needle');
  await entered.promise;
  const second = service.search('needle');
  try {
    assert.equal(service.stats().active, 1);
    gate.resolve();
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.total, 1);
    assert.equal(two.results[0].id, one.results[0].id);
    assert.equal(suggestions, 1);
    assert.equal(calls.fetchArticle.length, 1);
    assert.equal(service.stats().active, 0);
  } finally {
    gate.resolve();
    await Promise.allSettled([first, second]);
    await service.close();
  }
});

test('Wikipedia concurrency capacity rejects excess work without contacting the upstream client', async () => {
  const entered = deferred();
  const gate = deferred();
  const received = [];
  const { service } = fixture({ WIKIPEDIA_MAX_CONCURRENT_SEARCHES: '2' }, {
    async suggest(query) {
      received.push(query);
      if (received.length === 2) entered.resolve();
      await gate.promise;
      return [`${query} article`];
    },
  });
  const first = service.search('alpha');
  const second = service.search('beta');
  await entered.promise;
  try {
    assert.equal(service.stats().active, 2);
    await assert.rejects(service.search('gamma'), (error) => error.status === 503);
    assert.deepEqual(received, ['alpha', 'beta']);
    gate.resolve();
    assert.ok((await Promise.all([first, second])).every((result) => result.total === 1));
    assert.equal(service.stats().active, 0);
  } finally {
    gate.resolve();
    await Promise.allSettled([first, second]);
    await service.close();
  }
});

test('different concurrent searches share an in-flight download for the same article', async () => {
  const gate = deferred();
  const entered = deferred();
  let downloads = 0;
  const { service } = fixture({}, {
    async suggest() { return ['Alpha and Beta']; },
    async fetchArticle() {
      downloads += 1;
      entered.resolve();
      await gate.promise;
      return page('Alpha and Beta');
    },
  });
  const first = service.search('alpha');
  const second = service.search('beta');
  await entered.promise;
  try {
    gate.resolve();
    const [alpha, beta] = await Promise.all([first, second]);
    assert.equal(downloads, 1);
    assert.equal(alpha.total, 1);
    assert.equal(beta.total, 1);
    assert.equal(alpha.results[0].id, beta.results[0].id);
  } finally {
    gate.resolve();
    await Promise.allSettled([first, second]);
    await service.close();
  }
});

test('a partially failed corpus retries unavailable articles while retaining successful downloads', async () => {
  let failedDownloads = 0;
  let goodDownloads = 0;
  const { service } = fixture({}, {
    async suggest() { return ['Needle good', 'Needle retry']; },
    async fetchArticle(title) {
      if (title === 'Needle good') { goodDownloads += 1; return page(title); }
      failedDownloads += 1;
      if (failedDownloads === 1) throw new Error('temporary outage');
      return page(title);
    },
  });
  try {
    const partial = await service.search('needle');
    assert.equal(partial.total, 1);
    assert.ok(partial.warnings.length > 0);
    const retried = await service.search('needle');
    assert.equal(retried.total, 2);
    assert.equal(failedDownloads, 2);
    assert.equal(goodDownloads, 1);
  } finally { await service.close(); }
});

test('the Wikipedia ranking pipeline analyzes query terms once, matching its document analyzer', async () => {
  const { service } = fixture({}, {
    async suggest() { return ['Proceed']; },
    async fetchArticle() { return page('Proceed', 'Proceed means to continue onward with a planned course or sequence of actions.'); },
  });
  try {
    const result = await service.search('proceed');
    assert.equal(result.total, 1);
    assert.ok(result.results[0].score > 0);
    assert.deepEqual(result.diagnostics.unknownTerms, []);
  } finally { await service.close(); }
});

test('Wikipedia search supports the existing BM25_K1=0 configuration boundary', async () => {
  const { service } = fixture({ BM25_K1: '0' });
  try {
    const result = await service.search('needle');
    assert.equal(result.total, 1);
    assert.ok(Number.isFinite(result.results[0].score));
    assert.equal(result.diagnostics.bm25.k1, 0);
  } finally { await service.close(); }
});

test('explicit host filters apply before Wikipedia pagination without changing the fetched corpus', async () => {
  const { service } = fixture();
  try {
    const visible = await service.search('needle', { host: 'en.wikipedia.org', limit: 1 });
    const hidden = await service.search('needle', { host: 'example.com', limit: 1 });
    assert.equal(visible.total, 1);
    assert.equal(hidden.total, 0);
    assert.deepEqual(hidden.results, []);
    assert.equal(hidden.diagnostics.documentCount, 1);
    assert.deepEqual(hidden.diagnostics.hosts, ['example.com']);
  } finally { await service.close(); }
});
