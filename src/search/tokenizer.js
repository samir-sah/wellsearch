/**
 * Tokenisation / analysis.
 *
 * One `Analyzer` instance is shared by the indexer and the query parser, which
 * is the single most important invariant in the whole engine: if a document is
 * analysed differently from a query, the posting lists simply never match.
 *
 *   "Distributed Systems are AMAZING!"
 *      -> raw tokens   ["Distributed", "Systems", "are", "AMAZING"]
 *      -> normalised   ["distributed", "systems", "are", "amazing"]
 *      -> stop words   ["distributed", "systems", "amazing"]
 *      -> stemmed      ["distribut",   "system",  "amaz"]
 *
 * Positions are assigned from the *raw* token stream (before stop-word
 * removal), so phrase queries keep working across removed words: the document
 * "the quick brown fox" stores quick@1 brown@2 fox@3, and the query
 * "the quick brown" looks for the same relative offsets.
 */

import { foldDiacritics } from '../utils/text.js';
import { createStopWordSet } from './stopwords.js';
import { Stemmer } from './stemmer.js';
import { config } from '../config/config.js';

/**
 * A token is a run of letters/digits, optionally followed by apostrophe
 * groups so that "don't" stays one token (it becomes "dont" after
 * normalisation rather than splitting into "don" + "t").
 */
const TOKEN_RE = /[\p{L}\p{N}]+(?:['’ʼ][\p{L}]+)*/gu;
const APOSTROPHE_RE = /['’ʼ`]/g;
const NON_ASCII_RE = /[^\u0000-\u007f]/;

export class Analyzer {
  /**
   * @param {object} [options]
   * @param {Set<string>} [options.stopWords]
   * @param {boolean} [options.stemming]
   * @param {Stemmer} [options.stemmer]
   * @param {number} [options.minTokenLength]
   * @param {number} [options.maxTokenLength]
   * @param {number} [options.maxTokens] safety valve for pathological input
   */
  constructor({
    stopWords,
    stemming = true,
    stemmer,
    minTokenLength = 1,
    maxTokenLength = 48,
    maxTokens = 250_000,
  } = {}) {
    this.stopWords = stopWords ?? createStopWordSet();
    this.stemming = stemming;
    this.stemmer = stemmer ?? new Stemmer();
    this.minTokenLength = minTokenLength;
    this.maxTokenLength = maxTokenLength;
    this.maxTokens = maxTokens;
  }

  /** Lower-case, fold accents, drop apostrophes. Never throws. */
  normalizeToken(raw) {
    if (typeof raw !== 'string' || raw === '') return '';
    let token = raw.toLowerCase();
    if (token.includes("'") || token.includes('’') || token.includes('ʼ')) {
      token = token.replace(APOSTROPHE_RE, '');
    }
    if (NON_ASCII_RE.test(token)) token = foldDiacritics(token);
    return token;
  }

  isStopWord(normalizedToken) {
    return this.stopWords.has(normalizedToken);
  }

  /** Normalised + stemmed form of a single word, ignoring the stop-word list. */
  term(raw) {
    const normalized = this.normalizeToken(raw);
    if (!normalized) return '';
    return this.stemming ? this.stemmer.stem(normalized) : normalized;
  }

  /**
   * Full analysis of a text.
   *
   * @param {string} text
   * @param {{ offsets?: boolean, keepStopWords?: boolean }} [options]
   * @returns {{ terms: Array<{term: string, position: number, start?: number, end?: number}>,
   *            tokenCount: number, truncated: boolean }}
   *   `tokenCount` counts raw tokens (including stop words); `terms.length` is
   *   the indexed length |D| used by BM25.
   */
  analyze(text, { offsets = false, keepStopWords = false } = {}) {
    const terms = [];
    if (typeof text !== 'string' || text === '') {
      return { terms, tokenCount: 0, truncated: false };
    }

    const stemming = this.stemming;
    const stemmer = this.stemmer;
    const stopWords = keepStopWords ? null : this.stopWords;
    const { minTokenLength, maxTokenLength, maxTokens } = this;

    let position = 0;
    let truncated = false;

    TOKEN_RE.lastIndex = 0;
    let match;
    while ((match = TOKEN_RE.exec(text)) !== null) {
      if (position >= maxTokens) {
        truncated = true;
        break;
      }
      const raw = match[0];
      const currentPosition = position;
      position += 1;

      const normalized = this.normalizeToken(raw);
      if (
        normalized.length < minTokenLength ||
        normalized.length > maxTokenLength ||
        (stopWords !== null && stopWords.has(normalized))
      ) {
        continue;
      }

      const term = stemming ? stemmer.stem(normalized) : normalized;
      if (!term) continue;

      if (offsets) {
        terms.push({ term, position: currentPosition, start: match.index, end: match.index + raw.length });
      } else {
        terms.push({ term, position: currentPosition });
      }
    }

    TOKEN_RE.lastIndex = 0;
    return { terms, tokenCount: position, truncated };
  }

  /** Convenience: just the analysed terms, in order. */
  tokenize(text) {
    return this.analyze(text).terms.map((entry) => entry.term);
  }

  /** Raw tokens before normalisation - used by tests and diagnostics. */
  rawTokens(text) {
    if (typeof text !== 'string') return [];
    TOKEN_RE.lastIndex = 0;
    const out = text.match(TOKEN_RE) ?? [];
    TOKEN_RE.lastIndex = 0;
    return out;
  }

  /**
   * Aggregate an analysis into a posting-ready term map.
   *
   * @param {Array<{term:string, position:number}>} analyzedTerms
   * @param {object} [options]
   * @param {number} [options.weight] field weight (a title hit can count 3x)
   * @param {Map<string,{tf:number, positions:number[]}>} [options.into] accumulator
   * @param {number} [options.maxPositions]
   * @param {boolean} [options.storePositions]
   * @param {number} [options.positionOffset] shifts positions so that separate
   *        fields occupy disjoint ranges and a phrase cannot straddle them
   * @returns {Map<string,{tf:number, positions:number[]}>}
   */
  static toTermMap(analyzedTerms, {
    weight = 1, into, maxPositions = 64, storePositions = true, positionOffset = 0,
  } = {}) {
    const map = into ?? new Map();
    for (const { term, position } of analyzedTerms) {
      let entry = map.get(term);
      if (entry === undefined) {
        entry = { tf: 0, positions: storePositions ? [] : null };
        map.set(term, entry);
      }
      entry.tf += weight;
      if (storePositions && entry.positions.length < maxPositions) {
        entry.positions.push(position + positionOffset);
      }
    }
    return map;
  }
}

/** Build an analyzer from the application configuration. */
export function createAnalyzer(overrides = {}) {
  return new Analyzer({
    stopWords: createStopWordSet({
      enabled: config.search.stopWords,
      extra: config.search.extraStopWords,
    }),
    stemming: config.search.stemming,
    minTokenLength: config.search.minTokenLength,
    maxTokenLength: config.search.maxTokenLength,
    ...overrides,
  });
}

/** Process-wide analyzer. Indexing and searching must share this instance. */
export const analyzer = createAnalyzer();

/** Shorthand used in tests and docs. */
export function tokenize(text, options) {
  return options ? new Analyzer(options).tokenize(text) : analyzer.tokenize(text);
}

export default analyzer;
