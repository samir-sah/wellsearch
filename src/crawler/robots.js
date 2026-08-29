/**
 * robots.txt support.
 *
 * Implements the parts of RFC 9309 that matter for a polite crawler:
 *   - user-agent group selection (most specific match, then `*`)
 *   - Allow / Disallow with `*` wildcards and `$` end-anchors
 *   - longest-match wins; Allow wins a tie (RFC 9309 section 2.2.2)
 *   - Crawl-delay (a de-facto extension, honoured when larger than our own)
 *   - Sitemap discovery
 *
 * One robots.txt is fetched per origin and shared by every worker: the cache
 * stores the in-flight promise, so eight workers starting at once still make a
 * single request.
 *
 * Deviation, deliberate and logged: RFC 9309 says a 5xx on robots.txt should be
 * treated as "disallow everything". A demo crawl pointed at a flaky host would
 * then silently index nothing at all, which is a worse failure mode for this
 * project, so an unreachable robots.txt is treated as "allow" and a warning is
 * emitted. Set RESPECT_ROBOTS=false to skip robots handling entirely.
 */

import { robotsUrlFor } from '../utils/url.js';

const MAX_ROBOTS_BYTES = 512 * 1024;
const MAX_RULES = 2_000;
const EMPTY_RULES = { rules: [], crawlDelayMs: null, sitemaps: [], source: 'none' };

export class RobotsCache {
  constructor({ fetcher, config, logger } = {}) {
    this.fetcher = fetcher;
    this.logger = logger;
    this.userAgent = config?.crawler?.userAgent ?? 'NixSearchBot/1.0';
    this.token = agentToken(this.userAgent);
    this.enabled = config?.crawler?.respectRobots ?? true;
    /** @type {Map<string, Promise<object>>} */
    this.cache = new Map();
    this.fetches = 0;
    this.blocked = 0;
  }

  /**
   * @param {string} url
   * @returns {Promise<{allowed: boolean, reason: string, crawlDelayMs: number|null}>}
   */
  async isAllowed(url) {
    if (!this.enabled) return { allowed: true, reason: 'robots-disabled', crawlDelayMs: null };

    let target;
    try {
      target = new URL(url);
    } catch {
      return { allowed: false, reason: 'invalid-url', crawlDelayMs: null };
    }

    const group = await this.groupFor(target.origin);
    const path = `${target.pathname}${target.search}`;
    const decision = evaluate(group.rules, path);

    if (!decision.allowed) this.blocked += 1;
    return {
      allowed: decision.allowed,
      reason: decision.reason,
      crawlDelayMs: group.crawlDelayMs,
      pattern: decision.pattern,
    };
  }

  /** Cached rule group for an origin (fetches robots.txt at most once). */
  groupFor(origin) {
    let pending = this.cache.get(origin);
    if (pending === undefined) {
      pending = this.#load(origin);
      this.cache.set(origin, pending);
    }
    return pending;
  }

  async #load(origin) {
    const url = robotsUrlFor(origin);
    if (url === null) return EMPTY_RULES;

    this.fetches += 1;
    let result;
    try {
      result = await this.fetcher.fetch(url, { acceptAnyType: true, timeoutMs: 5_000 });
    } catch (error) {
      // Fetcher is not supposed to throw, but never let robots handling be the
      // thing that breaks a crawl.
      this.logger?.warn('robots.txt fetch threw', { origin, error });
      return { ...EMPTY_RULES, source: 'error' };
    }

    if (!result.ok) {
      if (result.status === 404 || result.status === 410) {
        return { ...EMPTY_RULES, source: 'absent' };
      }
      this.logger?.warn('robots.txt unavailable, proceeding without it', {
        origin, status: result.status, error: result.error,
      });
      return { ...EMPTY_RULES, source: 'unavailable' };
    }

    const text = result.text.length > MAX_ROBOTS_BYTES ? result.text.slice(0, MAX_ROBOTS_BYTES) : result.text;
    const parsed = parseRobots(text, this.token);
    this.logger?.debug('robots.txt loaded', {
      origin, rules: parsed.rules.length, crawlDelayMs: parsed.crawlDelayMs,
    });
    return parsed;
  }

  stats() {
    return { enabled: this.enabled, origins: this.cache.size, fetches: this.fetches, blocked: this.blocked };
  }

  clear() {
    this.cache.clear();
  }
}

