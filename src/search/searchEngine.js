/**
 * The search engine: query -> ranked, paginated, highlighted results.
 *
 * Pipeline (each stage is timed, and `took` is the sum of the real timings):
 *
 *   1. parse      quoted phrases, -exclusions, site:/host: filters, then the
 *                 *same* analyzer the indexer used (tokenise -> normalise ->
 *                 stop words -> stem)
 *   2. retrieve   fetch one posting list per query term, compute df and IDF,
 *                 order terms by ascending df so the rarest work happens first
 *   3. score      accumulate BM25 over the posting lists only. The corpus is
 *                 never scanned: cost is O(SUM df(q)), not O(N)
 *   4. filter     host filters, exclusions, required phrases (positional)
 *   5. sort       score descending, document id ascending as a deterministic
 *                 tie-break
 *   6. present    slice the page, build snippets, highlight terms
 *
 * Nothing here is faked: scores come from `BM25`, snippets come from stored
 * document text, and every number in `timings` is measured with
 * `performance.now()`.
 */

import { performance } from 'node:perf_hooks';
import { config as defaultConfig } from '../config/config.js';
import { logger as defaultLogger } from '../utils/logger.js';
import { analyzer as defaultAnalyzer } from './tokenizer.js';
import { BM25 } from './bm25.js';
import { buildSnippet, highlight } from './snippets.js';
import { displayUrl } from '../utils/url.js';
import { normalizeWhitespace } from '../utils/text.js';

