import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig } from '../src/config/config.js';
import { WikipediaSearchService } from '../src/wikipedia/searchService.js';
import { toErrorResponse } from '../src/utils/errors.js';

const background = 'This encyclopedia article describes factual background, scientific research, historical context, and practical applications.';

function article(title, { content = `${title}. ${background}`, categories = [] } = {}) {
  const url = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  return { id: url, url, title, content, categories, fetchedAt: '2026-10-28T00:00:00.000Z' };
}

function batch(articles) {
  return { articles, titles: articles.map(({ title }) => title), warnings: [] };
}

function fixture(overrides = {}, searchArticles) {
  const calls = [];
  const config = buildConfig({ NODE_ENV: 'test', ...overrides });
  const client = {
    async searchArticles(query, limit) {
      calls.push([query, limit]);
      return searchArticles ? searchArticles(query, limit) : batch([article(`${query} article`)]);
    },
    async suggest() { assert.fail('batch searches must not request a second title lookup'); },
    async fetchArticle() { assert.fail('batch searches must not download individual HTML pages'); },
  };
  let now = 1_000;
  const service = new WikipediaSearchService({ config, client, now: () => now });
  return { calls, service, advance: (milliseconds) => { now += milliseconds; } };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function unavailable(error) {
  assert.equal(error.status, 502);
  assert.equal(error.code, 'WIKIPEDIA_UNAVAILABLE');
  const response = toErrorResponse(error);
  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'WIKIPEDIA_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(response), /private upstream|secret malformed|stack trace/i);
  return true;
}

test('one batch request preserves weighted ranking, categories, explanations, pagination, and host filtering', async () => {
  const titleMatch = article('Needle <theory>', { content: background });
  const categoryMatch = article('Taxonomy', { content: background, categories: ['Needle'] });
  const bodyMatch = article('Overview', { content: `Needle. ${background}` });
  const { calls, service } = fixture({ BM25_B: '0' }, async () => batch([bodyMatch, categoryMatch, titleMatch]));
  try {
    const result = await service.search('needle', { limit: 2, explain: true });
    assert.deepEqual(calls, [['needle', 8]]);
    assert.equal(result.query, 'needle');
    assert.equal(result.total, 3);
    assert.equal(result.totalPages, 2);
    assert.equal(result.page, 1);
    assert.equal(result.limit, 2);
    assert.deepEqual(result.results.map(({ title }) => title), [titleMatch.title, categoryMatch.title]);
    assert.deepEqual(result.results.map(({ rank }) => rank), [1, 2]);
    assert.equal(result.results[0].titleHtml, 'Needle &lt;theory&gt;');
    assert.deepEqual(result.results[1].categories, ['Needle']);
    assert.equal(result.diagnostics.source, 'wikipedia');
    assert.equal(result.diagnostics.documentCount, 3);
    assert.deepEqual(result.warnings, []);
    for (const item of result.results) {
      assert.equal(item.host, 'en.wikipedia.org');
      assert.equal(item.id, item.url);
      assert.equal(item.fetchedAt, '2026-10-28T00:00:00.000Z');
      assert.equal(item.explain.snippetSource, 'wikipedia');
      assert.ok(item.documentLength > 0);
      assert.ok(item.score > 0 && Number.isFinite(item.score));
      const contributions = item.explain.contributions.reduce((sum, term) => sum + term.contribution, 0);
      assert.ok(Math.abs(contributions - item.score) < 1e-12);
    }

    const second = await service.search('needle', { page: 2, limit: 2 });
    assert.deepEqual(second.results.map(({ title, rank }) => [title, rank]), [[bodyMatch.title, 3]]);
    assert.equal('explain' in second.results[0], false);
    const visible = await service.search('needle', { host: 'en.wikipedia.org', limit: 1 });
    const hidden = await service.search('needle', { host: 'example.com', limit: 1 });
    assert.equal(visible.total, 3);
    assert.equal(hidden.total, 0);
    assert.deepEqual(hidden.results, []);
    assert.equal(hidden.diagnostics.documentCount, 3);
    assert.deepEqual(hidden.diagnostics.hosts, ['example.com']);
    assert.equal(calls.length, 1);
  } finally { await service.close(); }
});

test('batch searches coalesce case and repeated whitespace without changing each displayed query', async () => {
  const entered = deferred();
  const gate = deferred();
  const { calls, service } = fixture({ WIKIPEDIA_MAX_CONCURRENT_SEARCHES: '1' }, async () => {
    entered.resolve();
    await gate.promise;
    return batch([article('Quantum physics')]);
  });
  const first = service.search('  Quantum   Physics  ');
  await entered.promise;
  const second = service.search('quantum physics');
  try {
    assert.equal(service.stats().active, 1);
    gate.resolve();
    const [one, two] = await Promise.all([first, second]);
    assert.equal(one.query, 'Quantum   Physics');
    assert.equal(two.query, 'quantum physics');
    assert.deepEqual(one.results, two.results);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][1], 8);
    assert.equal(calls[0][0].replace(/\s+/g, ' ').toLowerCase(), 'quantum physics');
    const cached = await service.search('QUANTUM\tPHYSICS');
    assert.equal(cached.query, 'QUANTUM\tPHYSICS');
    assert.equal(cached.total, 1);
    assert.equal(calls.length, 1);
    assert.equal(service.stats().active, 0);
  } finally {
    gate.resolve();
    await Promise.allSettled([first, second]);
    await service.close();
  }
});

