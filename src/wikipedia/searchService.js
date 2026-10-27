/** Adapt the supplied Wikipedia search pipeline to the existing WellSearch UI contract. */
import { BM25Index } from './bm25.js';
import { tokenize } from './tokenizer.js';
import { escapeHtml } from '../utils/text.js';
import { HttpError, unavailable } from '../utils/errors.js';

const MAX_ARTICLES_PER_SEARCH = 8;
const round = (value) => Math.round(value * 100) / 100;
const upstreamUnavailable = () => new HttpError(502,
  'Wikipedia is unavailable right now. Please try again.',
  { code: 'WIKIPEDIA_UNAVAILABLE', expose: true });

export class WikipediaSearchService {
  constructor({ config, client, now = () => Date.now() }) {
    this.config = config;
    this.client = client;
    this.now = now;
    this.queryCount = 0;
    this.errorCount = 0;
    this.active = 0;
    this.closed = false;
    this.articleCache = new Map();
    this.queryCache = new Map();
    this.suggestionCache = new Map();
    this.pending = new Map();
    this.pendingArticles = new Map();
  }

  async search(raw, { page = 1, limit = this.config.search.defaultLimit, host, explain = false } = {}) {
    this.queryCount += 1;
    const started = performance.now();
    const warnings = [];
    const query = String(raw).trim().slice(0, this.config.search.maxQueryLength);
    if (String(raw).trim().length > query.length) warnings.push('query was truncated to the configured maximum length');
    const terms = [...new Set(tokenize(query))].slice(0, this.config.search.maxQueryTerms);
    const parsing = performance.now() - started;
    const retrievalStart = performance.now();
    const corpus = terms.length ? await this.#corpus(query) : { articles: [], titles: [], warnings: [] };
    const retrieval = performance.now() - retrievalStart;
    warnings.push(...corpus.warnings);

    // A query gets its own corpus. Articles cached by earlier, unrelated searches
    // must not alter its IDF values, ordering, or result set.
    const scoringStart = performance.now();
    const index = new BM25Index(this.config.bm25);
    for (const article of corpus.articles) index.addDocument(article);
    const ranked = index.searchTerms(terms, MAX_ARTICLES_PER_SEARCH);
    const scoring = performance.now() - scoringStart;
    const filteringStart = performance.now();
    const requestedHost = host?.trim().toLowerCase().replace(/^www\./, '');
    const matches = requestedHost
      ? ranked.filter(({ doc }) => new URL(doc.url).hostname.replace(/^www\./, '') === requestedHost)
      : ranked;
    const filtering = performance.now() - filteringStart;
    const presentationStart = performance.now();
    const offset = (page - 1) * limit;
    const results = matches.slice(offset, offset + limit).map(({ doc, score, snippet, matchedTerms, documentLength }, position) => ({
      id: String(doc.id),
      rank: offset + position + 1,
      url: doc.url,
      displayUrl: decodeURI(doc.url.replace(/^https?:\/\//, '')),
      host: new URL(doc.url).hostname,
      title: doc.title,
      titleHtml: escapeHtml(doc.title),
      description: doc.content.slice(0, 200),
      snippet,
      snippetHtml: escapeHtml(snippet),
      score,
      bm25Score: score,
      proximityBoost: 0,
      matchedTerms,
      documentLength,
      fetchedAt: doc.fetchedAt ?? null,
      depth: null,
      categories: doc.categories ?? [],
      ...(explain ? { explain: explainScore(index, doc.id, terms) } : {}),
    }));
    const presentation = performance.now() - presentationStart;
    const total = performance.now() - started;
    const stats = index.stats();
    return {
      query,
      terms,
      results,
      total: matches.length,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(matches.length / limit)),
      took: round(total),
      timings: { parsing: round(parsing), retrieval: round(retrieval), scoring: round(scoring),
        filtering: round(filtering), sorting: 0, presentation: round(presentation), total: round(total) },
      diagnostics: {
        source: 'wikipedia',
        documentCount: stats.documents,
        averageDocumentLength: stats.documents ? stats.totalTokens / stats.documents : 0,
        candidates: ranked.length,
        postingsScanned: terms.reduce((count, term) => count + (index.index.get(term)?.size ?? 0), 0),
        truncated: false,
        proximityApplied: false,
        unknownTerms: terms.filter((term) => !index.index.has(term)),
        phrases: [], exclusions: [], hosts: requestedHost ? [requestedHost] : [],
        bm25: { ...this.config.bm25 },
        ...(terms.length === 0 ? { reason: 'empty-query' } : corpus.articles.length === 0 ? { reason: 'no-wikipedia-articles' } : {}),
      },
      suggestions: matches.length === 0 && this.config.search.suggestions ? corpus.titles.slice(0, 5) : [],
      warnings,
    };
  }

  async suggest(query, limit = 8) {
    if (query.trim().length < 2) return [];
    return this.#work(`suggest:${query}:${limit}`, () => this.#suggest(query, limit));
  }

  async #suggest(query, limit) {
    const key = `${query.toLowerCase()}:${limit}`;
    const cached = this.#cached(this.suggestionCache, key);
    if (cached) return cached;
    let titles;
    try { titles = await this.client.suggest(query, limit); }
    catch { throw upstreamUnavailable(); }
    if (!Array.isArray(titles) || !titles.every((title) => typeof title === 'string')) throw upstreamUnavailable();
    const safeTitles = [...new Set(titles.map((title) => title.trim()).filter(Boolean))].slice(0, limit);
    this.#remember(this.suggestionCache, key, safeTitles);
    return safeTitles;
  }

