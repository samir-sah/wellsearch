import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import http from 'node:http';

import { Fetcher } from '../src/crawler/fetcher.js';
import { WikipediaClient, WIKIPEDIA_ORIGIN } from '../src/wikipedia/client.js';

const address = { address: '93.184.216.34', family: 4 };
const publicLookup = async () => [address];
const articleUrl = `${WIKIPEDIA_ORIGIN}/wiki/JavaScript`;

test('Wikipedia origin guard blocks redirected destinations before DNS or connection', async () => {
  for (const destination of [
    'https://example.org/wiki/JavaScript',
    'http://en.wikipedia.org/wiki/JavaScript',
    'https://en.wikipedia.org:8443/wiki/JavaScript',
  ]) {
    const lookups = [];
    const connections = [];
    const fetcher = new Fetcher({
      lookup: async (hostname) => { lookups.push(hostname); return [address]; },
      fetchImpl: async (url) => {
        connections.push(url);
        return new Response(null, { status: 302, headers: { location: destination } });
      },
    });
    const result = await fetcher.fetch(articleUrl, { allowedOrigin: WIKIPEDIA_ORIGIN });
    assert.equal(result.ok, false, destination);
    assert.equal(result.errorType, 'blocked-origin', destination);
    assert.equal(result.redirectCount, 1);
    assert.deepEqual(lookups, ['en.wikipedia.org']);
    assert.deepEqual(connections, [articleUrl]);
  }
});

test('origin guard rejects an initial outside origin or credential-bearing URL without DNS or connection', async () => {
  let lookups = 0;
  let connections = 0;
  const fetcher = new Fetcher({
    lookup: async () => { lookups += 1; return [address]; },
    fetchImpl: async () => { connections += 1; return new Response('unused'); },
  });
  for (const url of ['https://example.org/wiki/Test', 'https://user:secret@en.wikipedia.org/wiki/Test']) {
    const result = await fetcher.fetch(url, { allowedOrigin: WIKIPEDIA_ORIGIN });
    assert.equal(result.errorType, 'blocked-origin');
  }
  assert.equal(lookups, 0);
  assert.equal(connections, 0);
});

test('Wikipedia same-origin redirects retain the validated destination and succeed', async () => {
  const connections = [];
  let lookups = 0;
  const finalUrl = `${WIKIPEDIA_ORIGIN}/wiki/JavaScript_language`;
  const fetcher = new Fetcher({
    lookup: async () => { lookups += 1; return [address]; },
    fetchImpl: async (url, options, target) => {
      connections.push(url);
      assert.equal(options.redirect, 'manual');
      assert.deepEqual(target.addresses, [address]);
      return url === articleUrl
        ? new Response(null, { status: 301, headers: { location: '/wiki/JavaScript_language' } })
        : new Response('<html>article text</html>', { headers: { 'content-type': 'text/html' } });
    },
  });
  const result = await fetcher.fetch(articleUrl, { allowedOrigin: WIKIPEDIA_ORIGIN });
  assert.equal(result.ok, true);
  assert.equal(result.finalUrl, finalUrl);
  assert.equal(result.redirectCount, 1);
  assert.deepEqual(connections, [articleUrl, finalUrl]);
  assert.equal(lookups, 2);
});

test('optional origin guard preserves public cross-origin redirects for the original crawler', async () => {
  const connections = [];
  const fetcher = new Fetcher({
    lookup: publicLookup,
    fetchImpl: async (url) => {
      connections.push(url);
      return connections.length === 1
        ? new Response(null, { status: 302, headers: { location: 'https://example.org/final' } })
        : new Response('Public destination');
    },
  });
  const result = await fetcher.fetch('https://example.test/start');
  assert.equal(result.ok, true);
  assert.equal(result.finalUrl, 'https://example.org/final');
  assert.deepEqual(connections, ['https://example.test/start', 'https://example.org/final']);
});