test('batch corpora expire exactly at the configured TTL', async () => {
  const { calls, service, advance } = fixture({ WIKIPEDIA_CACHE_TTL_MS: '1000' });
  try {
    await service.search('needle');
    advance(999);
    assert.equal((await service.search('NEEDLE')).total, 1);
    assert.equal(calls.length, 1);
    advance(1);
    assert.equal((await service.search('needle')).total, 1);
    assert.equal(calls.length, 2);
  } finally { await service.close(); }
});

test('zero TTL disables completed batch caching', async () => {
  const { calls, service } = fixture({ WIKIPEDIA_CACHE_TTL_MS: '0' });
  try {
    await service.search('needle');
    await service.search('needle');
    assert.equal(calls.length, 2);
    assert.equal(service.stats().cachedQueries, 0);
  } finally { await service.close(); }
});

test('batch query cache uses LRU eviction within a smaller configured capacity', async () => {
  const { calls, service } = fixture({ WIKIPEDIA_MAX_CACHED_ARTICLES: '8' });
  try {
    for (let n = 0; n < 8; n += 1) await service.search(`subject${n}`);
    await service.search('subject0');
    await service.search('subject8');
    assert.equal(service.stats().cachedQueries, 8);
    await service.search('subject0');
    assert.equal(calls.filter(([query]) => query === 'subject0').length, 1);
    await service.search('subject1');
    assert.equal(calls.filter(([query]) => query === 'subject1').length, 2);
    assert.equal(service.stats().cachedQueries, 8);
  } finally { await service.close(); }
});

test('batch query cache never grows beyond fifty corpora by default', async () => {
  const { calls, service } = fixture();
  try {
    for (let n = 0; n < 51; n += 1) await service.search(`subject${n}`);
    assert.equal(service.stats().cachedQueries, 50);
    await service.search('subject0');
    assert.equal(calls.filter(([query]) => query === 'subject0').length, 2);
    assert.equal(service.stats().cachedQueries, 50);
  } finally { await service.close(); }
});

test('partial batch warnings are returned but the incomplete corpus is not cached', async () => {
  let attempts = 0;
  const { calls, service } = fixture({}, async () => {
    attempts += 1;
    return attempts === 1
      ? { ...batch([article('Needle one')]), warnings: ['Some Wikipedia extracts are temporarily unavailable.'] }
      : batch([article('Needle one'), article('Needle two')]);
  });
  try {
    const partial = await service.search('needle');
    assert.equal(partial.total, 1);
    assert.deepEqual(partial.warnings, ['Some Wikipedia extracts are temporarily unavailable.']);
    assert.equal(service.stats().cachedQueries, 0);
    const complete = await service.search('needle');
    assert.equal(complete.total, 2);
    assert.deepEqual(complete.warnings, []);
    assert.equal((await service.search('needle')).total, 2);
    assert.equal(calls.length, 2);
  } finally { await service.close(); }
});

test('thrown batch failures are exposed safely, release capacity, and retry instead of caching', async () => {
  let attempts = 0;
  const { calls, service } = fixture({}, async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('private upstream stack trace');
    return batch([article('Needle')]);
  });
  try {
    await assert.rejects(service.search('needle'), unavailable);
    assert.equal(service.stats().active, 0);
    assert.equal(service.stats().cachedQueries, 0);
    assert.equal((await service.search('needle')).total, 1);
    assert.equal(calls.length, 2);
  } finally { await service.close(); }
});

