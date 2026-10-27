import test from 'node:test';
import assert from 'node:assert/strict';

import { BM25Index, buildSnippet } from '../src/wikipedia/bm25.js';
import { WikipediaClient } from '../src/wikipedia/client.js';
import { tokenize, tokenizeWithOriginals } from '../src/wikipedia/tokenizer.js';
import { toErrorResponse } from '../src/utils/errors.js';

const WIKI = 'https://en.wikipedia.org';
const prose = 'Quantum physics studies the behavior of matter and energy at very small scales. ' +
  'Scientists use mathematical models and experiments to describe particles and their interactions.';

function article({ title = 'Quantum physics', canonical, content = prose, categories = ['Physics'] } = {}) {
  return `<!doctype html><html><head>${canonical ? `<link rel="canonical" href="${canonical}">` : ''}</head>
    <body><h1 id="firstHeading">${title}</h1><main id="mw-content-text">
      <div class="infobox"><p>Infobox clutter should never enter the article text or the search result snippet.</p></div>
      <div class="hatnote"><p>Navigation and disambiguation notices should also disappear from extracted article text.</p></div>
      <p>${content}<sup class="reference">[9]</sup><script>window.secret = 'script clutter';</script></p>
      <p>Short.</p><div class="reflist"><p>Reference clutter should never enter the article text or the search result snippet.</p></div>
    </main><div id="mw-normal-catlinks"><ul>${categories.map((category) => `<li><a>${category}</a></li>`).join('')}</ul></div>
    </body></html>`;
}

function response(text, extra = {}) {
  return { ok: true, text, contentType: 'text/html; charset=utf-8', ...extra };
}

function clientWith(result) {
  return new WikipediaClient({ fetcher: { fetch: async () => result } });
}

test('archive tokenizer shares stopwords, suffixes, and hyphen boundaries across both entry points', () => {
  const text = 'The physics-and-quantum articles are categorized with experiments.';
  assert.deepEqual(tokenize(text), ['physic', 'quantum', 'articl', 'categoriz', 'experi']);
  assert.deepEqual(tokenizeWithOriginals(text).map((item) => item.stem), tokenize(text));
  assert.deepEqual(tokenize(null), []);
});

test('title and category terms receive their weights without merging repeated text', () => {
  const index = new BM25Index({ b: 0 });
  index.addDocument({ id: 'body', title: 'Other', content: 'quantum' });
  index.addDocument({ id: 'category', title: 'Other', content: 'filler', categories: ['quantum'] });
  index.addDocument({ id: 'title', title: 'quantum', content: 'filler' });
  const results = index.search('quantum');
  assert.deepEqual(results.map(({ doc }) => doc.id), ['title', 'category', 'body']);
  assert.equal(results[0].documentLength, 4);
  assert.ok(results[0].score > results[1].score && results[1].score > results[2].score);
  assert.equal(index.index.get('quantum').get('title'), 3);
  assert.equal(index.index.get('quantum').get('category'), 2);
});

test('BM25 numerical score follows the archive formula and unique query terms do not inflate it', () => {
  const index = new BM25Index({ k1: 1.5, b: 0.75 });
  index.addDocument({ id: 'a', title: '', content: 'quantum quantum particle' });
  index.addDocument({ id: 'b', title: '', content: 'particle' });
  const result = index.search('quantum quantum')[0];
  const expected = Math.log(1 + 1.5 / 1.5) * (2 * 2.5) / (2 + 1.5 * (0.25 + 0.75 * 3 / 2));
  assert.ok(Math.abs(result.score - expected) < 1e-12);
  assert.equal(result.matchedTerms, 1);
  assert.deepEqual(result.matchedTermList, ['quantum']);
  assert.equal(result.score, index.search('quantum')[0].score);
});

test('pre-tokenized queries are stemmed only once, and k1=0 disables frequency saturation', () => {
  const index = new BM25Index({ k1: 0 });
  index.addDocument({ id: 'a', title: '', content: 'biased biased' });
  index.addDocument({ id: 'b', title: '', content: 'biased' });
  const terms = tokenize('biased');
  assert.deepEqual(terms, ['bias']);
  assert.deepEqual(tokenize(terms[0]), ['bia']);
  const results = index.searchTerms(terms);
  assert.equal(results.length, 2);
  assert.equal(results[0].score, results[1].score);
  assert.equal(results[0].score, Math.log(1 + 0.5 / 2.5));
  assert.equal(index.search('biased').length, 2);
});