test('Wikipedia request timeout bounds a resolver that never settles', { timeout: 2500 }, async () => {
  let connections = 0;
  const fetcher = new Fetcher({
    lookup: () => new Promise(() => {}),
    fetchImpl: async () => { connections += 1; return new Response('unused'); },
  });
  const started = performance.now();
  const result = await fetcher.fetch(articleUrl, {
    allowedOrigin: WIKIPEDIA_ORIGIN,
    timeoutMs: 80,
  });
  assert.equal(result.ok, false);
  assert.equal(result.errorType, 'timeout');
  assert.equal(result.retryable, true);
  assert.equal(connections, 0);
  assert.ok(performance.now() - started < 2000, 'DNS timeout must resolve without waiting on the resolver');
});

test('Wikipedia redirect hops share one request timeout budget', { timeout: 3000 }, async () => {
  const connections = [];
  const fetcher = new Fetcher({
    lookup: publicLookup,
    fetchImpl: async (url, { signal }) => {
      connections.push(url);
      await delay(120, undefined, { signal });
      const hop = Number(new URL(url).searchParams.get('hop') ?? 0);
      return hop < 3
        ? new Response(null, { status: 302, headers: { location: `/wiki/JavaScript?hop=${hop + 1}` } })
        : new Response('Finished all four requests');
    },
  });
  const started = performance.now();
  const result = await fetcher.fetch(articleUrl, { allowedOrigin: WIKIPEDIA_ORIGIN, timeoutMs: 300 });
  assert.equal(result.ok, false);
  assert.equal(result.errorType, 'timeout');
  assert.ok(connections.length >= 2 && connections.length < 4, 'redirects must stop before a new budget could finish the chain');
  assert.ok(performance.now() - started < 2000, 'the redirect chain must finish within a bounded request budget');
});

test('Wikipedia client rejects actual streamed byte-cap truncation and cancels the response', async () => {
  let cancelled = false;
  const fetcher = new Fetcher({
    config: { crawler: { maxContentBytes: 128 } },
    lookup: publicLookup,
    fetchImpl: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('<p>article content</p>'.repeat(200))); },
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/html' } }),
  });
  const client = new WikipediaClient({ fetcher });
  await assert.rejects(client.fetchArticle('JavaScript'), (error) => {
    assert.equal(error.status, 502);
    assert.equal(error.code, 'WIKIPEDIA_UNAVAILABLE');
    return true;
  });
  assert.equal(fetcher.stats().bytes, 128);
  assert.equal(cancelled, true);
});

test('Wikipedia client rejects an oversized Content-Length before reading the body', async () => {
  let cancelled = false;
  const fetcher = new Fetcher({
    config: { crawler: { maxContentBytes: 128 } },
    lookup: publicLookup,
    fetchImpl: async () => new Response(new ReadableStream({
      cancel() { cancelled = true; },
    }), { headers: { 'content-type': 'text/html', 'content-length': '4000' } }),
  });
  const client = new WikipediaClient({ fetcher });
  await assert.rejects(client.fetchArticle('JavaScript'), { status: 502, code: 'WIKIPEDIA_UNAVAILABLE' });
  assert.equal(fetcher.stats().bytes, 0);
  assert.equal(cancelled, true);
});

test('native HTTP null-body statuses return fetch results without throwing from the response callback', { timeout: 5000 }, async (t) => {
  const server = http.createServer((request, reply) => {
    reply.writeHead(Number(request.url.slice(1)), { 'content-type': 'text/html' });
    reply.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections?.();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fetcher = new Fetcher({ config: { crawler: { allowPrivateNetwork: true, requestTimeout: 1000 } } });
  for (const status of [204, 205, 304]) {
    const result = await fetcher.fetch(`${origin}/${status}`, { allowedOrigin: origin });
    assert.equal(result.status, status);
    if (status === 304) {
      assert.equal(result.ok, false);
      assert.equal(result.errorType, 'bad-redirect');
    } else {
      assert.equal(result.ok, true);
      assert.equal(result.text, '');
      assert.equal(result.bytes, 0);
    }
  }
});
