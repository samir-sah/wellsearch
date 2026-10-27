import test from 'node:test';
import assert from 'node:assert/strict';

import { WikipediaClient } from '../src/wikipedia/client.js';
import { toErrorResponse } from '../src/utils/errors.js';

const WIKI = 'https://en.wikipedia.org';
const prose = 'Quantum physics describes matter and energy at very small scales. ' +
  'Scientists use mathematical models and experiments to explain particles and their interactions.';

function page(extra = {}) {
  return {
    pageid: 1, ns: 0, index: 1, title: 'Quantum physics', extract: prose,
    fullurl: `${WIKI}/wiki/Quantum_physics`,
    categories: [{ ns: 14, title: 'Category:Physics' }],
    ...extra,
  };
}

function clientWith(data, extra = {}) {
  const calls = [];
  const client = new WikipediaClient({
    config: { wikipedia: { requestTimeoutMs: 2750 } },
    fetcher: { fetch: async (url, options) => {
      calls.push({ url: new URL(url), options });
      return { ok: true, text: typeof data === 'string' ? data : JSON.stringify(data),
        contentType: 'application/json; charset=utf-8', ...extra };
    } },
  });
  return { client, calls };
}

function result(pages, extra = {}) {
  return { batchcomplete: true, query: { pages }, ...extra };
}

function isUnavailable(error) {
  assert.equal(error.status, 502);
  assert.equal(error.code, 'WIKIPEDIA_UNAVAILABLE');
  assert.deepEqual(toErrorResponse(error), {
    status: 502,
    body: { error: { code: 'WIKIPEDIA_UNAVAILABLE', message: 'Wikipedia is temporarily unavailable. Please try again.' } },
  });
  return true;
}

test('batch retrieval gets candidates, lead extracts, categories and URLs in one encoded fixed-origin request', async () => {
  const { client, calls } = clientWith(result([page()]));
  const response = await client.searchArticles('  C++ & quantum  ');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url.origin, WIKI);
  assert.equal(calls[0].url.pathname, '/w/api.php');
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), {
    action: 'query', generator: 'prefixsearch', gpssearch: 'C++ & quantum', gpsnamespace: '0', gpslimit: '8',
    prop: 'extracts|categories|info', exintro: '1', explaintext: '1', exlimit: '8',
    clshow: '!hidden', cllimit: '500', inprop: 'url', redirects: '1', format: 'json', formatversion: '2',
  });
  assert.equal(calls[0].url.searchParams.has('exchars'), false);
  assert.deepEqual(calls[0].options, { acceptAnyType: true, timeoutMs: 2750, allowedOrigin: WIKI });
  assert.deepEqual(response.titles, ['Quantum physics']);
  assert.deepEqual(response.warnings, []);
  assert.equal(response.articles.length, 1);
  assert.deepEqual(response.articles[0], {
    id: `${WIKI}/wiki/Quantum_physics`, title: 'Quantum physics', url: `${WIKI}/wiki/Quantum_physics`,
    content: prose, categories: ['Physics'], fetchedAt: response.articles[0].fetchedAt,
  });
  assert.ok(Number.isFinite(Date.parse(response.articles[0].fetchedAt)));
});

test('batch limits are bounded, and blank queries make no network request', async () => {
  const { client, calls } = clientWith(result(Array.from({ length: 12 }, (_, index) => page({
    index: index + 1, title: `Page ${index}`, fullurl: `${WIKI}/wiki/Page_${index}`,
  }))));
  assert.deepEqual(await client.searchArticles('   '), { articles: [], titles: [], warnings: [] });
  assert.equal(calls.length, 0);
  assert.equal((await client.searchArticles('query', 99)).articles.length, 8);
  assert.equal(calls[0].url.searchParams.get('gpslimit'), '8');
  assert.equal((await client.searchArticles('query', 2.9)).articles.length, 2);
  assert.equal(calls[1].url.searchParams.get('exlimit'), '2');
  assert.equal((await client.searchArticles('query', -4)).articles.length, 1);
  assert.equal((await client.searchArticles('query', Number.NaN)).articles.length, 8);
});

test('empty complete API responses and genuinely short or missing pages are valid empty batches', async () => {
  for (const data of [{ batchcomplete: true }, result([]), result([page({ extract: 'Short.' })]),
    result([{ ns: 0, title: 'Missing', missing: true }])]) {
    const { client, calls } = clientWith(data);
    const response = await client.searchArticles('nothing');
    assert.deepEqual(response.articles, []);
    assert.deepEqual(response.warnings, []);
    assert.equal(calls.length, 1);
  }
});

test('batch parser rejects malformed JSON, malformed envelopes, errors and all missing extracts safely', async () => {
  for (const data of ['not json', '{}', 'null', '[]', { error: { info: 'secret upstream details' } },
    { errors: [{ text: 'secret upstream details' }] }, { batchcomplete: true, warnings: 'invalid' },
    { query: { pages: {} } }, result([page({ extract: undefined })]), result([page({ extract: 7 })]),
    result([null]), result([page({ title: 7 })]), result([page({ title: 'x'.repeat(301) })]),
    ...[undefined, -1, 1.5, '0'].map((ns) => result([page({ ns })])), result([page({ fullurl: undefined })])]) {
    await assert.rejects(clientWith(data).client.searchArticles('query'), isUnavailable);
  }
});

