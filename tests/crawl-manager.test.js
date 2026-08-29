import test from 'node:test';
import assert from 'node:assert/strict';

import { CrawlManager } from '../src/crawler/crawlManager.js';
import { buildConfig } from '../src/config/config.js';
import { silentLogger } from '../src/utils/logger.js';

test('crawl requests cannot exceed the configured concurrency ceiling', () => {
  const config = buildConfig({ NODE_ENV: 'test', CRAWLER_CONCURRENCY: '2' });
  const manager = new CrawlManager({ config, logger: silentLogger, crawler: {} });

  const { options, warnings } = manager.validate({
    urls: 'https://example.com/',
    concurrency: 16,
  });

  assert.equal(options.concurrency, 2);
  assert.ok(warnings.includes('concurrency lowered to the configured maximum of 2'));
});
