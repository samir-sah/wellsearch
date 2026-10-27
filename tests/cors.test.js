import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createApp } from '../src/app.js';
import { buildConfig } from '../src/config/config.js';
import { createServices } from '../src/services.js';
import { silentLogger } from '../src/utils/logger.js';

async function withServer(env, run) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'wellsearch-cors-'));
  const config = buildConfig({ NODE_ENV: 'test', DATA_DIR: dataDir, PERSIST_INTERVAL_MS: '0', ...env });
  const services = await createServices({ config, logger: silentLogger });
  const server = await new Promise((resolve) => {
    const instance = createApp({ services }).listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const { port } = server.address();
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await services.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

test('CORS allows configured frontend origin and answers preflight', async () => {
  await withServer({ CORS_ORIGINS: 'https://search.example' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/search?q=test`, {
      method: 'OPTIONS',
      headers: { origin: 'https://search.example', 'access-control-request-method': 'GET' },
    });
    assert.equal(response.status, 204);
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://search.example');
    assert.equal(response.headers.get('vary'), 'Origin');
  });
});

test('CORS does not reflect an unconfigured origin', async () => {
  await withServer({ CORS_ORIGINS: 'https://search.example' }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`, { headers: { origin: 'https://evil.example' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });
});

test('production has no wildcard CORS default and crawl writes default disabled', () => {
  const config = buildConfig({ NODE_ENV: 'production' });
  assert.deepEqual(config.corsOrigins, []);
  assert.equal(config.api.crawlEnabled, false);
});

test('production rejects enabled crawl writes without a strong admin token', () => {
  assert.throws(
    () => buildConfig({ NODE_ENV: 'production', CRAWL_API_ENABLED: 'true', ADMIN_TOKEN: 'short' }),
    /ADMIN_TOKEN of at least 32 characters/,
  );
  const config = buildConfig({
    NODE_ENV: 'production', CRAWL_API_ENABLED: 'true', ADMIN_TOKEN: 'a'.repeat(32),
  });
  assert.equal(config.api.crawlEnabled, true);
});