test('canonical URL identity replaces documents and removes obsolete postings and length totals', () => {
  const index = new BM25Index();
  const url = `${WIKI}/wiki/Quantum_physics`;
  index.addDocument({ id: 1, url: `${url}#History`, title: 'Old heading', content: 'obsolete obsolete' });
  index.addDocument({ id: 99, url: `${WIKI}/wiki/Quantum%20physics?source=test`, title: 'New heading', content: 'updated' });
  assert.equal(index.docCount, 1);
  assert.equal(index.search('obsolete').length, 0);
  assert.equal(index.search('updated')[0].doc.id, url);
  assert.equal(index.documents.get(url).title, 'New heading');
  assert.equal(index.stats().totalTokens, 7);
  assert.equal(index.removeDocument(url), true);
  assert.equal(index.removeDocument(url), false);
  assert.equal(index.stats().documents, 0);
  assert.equal(index.stats().terms, 0);
  assert.equal(index.stats().totalTokens, 0);
});

test('ranking ties use stable identity order, respect result limits, and handle empty queries', () => {
  const index = new BM25Index();
  for (const id of ['z', 'b', 'a']) index.addDocument({ id, title: 'quantum', content: 'particle' });
  assert.deepEqual(index.search('quantum', 2).map(({ doc }) => doc.id), ['a', 'b']);
  assert.deepEqual(index.search('the and'), []);
  assert.deepEqual(index.search(''), []);
  assert.deepEqual(index.search('quantum', 0), []);
  assert.deepEqual(index.search('quantum', -1), []);
  index.clear();
  assert.deepEqual(index.titles(), []);
  assert.equal(index.stats().terms, 0);
});

test('snippets remain plain text with no generated markup and choose a useful query window', () => {
  const literal = 'An encoded example reads <img src=x onerror=alert(1)> alongside quantum physics.';
  assert.equal(buildSnippet(literal, ['quantum']), literal);
  assert.ok(!buildSnippet(literal, ['quantum']).includes('<mark>'));
  const longText = 'A generic introduction with no search terms. '.repeat(15) + prose;
  const snippet = buildSnippet(longText, ['quantum', 'physic']);
  assert.ok(snippet.includes('Quantum physics'));
  assert.ok(snippet.startsWith('…'));
  assert.ok(snippet.length <= 242);
});

test('OpenSearch uses encoded fixed-origin requests, validates responses, and deduplicates titles', async () => {
  let requested;
  const client = new WikipediaClient({
    config: { wikipedia: { requestTimeoutMs: 2750 } },
    fetcher: { fetch: async (url, options) => {
      requested = { url: new URL(url), options };
      return response(JSON.stringify(['C++ & quantum', ['C++', ' C++ ', 'Quantum physics'], [], []]), {
        contentType: 'application/json',
      });
    } },
  });
  assert.deepEqual(await client.suggest('C++ & quantum', 2), ['C++', 'Quantum physics']);
  assert.equal(requested.url.origin, WIKI);
  assert.equal(requested.url.pathname, '/w/api.php');
  assert.equal(requested.url.searchParams.get('search'), 'C++ & quantum');
  assert.equal(requested.url.searchParams.get('redirects'), 'resolve');
  assert.deepEqual(requested.options, { acceptAnyType: true, timeoutMs: 2750, allowedOrigin: WIKI });
});

test('OpenSearch handles no suggestions and blank queries without making a request', async () => {
  assert.deepEqual(await clientWith(response('["nothing",[],[],[]]')).suggest('nothing'), []);
  let calls = 0;
  const client = new WikipediaClient({ fetcher: { fetch: async () => { calls += 1; } } });
  assert.deepEqual(await client.suggest('  '), []);
  assert.equal(calls, 0);
});

test('OpenSearch malformed JSON, API errors, invalid title arrays and truncated bodies fail safely', async () => {
  for (const body of ['not json', '{}', '{"error":{"info":"secret upstream details"}}', '["q",[5],[],[]]']) {
    await assert.rejects(clientWith(response(body)).suggest('q'), isUnavailable);
  }
  await assert.rejects(clientWith(response('["q",[],[],[]]', { truncated: true })).suggest('q'), isUnavailable);
});

