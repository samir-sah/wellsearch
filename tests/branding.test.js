import assert from 'node:assert/strict';
import test from 'node:test';
import { buildConfig } from '../src/config/config.js';
import { Fetcher } from '../src/crawler/fetcher.js';
import { extractMeta } from '../src/crawler/parser.js';
import { agentToken, evaluate, parseRobots, RobotsCache } from '../src/crawler/robots.js';

test('WellSearch defaults identify the crawler and select its robots group', () => {
  const config = buildConfig({ NODE_ENV: 'test' });
  assert.equal(config.crawler.userAgent, 'WellSearchBot/1.0 (+https://github.com/samir-sah/wellsearch)');
  assert.equal(new Fetcher().userAgent, 'WellSearchBot/1.0');
  assert.equal(new RobotsCache().token, 'wellsearchbot');

  const token = agentToken(config.crawler.userAgent);
  const rules = parseRobots('User-agent: *\nAllow: /\n\nUser-agent: WellSearchBot\nDisallow: /private', token);
  assert.equal(rules.agent, 'wellsearchbot');
  assert.equal(evaluate(rules.rules, '/private/page').allowed, false);
  assert.equal(evaluate(rules.rules, '/public/page').allowed, true);
});

test('WellSearch-specific meta directives control indexing and link following', () => {
  const meta = extractMeta('<meta name="WellSearchBot" content="noindex, nofollow">');
  assert.equal(meta.noindex, true);
  assert.equal(meta.nofollow, true);

  const otherBot = extractMeta('<meta name="unrelatedbot" content="noindex, nofollow">');
  assert.equal(otherBot.noindex, false);
  assert.equal(otherBot.nofollow, false);
});