test('valid namespace-prefixed searches skip non-article pages without reporting an upstream outage', async () => {
  for (const [ns, title] of [[14, 'Category:Physics'], [12, 'Help:Contents'], [1, 'Talk:Quantum physics']]) {
    const { client } = clientWith(result([{ ns, title }]));
    assert.deepEqual(await client.searchArticles(title), { articles: [], titles: [], warnings: [] });
  }
  const mixed = await clientWith(result([page(), { ns: 14, title: 'Category:Physics' }])).client.searchArticles('physics');
  assert.equal(mixed.articles.length, 1);
  assert.deepEqual(mixed.titles, ['Quantum physics']);
  assert.deepEqual(mixed.warnings, []);
});

test('batch parser enforces the safe fetch boundary and rejects unsafe canonical or full URLs', async () => {
  for (const extra of [{ ok: false, status: 429 }, { truncated: true }, { finalUrl: 'https://example.org/w/api.php' }]) {
    await assert.rejects(clientWith(result([page()]), extra).client.searchArticles('query'), isUnavailable);
  }
  for (const href of ['https://example.org/wiki/Quantum', 'http://en.wikipedia.org/wiki/Quantum',
    `${WIKI}/w/index.php?title=Quantum`, `${WIKI}/wiki/`, `${WIKI}/wiki/%2e%2e/admin`,
    'https://user:password@en.wikipedia.org/wiki/Quantum']) {
    await assert.rejects(clientWith(result([page({ fullurl: href })])).client.searchArticles('query'), isUnavailable);
    await assert.rejects(clientWith(result([page({ canonicalurl: href })])).client.searchArticles('query'), isUnavailable);
  }
});

test('partial batches expose only a generic warning, preserve useful articles and retain skipped candidate titles', async () => {
  const { client } = clientWith(result([
    page({ index: 3, title: 'No extract', fullurl: `${WIKI}/wiki/No_extract`, extract: undefined }),
    page({ index: 2, title: 'Short', fullurl: `${WIKI}/wiki/Short`, extract: 'Too short.' }),
    page({ index: 1 }),
  ]));
  const response = await client.searchArticles('query');
  assert.equal(response.articles.length, 1);
  assert.deepEqual(response.titles, ['Quantum physics', 'Short', 'No extract']);
  assert.deepEqual(response.warnings, ['Some Wikipedia articles could not be loaded.']);
});

test('API warnings and unfinished categories cannot be mistaken for a complete cacheable batch', async () => {
  for (const extra of [
    { warnings: { extracts: { '*': 'secret upstream details' } } },
    { continue: { clcontinue: '123|Some_category', continue: '||' } },
  ]) {
    const response = await clientWith(result([page()], extra)).client.searchArticles('query');
    assert.deepEqual(response.warnings, ['Some Wikipedia articles could not be loaded.']);
    assert.equal(response.articles.length, 1);
    assert.doesNotMatch(JSON.stringify(response), /secret upstream/);
  }
  await assert.rejects(clientWith({ batchcomplete: true, warnings: { extracts: {} } }).client.searchArticles('query'), isUnavailable);
});

test('batch extraction caps content, cleans text, deduplicates safe canonical identities and preserves candidate order', async () => {
  const response = await clientWith(result([
    page({ index: 3, title: 'Redirect', canonicalurl: `${WIKI}/wiki/Quantum%20physics#History` }),
    page({ index: 2, title: 'Other', fullurl: `${WIKI}/wiki/Other`, extract: prose.repeat(40) }),
    page({ index: 1, title: '  Quantum  physics  ', extract: `  ${prose}\n\t[2]  ` }),
  ])).client.searchArticles('query');
  assert.deepEqual(response.articles.map(({ title }) => title), ['Quantum physics', 'Other']);
  assert.equal(response.articles[0].content, prose);
  assert.equal(response.articles[0].id, `${WIKI}/wiki/Quantum_physics`);
  assert.equal(response.articles[1].content.length, 4000);
  assert.deepEqual(response.warnings, []);
});

test('batch categories are optional, deduplicated, hidden-excluded and capped without trusting malformed metadata', async () => {
  const categories = [{ ns: 14, title: 'Category:Physics' }, { ns: 14, title: 'Category: Physics ' },
    { ns: 14, title: 'Category:Hidden', hidden: true },
    ...Array.from({ length: 30 }, (_, index) => ({ ns: 14, title: `Category:Subject ${index}` }))];
  const response = await clientWith(result([page({ categories })])).client.searchArticles('query');
  assert.equal(response.articles[0].categories.length, 20);
  assert.equal(response.articles[0].categories[0], 'Physics');
  assert.equal(response.articles[0].categories.includes('Hidden'), false);
  assert.deepEqual(response.warnings, []);
  const noCategories = await clientWith(result([page({ categories: undefined })])).client.searchArticles('query');
  assert.deepEqual(noCategories.articles[0].categories, []);
  assert.deepEqual(noCategories.warnings, []);
  for (const invalid of [5, [null, { title: 'Not a category' }, { title: 1 }]]) {
    const partial = await clientWith(result([page({ categories: invalid })])).client.searchArticles('query');
    assert.deepEqual(partial.articles[0].categories, []);
    assert.equal(partial.warnings.length, 1);
  }
});
