/** Opt-in live benchmark: performs real Wikipedia requests, never run by tests. */
import { createApp } from '../src/app.js';
import { buildConfig } from '../src/config/config.js';
import { Fetcher } from '../src/crawler/fetcher.js';
import { createServices } from '../src/services.js';
import { silentLogger } from '../src/utils/logger.js';
import { WikipediaClient } from '../src/wikipedia/client.js';

const queries = process.argv.slice(2);
if (!queries.length) queries.push('Quantum computing', 'Renaissance art', 'Neuroscience');
const config = buildConfig({
  NODE_ENV: 'test', HOST: '127.0.0.1', PORT: '0', SEARCH_SOURCE: 'wikipedia',
  PERSIST_INTERVAL_MS: '0', SEARCH_RATE_LIMIT: '1000',
});
const fetcher = new Fetcher({ config, logger: silentLogger });
const services = await createServices({
  config, logger: silentLogger, load: false,
  wikipediaClient: new WikipediaClient({ config, fetcher }),
});
let server;
try {
  server = await new Promise((resolve, reject) => {
    const instance = createApp({ services }).listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const query of queries) {
    for (const state of ['cold', 'warm']) {
      const before = fetcher.stats();
      const started = performance.now();
      const response = await fetch(`${base}/api/search?${new URLSearchParams({ q: query })}`);
      const body = await response.json();
      const after = fetcher.stats();
      console.log(JSON.stringify({
        query, state, status: response.status,
        wallMs: Math.round((performance.now() - started) * 100) / 100,
        serverMs: body.took, retrievalMs: body.timings?.retrieval, scoringMs: body.timings?.scoring,
        requests: after.requests - before.requests, bytes: after.bytes - before.bytes,
        results: body.total, warnings: body.warnings, error: body.error,
      }));
      if (!response.ok) process.exitCode = 1;
    }
  }
} finally {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections?.();
    });
  }
  await services.close();
}
