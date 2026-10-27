/**
 * Adapted from Wikipedia_Search_Engine-main/server/server.js and crawler/crawler.js.
 * Copyright (c) 2025 YOUR_NAME. SPDX-License-Identifier: MIT.
 * The original license is reproduced in THIRD_PARTY_NOTICES.md.
 */

import { load } from 'cheerio';
import { HttpError } from '../utils/errors.js';

export const WIKIPEDIA_ORIGIN = 'https://en.wikipedia.org';
const ARTICLE_PREFIX = `${WIKIPEDIA_ORIGIN}/wiki/`;
const CONTENT_LIMIT = 4000;
const CATEGORY_LIMIT = 20;
const BATCH_LIMIT = 8;
const PARTIAL_WARNING = 'Some Wikipedia articles could not be loaded.';
const REMOVE_SELECTORS = [
  '.infobox', '.navbox', '.reflist', '.references', '.mw-editsection',
  '.hatnote', '.sistersitebox', '.noprint', 'sup.reference', '.toc',
  'script', 'style', 'noscript', 'form', 'button', '.mw-empty-elt',
].join(',');

export class WikipediaClient {
  constructor({ fetcher, config } = {}) {
    if (!fetcher || typeof fetcher.fetch !== 'function') {
      throw new TypeError('WikipediaClient requires a fetcher');
    }
    this.fetcher = fetcher;
    this.timeoutMs = config?.wikipedia?.requestTimeoutMs ?? 3500;
  }

  async searchArticles(query, limit = BATCH_LIMIT) {
    const search = String(query ?? '').trim();
    if (!search) return { articles: [], titles: [], warnings: [] };
    const maxResults = Number.isFinite(limit) ? Math.max(1, Math.min(BATCH_LIMIT, Math.floor(limit))) : BATCH_LIMIT;
    const url = new URL('/w/api.php', WIKIPEDIA_ORIGIN);
    url.search = new URLSearchParams({
      action: 'query', generator: 'prefixsearch', gpssearch: search, gpsnamespace: '0', gpslimit: String(maxResults),
      prop: 'extracts|categories|info', exintro: '1', explaintext: '1', exlimit: String(maxResults),
      clshow: '!hidden', cllimit: '500', inprop: 'url', redirects: '1', format: 'json', formatversion: '2',
    }).toString();
    const response = await this.#fetch(url.href);
    let data;
    try { data = JSON.parse(response.text); } catch (cause) { throw unavailable(cause); }
    if (!isRecord(data) || data.error !== undefined || data.errors !== undefined ||
        (data.warnings !== undefined && !isRecord(data.warnings) && !Array.isArray(data.warnings))) {
      throw unavailable();
    }
    const apiWarning = data.warnings !== undefined && Object.keys(data.warnings).length > 0;
    if (data.query === undefined && data.batchcomplete === true && !apiWarning) {
      return { articles: [], titles: [], warnings: [] };
    }
    if (!isRecord(data.query) || !Array.isArray(data.query.pages)) throw unavailable();

    // Prefixsearch's page index preserves candidate order despite query.pages being in page-ID order.
    const pages = data.query.pages.map((page, position) => ({ page, position }))
      .sort((a, b) => pageOrder(a) - pageOrder(b)).slice(0, maxResults);
    const articles = [];
    const titles = [];
    const seenUrls = new Set();
    const fetchedAt = new Date().toISOString();
    let incomplete = apiWarning || (isRecord(data.continue) && data.continue.clcontinue !== undefined);
    let failed = 0;
    for (const { page } of pages) {
      if (isRecord(page) && (Object.hasOwn(page, 'missing') || Object.hasOwn(page, 'invalid'))) continue;
      if (!isRecord(page) || !Number.isInteger(page.ns) || page.ns < 0 || typeof page.title !== 'string' ||
          !page.title.trim() || page.title.trim().length > 300) {
        failed += 1;
        continue;
      }
      // Recognized namespace prefixes override gpsnamespace upstream. These
      // are valid pages outside our article-only corpus, not an outage.
      if (page.ns !== 0) continue;
      const title = cleanText(page.title);
      if (!titles.includes(title)) titles.push(title);
      const href = page.canonicalurl ?? page.fullurl;
      if (typeof href !== 'string') {
        failed += 1;
        continue;
      }
      const articleUrl = safeArticleUrl(href);
      if (!articleUrl) throw unavailable();
      if (typeof page.extract !== 'string') {
        failed += 1;
        continue;
      }
      const content = cleanText(page.extract).replace(/\[\d+\]/g, '').trim().slice(0, CONTENT_LIMIT);
      if (content.length < 80 || seenUrls.has(articleUrl)) continue;
      const categories = [];
      if (page.categories !== undefined && !Array.isArray(page.categories)) incomplete = true;
      for (const category of Array.isArray(page.categories) ? page.categories : []) {
        if (!isRecord(category) || typeof category.title !== 'string' || !category.title.startsWith('Category:')) {
          incomplete = true;
          continue;
        }
        if (Object.hasOwn(category, 'hidden')) continue;
        const name = cleanText(category.title.slice('Category:'.length));
        if (name && name.length <= 160 && !categories.includes(name) && categories.length < CATEGORY_LIMIT) {
          categories.push(name);
        }
      }
      seenUrls.add(articleUrl);
      articles.push({ id: articleUrl, title, url: articleUrl, content, categories, fetchedAt });
    }
    if (failed && !articles.length) throw unavailable();
    incomplete ||= failed > 0;
    return { articles, titles, warnings: incomplete ? [PARTIAL_WARNING] : [] };
  }