test('article extraction removes Wikipedia chrome, references, and executable markup', async () => {
  const url = `${WIKI}/wiki/Quantum_physics`;
  const result = await clientWith(response(article({ categories: ['Physics', 'Physics', 'Quantum mechanics'] }), {
    finalUrl: url,
  })).fetchArticle('Quantum physics');
  assert.equal(result.title, 'Quantum physics');
  assert.equal(result.id, url);
  assert.equal(result.url, url);
  assert.equal(result.content, prose);
  assert.deepEqual(result.categories, ['Physics', 'Quantum mechanics']);
  assert.ok(Number.isFinite(Date.parse(result.fetchedAt)));
  assert.doesNotMatch(result.content, /clutter|script|\[9\]/);
});

test('article identity follows a safe canonical URL and caps content and categories', async () => {
  const canonical = `${WIKI}/wiki/Quantum_mechanics#History`;
  const result = await clientWith(response(article({
    canonical,
    content: prose.repeat(40),
    categories: Array.from({ length: 30 }, (_, n) => `Category ${n}`),
  }), { finalUrl: `${WIKI}/wiki/Quantum_physics` })).fetchArticle('Quantum physics');
  assert.equal(result.id, `${WIKI}/wiki/Quantum_mechanics`);
  assert.equal(result.url, result.id);
  assert.equal(result.content.length, 4000);
  assert.equal(result.categories.length, 20);
});

test('article titles encode slash, query, fragment, percent, and Unicode within the fixed wiki path', async () => {
  let requested;
  const title = 'AC/DC? C# 100% café';
  const client = new WikipediaClient({ fetcher: { fetch: async (url, options) => {
    requested = { url, options };
    return response(article({ title }), { finalUrl: url });
  } } });
  const result = await client.fetchArticle(title);
  assert.equal(requested.url, `${WIKI}/wiki/AC%2FDC%3F_C%23_100%25_caf%C3%A9`);
  assert.equal(new URL(requested.url).search, '');
  assert.equal(new URL(requested.url).hash, '');
  assert.equal(result.id, requested.url);
  assert.equal(requested.options.allowedOrigin, WIKI);
  assert.equal(requested.options.timeoutMs, 3500);
});

test('article requests distinguish missing or too-short pages from upstream request failures', async () => {
  assert.equal(await clientWith({ ok: false, status: 404 }).fetchArticle('Missing'), null);
  assert.equal(await clientWith(response(article({ content: 'Too short.' }))).fetchArticle('Short'), null);
  assert.equal(await clientWith(response(article())).fetchArticle(''), null);
  for (const result of [{ ok: false, status: 429 }, { ok: false, errorType: 'timeout' }, { ok: false, errorType: 'dns' }]) {
    await assert.rejects(clientWith(result).fetchArticle('Quantum'), isUnavailable);
  }
  const throwing = new WikipediaClient({ fetcher: { fetch: async () => { throw new Error('private server details'); } } });
  await assert.rejects(throwing.fetchArticle('Quantum'), isUnavailable);
});

test('article responses reject outside origins, non-article destinations, unsafe canonicals and non-HTML content', async () => {
  for (const extra of [
    { finalUrl: 'https://example.org/wiki/Quantum' },
    { finalUrl: `${WIKI}/w/index.php?title=Quantum` },
    { finalUrl: `${WIKI}/wiki/` },
    { contentType: 'application/json' },
  ]) {
    await assert.rejects(clientWith(response(article(), extra)).fetchArticle('Quantum'), isUnavailable);
  }
  for (const canonical of ['https://example.org/wiki/Quantum', `${WIKI}/wiki/%2e%2e/admin`, `${WIKI}/w/index.php`]) {
    await assert.rejects(clientWith(response(article({ canonical }))).fetchArticle('Quantum'), isUnavailable);
  }
});

function isUnavailable(error) {
  assert.equal(error.status, 502);
  assert.equal(error.code, 'WIKIPEDIA_UNAVAILABLE');
  assert.deepEqual(toErrorResponse(error), {
    status: 502,
    body: { error: { code: 'WIKIPEDIA_UNAVAILABLE', message: 'Wikipedia is temporarily unavailable. Please try again.' } },
  });
  return true;
}