test('malformed batch contracts fail safely without poisoning the query cache', async (t) => {
  const invalid = [
    ['null payload', null],
    ['missing articles', { titles: [], warnings: [] }],
    ['non-array articles', { articles: {}, titles: [], warnings: [] }],
    ['missing titles', { articles: [], warnings: [] }],
    ['non-string titles', { articles: [], titles: [1], warnings: [] }],
    ['non-array warnings', { articles: [], titles: [], warnings: 'secret malformed' }],
    ['non-string warnings', { articles: [], titles: [], warnings: [{}] }],
    ['null article', { articles: [null], titles: ['Needle'], warnings: [] }],
    ['invalid article title', { ...batch([article('Needle')]), articles: [{ ...article('Needle'), title: 4 }] }],
    ['invalid article content', { ...batch([article('Needle')]), articles: [{ ...article('Needle'), content: null }] }],
    ['invalid article URL', { ...batch([article('Needle')]), articles: [{ ...article('Needle'), url: 'secret malformed' }] }],
    ['outside article origin', { ...batch([article('Needle')]), articles: [{ ...article('Needle'), url: 'https://example.com/wiki/Needle' }] }],
    ['invalid article categories', { ...batch([article('Needle')]), articles: [{ ...article('Needle'), categories: [9] }] }],
  ];
  for (const [name, malformed] of invalid) {
    await t.test(name, async () => {
      let attempts = 0;
      const { calls, service } = fixture({}, async () => {
        attempts += 1;
        return attempts === 1 ? malformed : batch([article('Needle')]);
      });
      try {
        await assert.rejects(service.search('needle'), unavailable);
        assert.equal(service.stats().cachedQueries, 0);
        assert.equal(service.stats().active, 0);
        assert.equal((await service.search('needle')).total, 1);
        assert.equal(calls.length, 2);
      } finally { await service.close(); }
    });
  }
});

test('batch concurrency limits reject unrelated excess requests without contacting Wikipedia', async () => {
  const entered = deferred();
  const gate = deferred();
  let activeCalls = 0;
  const { calls, service } = fixture({ WIKIPEDIA_MAX_CONCURRENT_SEARCHES: '2' }, async (query) => {
    activeCalls += 1;
    if (activeCalls === 2) entered.resolve();
    await gate.promise;
    return batch([article(query)]);
  });
  const first = service.search('alpha');
  const second = service.search('beta');
  await entered.promise;
  try {
    assert.equal(service.stats().active, 2);
    await assert.rejects(service.search('gamma'), (error) => error.status === 503);
    assert.deepEqual(calls.map(([query]) => query), ['alpha', 'beta']);
    gate.resolve();
    assert.ok((await Promise.all([first, second])).every((result) => result.total === 1));
    assert.equal(service.stats().active, 0);
  } finally {
    gate.resolve();
    await Promise.allSettled([first, second]);
    await service.close();
  }
});

test('cached batch indexes stay isolated from unrelated search corpora and retain identical scores', async () => {
  const { calls, service } = fixture({}, async (query) => query === 'alpha'
    ? batch([article('Alpha')])
    : batch([article('Beta alpha'), article('Beta history')]));
  try {
    const first = await service.search('alpha', { explain: true });
    const other = await service.search('beta');
    const cached = await service.search('alpha', { explain: true });
    assert.equal(first.total, 1);
    assert.equal(other.total, 2);
    assert.equal(first.diagnostics.documentCount, 1);
    assert.equal(other.diagnostics.documentCount, 2);
    assert.deepEqual(cached.results, first.results);
    assert.equal(cached.diagnostics.documentCount, 1);
    assert.equal(calls.length, 2);
  } finally { await service.close(); }
});

test('empty queries skip upstream work and valid empty batches preserve no-results suggestions', async () => {
  const { calls, service } = fixture({}, async () => ({ articles: [], titles: ['Needle hint'], warnings: [] }));
  try {
    const empty = await service.search('the and');
    assert.equal(empty.total, 0);
    assert.equal(empty.diagnostics.reason, 'empty-query');
    assert.equal(calls.length, 0);
    const missing = await service.search('needle');
    assert.equal(missing.total, 0);
    assert.equal(missing.diagnostics.reason, 'no-wikipedia-articles');
    assert.deepEqual(missing.suggestions, ['Needle hint']);
    await service.search('needle');
    assert.equal(calls.length, 1);
  } finally { await service.close(); }
});
