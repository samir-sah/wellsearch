import test from 'node:test';
import assert from 'node:assert/strict';

import { checkCrawlTarget, isPrivateAddress } from '../src/crawler/networkPolicy.js';
import { Fetcher } from '../src/crawler/fetcher.js';
import { buildConfig } from '../src/config/config.js';

const lookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('address policy blocks private, metadata, mapped IPv4, and IPv6 special ranges', () => {
  for (const address of [
    '0.0.0.0', '10.0.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1',
    '192.168.0.1', '224.0.0.1', '::', '::1', '::ffff:127.0.0.1',
    '::ffff:169.254.169.254', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1',
  ]) assert.equal(isPrivateAddress(address), true, address);

  assert.equal(isPrivateAddress('8.8.8.8'), false);
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
});

test('literal and metadata host targets fail before any request', async () => {
  for (const url of [
    'http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/',
    'http://[::ffff:7f00:1]/', 'http://metadata.google.internal/',
  ]) {
    const result = await checkCrawlTarget(url, { lookup });
    assert.equal(result.allowed, false, url);
    assert.equal(result.reason, 'private-network', url);
  }
});

test('mixed DNS answers fail closed', async () => {
  const result = await checkCrawlTarget('https://example.test/', {
    lookup: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ],
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, 'private-network');
});

test('fetch receives the exact validated multi-address set without re-resolution', async () => {
  let lookups = 0;
  let seen;
  const fetcher = new Fetcher({
    config: buildConfig({ NODE_ENV: 'test' }),
    lookup: async () => {
      lookups += 1;
      return [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ];
    },
    fetchImpl: async (_url, _options, target) => {
      seen = target.addresses;
      return new Response('<html>ok</html>', { headers: { 'content-type': 'text/html' } });
    },
  });
  const result = await fetcher.fetch('https://example.test/');
  assert.equal(result.ok, true);
  assert.equal(lookups, 1);
  assert.deepEqual(seen, [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
  ]);
});

test('every redirect is revalidated and blocked before destination fetch', async () => {
  let requests = 0;
  const fetcher = new Fetcher({
    config: buildConfig({ NODE_ENV: 'test' }),
    lookup,
    fetchImpl: async () => {
      requests += 1;
      return new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/latest/' } });
    },
  });
  const result = await fetcher.fetch('https://example.test/start');
  assert.equal(result.ok, false);
  assert.equal(result.errorType, 'private-network');
  assert.equal(result.redirectCount, 1);
  assert.equal(requests, 1);
});