  async suggest(query, limit = 8) {
    const search = String(query ?? '').trim();
    if (!search) return [];
    const maxResults = Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 8;
    const url = new URL('/w/api.php', WIKIPEDIA_ORIGIN);
    url.search = new URLSearchParams({
      action: 'opensearch', search, limit: String(maxResults), format: 'json', redirects: 'resolve',
    }).toString();
    const response = await this.#fetch(url.href);
    let data;
    try { data = JSON.parse(response.text); } catch (cause) { throw unavailable(cause); }
    if (!Array.isArray(data) || typeof data[0] !== 'string' || !Array.isArray(data[1]) ||
        data[1].some((title) => typeof title !== 'string')) {
      throw unavailable();
    }
    return [...new Set(data[1].map((title) => title.trim()).filter((title) => title && title.length <= 300))]
      .slice(0, maxResults);
  }

  async fetchArticle(title) {
    const requestedTitle = String(title ?? '').trim();
    if (!requestedTitle || requestedTitle.length > 300) return null;
    const pageUrl = `${ARTICLE_PREFIX}${encodeURIComponent(requestedTitle.replace(/ /g, '_'))}`;
    const response = await this.#fetch(pageUrl, { missingIsNull: true });
    if (!response) return null;
    const finalUrl = safeArticleUrl(response.finalUrl ?? response.url ?? pageUrl);
    if (!finalUrl) throw unavailable();
    const mime = (response.contentType ?? '').split(';', 1)[0].trim().toLowerCase();
    if (mime && mime !== 'text/html' && mime !== 'application/xhtml+xml') throw unavailable();

    const $ = load(response.text);
    $(REMOVE_SELECTORS).remove();
    const cleanTitle = cleanText($('#firstHeading').first().text() || requestedTitle);
    const paragraphs = [];
    $('#mw-content-text p').each((_, element) => {
      const text = cleanText($(element).text()).replace(/\[\d+\]/g, '').trim();
      if (text.length > 40) paragraphs.push(text);
    });
    const content = paragraphs.join(' ').slice(0, CONTENT_LIMIT);
    if (!cleanTitle || content.length < 80) return null;

    const categories = [];
    $('#mw-normal-catlinks li a').each((_, element) => {
      const category = cleanText($(element).text());
      if (category && category.length <= 160 && !categories.includes(category) && categories.length < CATEGORY_LIMIT) {
        categories.push(category);
      }
    });

    const canonicalHref = $('link[rel="canonical"]').first().attr('href');
    const url = canonicalHref ? safeArticleUrl(canonicalHref, finalUrl) : finalUrl;
    if (!url) throw unavailable();
    return { id: url, title: cleanTitle, url, content, categories, fetchedAt: new Date().toISOString() };
  }

  async #fetch(url, { missingIsNull = false } = {}) {
    let response;
    try {
      response = await this.fetcher.fetch(url, {
        acceptAnyType: true,
        timeoutMs: this.timeoutMs,
        allowedOrigin: WIKIPEDIA_ORIGIN,
      });
    } catch (cause) { throw unavailable(cause); }
    if (missingIsNull && response?.status === 404) return null;
    if (!response?.ok || response.truncated || typeof response.text !== 'string') throw unavailable();
    const finalUrl = response.finalUrl ?? response.url ?? url;
    try {
      if (new URL(finalUrl).origin !== WIKIPEDIA_ORIGIN) throw new Error('unexpected origin');
    } catch (cause) { throw unavailable(cause); }
    return response;
  }
}

function cleanText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pageOrder({ page, position }) {
  return Number.isFinite(page?.index) && page.index >= 0 ? page.index : position;
}

function safeArticleUrl(value, base = WIKIPEDIA_ORIGIN) {
  try {
    const url = new URL(value, base);
    if (url.origin !== WIKIPEDIA_ORIGIN || url.username || url.password ||
        !url.pathname.startsWith('/wiki/') || url.pathname.length <= '/wiki/'.length) return null;
    const title = decodeURIComponent(url.pathname.slice('/wiki/'.length)).replace(/ /g, '_');
    return `${ARTICLE_PREFIX}${encodeURIComponent(title)}`;
  } catch { return null; }
}

function unavailable(cause) {
  return new HttpError(502, 'Wikipedia is temporarily unavailable. Please try again.', {
    code: 'WIKIPEDIA_UNAVAILABLE', expose: true, cause,
  });
}

export default WikipediaClient;