const PHRASE_RE = /"([^"]*)"/g;
const FILTER_RE = /(?:^|\s)(site|host)\s*:\s*([^\s"]+)/gi;
const EXCLUDE_RE = /(?:^|\s)-([^\s"]+)/g;

/**
 * Hard ceiling on posting entries visited by one query. Reached only by a query
 * whose terms are almost as common as the corpus itself; when it trips the
 * response reports `truncated: true` rather than silently returning less.
 */
const MAX_POSTINGS_SCANNED = 750_000;

/** Proximity re-scoring is skipped above this many candidates (see below). */
const MAX_PROXIMITY_CANDIDATES = 5_000;

/** Number of recent latencies kept for percentile reporting. */
const LATENCY_WINDOW = 1_000;

export class SearchEngine {
  constructor({
    indexManager,
    config = defaultConfig,
    logger = defaultLogger,
    analyzer = defaultAnalyzer,
    bm25,
  } = {}) {
    if (!indexManager) throw new TypeError('SearchEngine requires an indexManager');
    this.indexManager = indexManager;
    this.config = config;
    this.logger = logger.child({ module: 'search' });
    this.analyzer = analyzer;
    this.bm25 = bm25 ?? new BM25({ k1: config.bm25.k1, b: config.bm25.b });

    this.queryCount = 0;
    this.errorCount = 0;
    this.zeroResultCount = 0;
    this.totalMs = 0;
    this.latencies = [];
    this.lastQuery = null;
  }

  get index() {
    return this.indexManager.index;
  }

  get store() {
    return this.indexManager.store;
  }

  /* ----------------------------------------------------------------------- */
  /* Query parsing                                                            */
  /* ----------------------------------------------------------------------- */

  /**
   * Parse a raw query string into an execution plan.
   *
   * Supported syntax:
   *   web crawler        two optional terms
   *   "web crawler"      phrase, required in this exact order
   *   -python            exclude documents containing the term
   *   site:example.com   restrict to a host (host: is a synonym)
   *
   * @param {string} raw
   */
  parseQuery(raw) {
    const original = typeof raw === 'string' ? raw : '';
    const warnings = [];
    let working = normalizeWhitespace(original);

    if (working.length > this.config.search.maxQueryLength) {
      working = working.slice(0, this.config.search.maxQueryLength);
      warnings.push(`query truncated to ${this.config.search.maxQueryLength} characters`);
    }

    const hosts = [];
    working = working.replace(FILTER_RE, (_match, _kind, value) => {
      const host = value.toLowerCase().replace(/^www\./, '').replace(/[/,]+$/, '');
      if (host) hosts.push(host);
      return ' ';
    });

    const phrases = [];
    working = working.replace(PHRASE_RE, (_match, inner) => {
      const analysis = this.analyzer.analyze(inner);
      if (analysis.terms.length > 0) {
        phrases.push({
          text: normalizeWhitespace(inner),
          terms: analysis.terms.map((entry) => entry.term),
          offsets: analysis.terms.map((entry) => entry.position),
        });
      }
      return ' ';
    });

    const exclusions = [];
    working = working.replace(EXCLUDE_RE, (_match, word) => {
      const term = this.analyzer.term(word);
      if (term && !exclusions.includes(term)) exclusions.push(term);
      return ' ';
    });

    // Free terms, plus the terms inside each phrase (a phrase must also be
    // *scored*, not only used as a filter).
    const analysis = this.analyzer.analyze(working);
    let onlyStopWords = false;
    if (analysis.terms.length === 0 && phrases.length === 0 && working.trim() !== '') {
      // "the and of": every word was a stop word. Stop words are not in the
      // index, so there is nothing to match - say so instead of pretending.
      onlyStopWords = true;
      warnings.push('query contained only stop words, which are not indexed');
    }

    const termCounts = new Map();
    const addTerm = (term) => {
      if (!term) return;
      if (!termCounts.has(term) && termCounts.size >= this.config.search.maxQueryTerms) return;
      termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
    };
    for (const entry of analysis.terms) addTerm(entry.term);
    for (const phrase of phrases) for (const term of phrase.terms) addTerm(term);

    const requiredTerms = [];
    const requiredPhrases = [];
    for (const phrase of phrases) {
      if (phrase.terms.length === 1) requiredTerms.push(phrase.terms[0]);
      else requiredPhrases.push(phrase);
    }

    if (analysis.truncated) warnings.push('query had too many tokens and was truncated');

    return {
      raw: original,
      cleaned: normalizeWhitespace(working),
      termCounts,
      terms: [...termCounts.keys()],
      phrases,
      requiredPhrases,
      requiredTerms,
      exclusions,
      hosts,
      onlyStopWords,
      warnings,
      isEmpty: termCounts.size === 0,
    };
  }

  /* ----------------------------------------------------------------------- */
  /* Search                                                                   */
  /* ----------------------------------------------------------------------- */

  /**
   * Execute a search.
   *
   * @param {string} rawQuery
   * @param {object} [options]
   * @param {number} [options.page] 1-based
   * @param {number} [options.limit]
   * @param {string} [options.host] additional host filter (from the API)
   * @param {boolean} [options.explain] include per-term BM25 contributions
   * @returns {object} search response (see README for the shape)
   */
  search(rawQuery, options = {}) {
    const startedAt = performance.now();

    const limit = clampInt(options.limit, 1, this.config.search.maxLimit, this.config.search.defaultLimit);
    const page = clampInt(options.page, 1, 10_000, 1);
    const explain = Boolean(options.explain);
    const offset = (page - 1) * limit;

    /* 1. parse ------------------------------------------------------------ */
    const parsed = this.parseQuery(rawQuery);
    if (options.host) {
      const host = String(options.host).toLowerCase().replace(/^www\./, '');
      if (host && !parsed.hosts.includes(host)) parsed.hosts.push(host);
    }
    const parsingMs = performance.now() - startedAt;

    const documentCount = this.index.documentCount;
    const averageDocumentLength = this.index.averageDocumentLength;

    if (parsed.isEmpty || documentCount === 0) {
      const response = this.#emptyResponse({
        parsed, page, limit, documentCount, averageDocumentLength, parsingMs, startedAt,
        reason: parsed.isEmpty ? 'empty-query' : 'empty-index',
      });
      this.#record(parsed, response);
      return response;
    }

    /* 2. retrieve --------------------------------------------------------- */
    const retrievalStart = performance.now();
    const plans = [];
    const unknownTerms = [];
    for (const [term, queryFrequency] of parsed.termCounts) {
      const postings = this.index.getPostingList(term);
      const df = postings === undefined ? 0 : postings.size;
      if (df === 0) {
        unknownTerms.push(term);
        continue;
      }
      plans.push({ term, queryFrequency, df, idf: this.bm25.idf(documentCount, df), postings });
    }
    // Rarest term first: the accumulator stays small and stays cache friendly.
    plans.sort((a, b) => a.df - b.df || (a.term < b.term ? -1 : 1));

    const excludedDocuments = new Set();
    for (const term of parsed.exclusions) {
      const postings = this.index.getPostingList(term);
      if (postings) for (const docId of postings.keys()) excludedDocuments.add(docId);
    }
    const retrievalMs = performance.now() - retrievalStart;

    /* 3. score ------------------------------------------------------------ */
    const scoringStart = performance.now();
    const candidates = new Map();
    const penalties = new Map();
    let postingsScanned = 0;
    let truncated = false;

    for (const plan of plans) {
      if (postingsScanned >= MAX_POSTINGS_SCANNED) {
        truncated = true;
        break;
      }
      const { idf, queryFrequency } = plan;
      for (const [docId, posting] of plan.postings) {
        postingsScanned += 1;
        if (excludedDocuments.has(docId)) continue;

        let penalty = penalties.get(docId);
        if (penalty === undefined) {
          penalty = this.bm25.lengthPenalty(this.index.getDocumentLength(docId), averageDocumentLength);
          penalties.set(docId, penalty);
        }

        const contribution = queryFrequency * this.bm25.score(posting.tf, idf, penalty);

        let candidate = candidates.get(docId);
        if (candidate === undefined) {
          candidate = { id: docId, score: 0, matched: 0, contributions: explain ? [] : null };
          candidates.set(docId, candidate);
        }
        candidate.score += contribution;
        candidate.matched += 1;
        if (explain) {
          candidate.contributions.push({
            term: plan.term,
            tf: posting.tf,
            df: plan.df,
            idf: round(idf, 4),
            contribution: round(contribution, 4),
          });
        }
      }
    }
    const scoringMs = performance.now() - scoringStart;

    /* 4. filter ----------------------------------------------------------- */
    const filteringStart = performance.now();
    const hostFilter = parsed.hosts.length > 0 ? new Set(parsed.hosts) : null;
    const applyProximity =
      parsed.requiredPhrases.length === 0 &&
      plans.length > 1 &&
      this.index.storePositions &&
      this.config.search.phraseBoost > 1 &&
      candidates.size <= MAX_PROXIMITY_CANDIDATES;

    const matches = [];
    for (const candidate of candidates.values()) {
      const document = this.store.get(candidate.id);
      if (document === undefined) continue; // torn snapshot; skip rather than crash

      if (hostFilter !== null) {
        const host = (document.host ?? '').replace(/^www\./, '');
        if (!hostFilter.has(host)) continue;
      }

      let ok = true;
      for (const term of parsed.requiredTerms) {
        if (this.index.getTermFrequency(term, candidate.id) === 0) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      for (const phrase of parsed.requiredPhrases) {
        if (!this.#matchesPhrase(candidate.id, phrase)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      candidate.proximity = applyProximity ? this.#proximityFactor(candidate.id, plans) : 1;
      candidate.finalScore = candidate.score * candidate.proximity;
      candidate.document = document;
      matches.push(candidate);
    }
    const filteringMs = performance.now() - filteringStart;

    /* 5. sort ------------------------------------------------------------- */
    const sortingStart = performance.now();
    matches.sort((a, b) => (b.finalScore - a.finalScore) || compareIds(a.id, b.id));
    const sortingMs = performance.now() - sortingStart;

    /* 6. present ---------------------------------------------------------- */
    const presentationStart = performance.now();
    const termSet = new Set(parsed.terms);
    const pageMatches = matches.slice(offset, offset + limit);
    const results = pageMatches.map((candidate, position) =>
      this.#toResult(candidate, termSet, offset + position + 1, explain));

    let suggestions = [];
    if (matches.length === 0 && this.config.search.suggestions) {
      suggestions = this.suggest(unknownTerms.length > 0 ? unknownTerms : parsed.terms);
    }
    const presentationMs = performance.now() - presentationStart;

    const totalMs = performance.now() - startedAt;
    const response = {
      query: parsed.raw,
      terms: parsed.terms,
      results,
      total: matches.length,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(matches.length / limit)),
      took: round(totalMs, 2),
      timings: {
        parsing: round(parsingMs, 3),
        retrieval: round(retrievalMs, 3),
        scoring: round(scoringMs, 3),
        filtering: round(filteringMs, 3),
        sorting: round(sortingMs, 3),
        presentation: round(presentationMs, 3),
        total: round(totalMs, 3),
      },
      diagnostics: {
        documentCount,
        averageDocumentLength: round(averageDocumentLength, 2),
        candidates: candidates.size,
        postingsScanned,
        truncated,
        proximityApplied: applyProximity,
        unknownTerms,
        phrases: parsed.phrases.map((phrase) => phrase.text),
        exclusions: parsed.exclusions,
        hosts: parsed.hosts,
        bm25: { k1: this.bm25.k1, b: this.bm25.b },
      },
      suggestions,
      warnings: parsed.warnings,
    };

    this.#record(parsed, response);
    return response;
  }

  #emptyResponse({ parsed, page, limit, documentCount, averageDocumentLength, parsingMs, startedAt, reason }) {
    const totalMs = performance.now() - startedAt;
    return {
      query: parsed.raw,
      terms: parsed.terms,
      results: [],
      total: 0,
      page,
      limit,
      totalPages: 1,
      took: round(totalMs, 2),
      timings: {
        parsing: round(parsingMs, 3),
        retrieval: 0,
        scoring: 0,
        filtering: 0,
        sorting: 0,
        presentation: 0,
        total: round(totalMs, 3),
      },
      diagnostics: {
        documentCount,
        averageDocumentLength: round(averageDocumentLength, 2),
        candidates: 0,
        postingsScanned: 0,
        truncated: false,
        proximityApplied: false,
        unknownTerms: parsed.terms,
        phrases: parsed.phrases.map((phrase) => phrase.text),
        exclusions: parsed.exclusions,
        hosts: parsed.hosts,
        bm25: { k1: this.bm25.k1, b: this.bm25.b },
        reason,
      },
      suggestions: [],
      warnings: reason === 'empty-index'
        ? [...parsed.warnings, 'the index is empty - run a crawl first']
        : parsed.warnings,
    };
  }

  #toResult(candidate, termSet, rank, explain) {
    const document = candidate.document;
    const snippet = buildSnippet({
      text: document.text ?? '',
      description: document.description ?? '',
      termSet,
      analyzer: this.analyzer,
      maxLength: this.config.search.snippetLength,
    });

    const result = {
      id: document.id,
      rank,
      url: document.url,
      displayUrl: displayUrl(document.url),
      host: document.host ?? '',
      title: document.title || displayUrl(document.url),
      titleHtml: highlight(document.title || displayUrl(document.url), this.analyzer, termSet),
      description: document.description ?? '',
      snippet: snippet.text,
      snippetHtml: snippet.html,
      score: round(candidate.finalScore, 4),
      bm25Score: round(candidate.score, 4),
      proximityBoost: round(candidate.proximity ?? 1, 3),
      matchedTerms: candidate.matched,
      documentLength: this.index.getDocumentLength(document.id),
      fetchedAt: document.fetchedAt ?? null,
      depth: document.depth ?? null,
    };

    if (explain) {
      result.explain = {
        contributions: candidate.contributions,
        lengthPenalty: round(
          this.bm25.lengthPenalty(this.index.getDocumentLength(document.id), this.index.averageDocumentLength),
          4,
        ),
        snippetSource: snippet.source,
      };
    }

    return result;
  }

  /**
   * Positional phrase check.
   *
   * Known limitation: only the first MAX_POSITIONS_PER_TERM occurrences of a
   * term are stored, so a phrase that appears exclusively beyond that point in
   * a very long document can be missed. When positions are disabled entirely
   * the check degrades to "all phrase terms present".
   */
  #matchesPhrase(docId, phrase) {
    if (!this.index.storePositions) {
      return phrase.terms.every((term) => this.index.getTermFrequency(term, docId) > 0);
    }

    const lists = [];
    for (const term of phrase.terms) {
      const positions = this.index.getPositions(term, docId);
      if (!positions || positions.length === 0) return false;
      lists.push(positions);
    }

    const base = phrase.offsets[0];
    const deltas = phrase.offsets.slice(1).map((offset) => offset - base);
    const sets = lists.slice(1).map((positions) => new Set(positions));

    for (const start of lists[0]) {
      let ok = true;
      for (let i = 0; i < sets.length; i += 1) {
        if (!sets[i].has(start + deltas[i])) {
          ok = false;
          break;
        }
      }
      if (ok) return true;
    }
    return false;
  }

  /**
   * Proximity boost for unquoted multi-term queries: documents where the terms
   * appear close together outrank documents where they merely co-occur.
   *
   * factor = 1 + (PHRASE_BOOST - 1) * tightness^2, tightness = ideal/span.
   * A perfectly adjacent match gets the full boost; a span twice as wide gets a
   * quarter of it. Applied to every candidate (so ranking stays consistent
   * across pages) and skipped above MAX_PROXIMITY_CANDIDATES.
   */
  #proximityFactor(docId, plans) {
    const lists = [];
    for (const plan of plans) {
      const positions = plan.postings.get(docId)?.positions;
      if (!positions || positions.length === 0) return 1; // not all terms present
      lists.push(positions);
    }
    if (lists.length < 2) return 1;

    const span = minimumSpan(lists);
    if (span === null) return 1;

    const ideal = lists.length - 1;
    const tightness = span <= ideal ? 1 : ideal / span;
    return 1 + (this.config.search.phraseBoost - 1) * tightness * tightness;
  }

  /**
   * Dictionary suggestions for terms that matched nothing. Ranked by document
   * frequency, so the suggestion is a word that actually appears in the corpus.
   */
  suggest(terms, limit = 5) {
    const wanted = Array.isArray(terms) ? terms : [terms];
    const seen = new Set();
    const suggestions = [];

    for (const term of wanted) {
      if (typeof term !== 'string' || term.length < 3) continue;
      const prefix = term.slice(0, Math.min(4, Math.max(3, term.length - 2)));
      const matches = [];
      let examined = 0;
      for (const candidate of this.index.terms()) {
        examined += 1;
        if (examined > 200_000) break;
        if (candidate === term || !candidate.startsWith(prefix)) continue;
        matches.push({ term: candidate, df: this.index.getDocumentFrequency(candidate) });
      }
      matches.sort((a, b) => b.df - a.df || (a.term < b.term ? -1 : 1));
      for (const match of matches.slice(0, limit)) {
        if (seen.has(match.term)) continue;
        seen.add(match.term);
        suggestions.push(match.term);
      }
    }

    return suggestions.slice(0, limit);
  }

  /* ----------------------------------------------------------------------- */
  /* Telemetry                                                                */
  /* ----------------------------------------------------------------------- */

  #record(parsed, response) {
    this.queryCount += 1;
    this.totalMs += response.timings.total;
    if (response.total === 0) this.zeroResultCount += 1;

    this.latencies.push(response.timings.total);
    if (this.latencies.length > LATENCY_WINDOW) this.latencies.shift();

    this.lastQuery = {
      query: parsed.raw,
      terms: parsed.terms,
      results: response.total,
      tookMs: response.took,
      at: new Date().toISOString(),
      candidates: response.diagnostics.candidates,
      postingsScanned: response.diagnostics.postingsScanned,
    };

    this.logger.debug('search', {
      q: parsed.raw,
      results: response.total,
      ms: response.took,
      candidates: response.diagnostics.candidates,
    });
  }

  recordError(error) {
    this.errorCount += 1;
    this.logger.error('search failed', { error });
  }

  /** Real measured latency percentiles over the last LATENCY_WINDOW queries. */
  stats() {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      queries: this.queryCount,
      errors: this.errorCount,
      zeroResultQueries: this.zeroResultCount,
      averageMs: this.queryCount === 0 ? null : round(this.totalMs / this.queryCount, 3),
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      p99Ms: percentile(sorted, 99),
      maxMs: sorted.length === 0 ? null : round(sorted[sorted.length - 1], 3),
      sampleSize: sorted.length,
      lastQuery: this.lastQuery,
      bm25: { k1: this.bm25.k1, b: this.bm25.b },
    };
  }

  resetStats() {
    this.queryCount = 0;
    this.errorCount = 0;
    this.zeroResultCount = 0;
    this.totalMs = 0;
    this.latencies = [];
    this.lastQuery = null;
  }
}