  async #corpus(query) {
    const key = query.toLowerCase();
    const cached = this.#cached(this.queryCache, key);
    if (cached) return cached;
    return this.#work(`search:${key}`, async () => {
      const titles = await this.#suggest(query, 10);
      const downloaded = await Promise.allSettled(titles.slice(0, MAX_ARTICLES_PER_SEARCH).map((title) => this.#article(title)));
      const articles = [...new Map(downloaded
        .filter((result) => result.status === 'fulfilled' && result.value)
        .map(({ value }) => [value.url, value])).values()];
      const failed = downloaded.filter((result) => result.status === 'rejected').length;
      if (failed && articles.length === 0) throw upstreamUnavailable();
      const corpus = { articles, titles, warnings: failed ? [`${failed} Wikipedia article(s) could not be downloaded; showing available results.`] : [] };
      // Retry partial results on the next request rather than caching an outage.
      if (!failed) this.#remember(this.queryCache, key, corpus, Math.min(50, this.config.wikipedia.maxCachedArticles));
      return corpus;
    });
  }

  async #article(title) {
    const key = title.replace(/_/g, ' ').trim();
    const cached = this.#cached(this.articleCache, key);
    if (cached) return cached;
    if (this.pendingArticles.has(key)) return this.pendingArticles.get(key);
    const task = Promise.resolve().then(() => this.client.fetchArticle(title)).then((article) => {
      if (article) this.#remember(this.articleCache, key, article);
      return article;
    }).finally(() => this.pendingArticles.delete(key));
    this.pendingArticles.set(key, task);
    return task;
  }

  async #work(key, run) {
    if (this.closed) throw unavailable('search service is shutting down');
    if (this.pending.has(key)) return this.pending.get(key);
    if (this.active >= this.config.wikipedia.maxConcurrentSearches) {
      throw unavailable('Wikipedia search is busy. Please try again shortly.');
    }
    this.active += 1;
    const task = Promise.resolve().then(run).finally(() => {
      this.active -= 1;
      this.pending.delete(key);
    });
    this.pending.set(key, task);
    return task;
  }

  #cached(cache, key) {
    const entry = cache.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) { cache.delete(key); return undefined; }
    cache.delete(key);
    cache.set(key, entry);
    return entry.value;
  }

  #remember(cache, key, value, max = this.config.wikipedia.maxCachedArticles) {
    if (this.closed || this.config.wikipedia.cacheTtlMs === 0) return;
    cache.delete(key);
    cache.set(key, { value, expiresAt: this.now() + this.config.wikipedia.cacheTtlMs });
    while (cache.size > max) cache.delete(cache.keys().next().value);
  }

  recordError() { this.errorCount += 1; }

  stats() {
    return { source: 'wikipedia', queries: this.queryCount, errors: this.errorCount,
      active: this.active, cachedArticles: this.articleCache.size, cachedQueries: this.queryCache.size,
      cacheTtlMs: this.config.wikipedia.cacheTtlMs };
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pending.values()]);
    this.articleCache.clear();
    this.queryCache.clear();
    this.suggestionCache.clear();
  }
}

export default WikipediaSearchService;

function explainScore(index, id, terms) {
  const lengthPenalty = 1 - index.b + index.b * (index.documentLengths.get(id) / (index.avgdl || 1));
  const contributions = terms.filter((term) => index.index.get(term)?.has(id)).map((term) => {
    const postings = index.index.get(term);
    const tf = postings.get(id);
    const idf = Math.log(1 + (index.docCount - postings.size + 0.5) / (postings.size + 0.5));
    return { term, tf, df: postings.size, idf, contribution: idf * tf * (index.k1 + 1) / (tf + index.k1 * lengthPenalty) };
  });
  return { contributions, lengthPenalty, snippetSource: 'wikipedia' };
}