/** `NixSearchBot/1.0 (+https://...)` -> `nixsearchbot` */
export function agentToken(userAgent) {
  const first = String(userAgent).trim().split(/[\s/]+/)[0] ?? '';
  return first.toLowerCase();
}

/**
 * Parse robots.txt and return the rule group that applies to `token`.
 *
 * @param {string} text
 * @param {string} token our lower-cased user-agent token
 * @returns {{rules: Array<{allow: boolean, pattern: string, matcher: RegExp|null, length: number}>,
 *            crawlDelayMs: number|null, sitemaps: string[], source: string, agent: string|null}}
 */
export function parseRobots(text, token = '*') {
  /** @type {Map<string, {rules: any[], crawlDelayMs: number|null}>} */
  const groups = new Map();
  const sitemaps = [];
  let currentAgents = [];
  let expectingAgents = false;
  let ruleCount = 0;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.split('#')[0].trim();
    if (line === '') continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent' || field === 'useragent') {
      if (!expectingAgents) {
        currentAgents = [];
        expectingAgents = true;
      }
      const agent = value.toLowerCase();
      currentAgents.push(agent);
      if (!groups.has(agent)) groups.set(agent, { rules: [], crawlDelayMs: null });
      continue;
    }

    if (field === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }

    expectingAgents = false;
    if (currentAgents.length === 0) continue; // directive before any user-agent

    if (field === 'disallow' || field === 'allow') {
      if (ruleCount >= MAX_RULES) continue;
      ruleCount += 1;
      for (const agent of currentAgents) {
        const group = groups.get(agent);
        // "Disallow:" with an empty value means "allow everything".
        if (field === 'disallow' && value === '') continue;
        group.rules.push(compileRule(field === 'allow', value));
      }
      continue;
    }

    if (field === 'crawl-delay' || field === 'crawldelay') {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds >= 0) {
        for (const agent of currentAgents) {
          groups.get(agent).crawlDelayMs = Math.min(seconds * 1000, 60_000);
        }
      }
    }
  }

  // Most specific matching group: exact token, then any group whose name is a
  // prefix of our token, then `*`.
  let chosenAgent = null;
  if (groups.has(token)) {
    chosenAgent = token;
  } else {
    let best = null;
    for (const agent of groups.keys()) {
      if (agent === '*' || agent === '') continue;
      if (token.startsWith(agent) && (best === null || agent.length > best.length)) best = agent;
    }
    chosenAgent = best ?? (groups.has('*') ? '*' : null);
  }

  const group = chosenAgent === null ? { rules: [], crawlDelayMs: null } : groups.get(chosenAgent);
  return {
    rules: group.rules,
    crawlDelayMs: group.crawlDelayMs,
    sitemaps,
    source: 'robots.txt',
    agent: chosenAgent,
  };
}

/** Turn a robots path pattern into a matcher. */
function compileRule(allow, pattern) {
  const rule = { allow, pattern, matcher: null, length: pattern.length };
  if (pattern.includes('*') || pattern.endsWith('$')) {
    let body = pattern;
    let anchored = false;
    if (body.endsWith('$')) {
      body = body.slice(0, -1);
      anchored = true;
    }
    const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    try {
      rule.matcher = new RegExp(`^${escaped}${anchored ? '$' : ''}`);
    } catch {
      rule.matcher = null;
    }
  }
  return rule;
}

/** Longest match wins; Allow wins a tie. */
export function evaluate(rules, path) {
  let best = null;
  for (const rule of rules) {
    const matched = rule.matcher !== null ? rule.matcher.test(path) : path.startsWith(rule.pattern);
    if (!matched) continue;
    if (
      best === null ||
      rule.length > best.length ||
      (rule.length === best.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }

  if (best === null) return { allowed: true, reason: 'no-matching-rule', pattern: null };
  return {
    allowed: best.allow,
    reason: best.allow ? 'allow-rule' : 'disallow-rule',
    pattern: best.pattern,
  };
}

export default RobotsCache;