/* ------------------------------------------------------------------------- */
/* helpers                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Smallest window containing one position from every list.
 * Classic k-way pointer sweep: advance the list holding the minimum head.
 * O(total positions).
 */
export function minimumSpan(lists) {
  if (lists.length === 0) return null;
  if (lists.length === 1) return 0;

  const pointers = new Array(lists.length).fill(0);
  let best = Infinity;

  for (;;) {
    let min = Infinity;
    let max = -Infinity;
    let minList = -1;

    for (let i = 0; i < lists.length; i += 1) {
      const value = lists[i][pointers[i]];
      if (value < min) {
        min = value;
        minList = i;
      }
      if (value > max) max = value;
    }

    const span = max - min;
    if (span < best) best = span;
    if (best === 0) return 0;

    pointers[minList] += 1;
    if (pointers[minList] >= lists[minList].length) break;
  }

  return Number.isFinite(best) ? best : null;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return round(sorted[Math.min(Math.max(rank, 0), sorted.length - 1)], 3);
}

function clampInt(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

/** doc_2 before doc_10: numeric where possible, lexicographic otherwise. */
function compareIds(a, b) {
  const na = Number.parseInt(a.slice(4), 10);
  const nb = Number.parseInt(b.slice(4), 10);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export default SearchEngine;
