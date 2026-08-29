/**
 * Snippet extraction and query-term highlighting.
 *
 * Snippets are built from the document text that was actually stored at index
 * time - they are never fabricated, and never taken from the query. The window
 * is chosen to cover as many *distinct* query terms as possible, which is what
 * makes a snippet look like an answer rather than like the first paragraph.
 *
 * Highlighting always escapes first and inserts <mark> second, so a page whose
 * text contains "<script>" cannot inject anything into the results page.
 */

import { escapeHtml } from '../utils/text.js';

const ELLIPSIS = '…';
const MAX_HITS = 400;
const WORD_BOUNDARY = /[\s\-]/;

/**
 * Locate query-term occurrences in a text.
 *
 * Analysis keeps stop words so the character offsets stay valid even if the
 * stop-word list is disabled at runtime; only terms present in `termSet` are
 * returned as hits.
 *
 * @param {string} text
 * @param {import('./tokenizer.js').Analyzer} analyzer
 * @param {Set<string>} termSet analysed (stemmed) query terms
 * @returns {Array<{start:number, end:number, term:string, position:number}>}
 */
export function findHits(text, analyzer, termSet) {
  if (typeof text !== 'string' || text === '' || !termSet || termSet.size === 0) return [];

  const { terms } = analyzer.analyze(text, { offsets: true, keepStopWords: true });
  const hits = [];
  for (const entry of terms) {
    if (!termSet.has(entry.term)) continue;
    hits.push(entry);
    if (hits.length >= MAX_HITS) break;
  }
  return hits;
}

/**
 * Choose the character window that covers the most distinct query terms.
 * Ties break toward the earlier window, so snippets are deterministic.
 */
function chooseWindow(hits, maxLength) {
  let best = null;

  for (let i = 0; i < hits.length; i += 1) {
    const limit = hits[i].start + maxLength;
    const distinct = new Set();
    let count = 0;
    let lastEnd = hits[i].end;

    for (let j = i; j < hits.length && hits[j].end <= limit; j += 1) {
      distinct.add(hits[j].term);
      count += 1;
      lastEnd = hits[j].end;
    }

    const candidate = { first: i, distinct: distinct.size, count, start: hits[i].start, end: lastEnd };
    if (
      best === null ||
      candidate.distinct > best.distinct ||
      (candidate.distinct === best.distinct && candidate.count > best.count)
    ) {
      best = candidate;
    }
  }

  return best;
}

/** Walk left/right to the nearest whitespace so words are not cut in half. */
function expandToWordBoundary(text, start, end) {
  let from = start;
  let to = end;

  let guard = 0;
  while (from > 0 && !WORD_BOUNDARY.test(text[from - 1]) && guard < 40) {
    from -= 1;
    guard += 1;
  }
  guard = 0;
  while (to < text.length && !WORD_BOUNDARY.test(text[to]) && guard < 40) {
    to += 1;
    guard += 1;
  }

  return [from, to];
}

/**
 * Escape `text[from, to)` and wrap the supplied hits in <mark>.
 * @returns {string} HTML-safe fragment
 */
function markRange(text, from, to, hits) {
  let html = '';
  let cursor = from;

  for (const hit of hits) {
    if (hit.start < cursor || hit.end > to) continue;
    html += escapeHtml(text.slice(cursor, hit.start));
    html += `<mark>${escapeHtml(text.slice(hit.start, hit.end))}</mark>`;
    cursor = hit.end;
  }

  html += escapeHtml(text.slice(cursor, to));
  return html;
}

/**
 * Build a snippet for one result.
 *
 * @param {object} options
 * @param {string} options.text stored document text
 * @param {string} [options.description] meta description, used as a fallback
 * @param {Set<string>} options.termSet analysed query terms
 * @param {import('./tokenizer.js').Analyzer} options.analyzer
 * @param {number} [options.maxLength]
 * @returns {{text: string, html: string, matches: number, distinctTerms: number, source: string}}
 */
export function buildSnippet({ text = '', description = '', termSet, analyzer, maxLength = 280 }) {
  const hits = findHits(text, analyzer, termSet);

  if (hits.length === 0) {
    // No term occurs in the body: prefer the author's own summary.
    const fallbackSource = description && description.length > 0 ? description : text;
    const descriptionHits = description ? findHits(description, analyzer, termSet) : [];
    const [from, to] = clampFallback(fallbackSource, maxLength);
    return {
      text: sliceWithEllipsis(fallbackSource, from, to),
      html: decorate(fallbackSource, from, to, description && descriptionHits.length ? descriptionHits : []),
      matches: descriptionHits.length,
      distinctTerms: new Set(descriptionHits.map((hit) => hit.term)).size,
      source: description && description.length > 0 ? 'description' : 'text',
    };
  }

  const window = chooseWindow(hits, maxLength);
  const padding = Math.max(0, Math.floor((maxLength - (window.end - window.start)) / 2));
  let from = Math.max(0, window.start - padding);
  let to = Math.min(text.length, Math.max(window.end, from + maxLength));
  [from, to] = expandToWordBoundary(text, from, to);

  const inWindow = hits.filter((hit) => hit.start >= from && hit.end <= to);

  return {
    text: sliceWithEllipsis(text, from, to),
    html: decorate(text, from, to, inWindow),
    matches: inWindow.length,
    distinctTerms: new Set(inWindow.map((hit) => hit.term)).size,
    source: 'text',
  };
}

function clampFallback(text, maxLength) {
  if (text.length <= maxLength) return [0, text.length];
  const [from, to] = expandToWordBoundary(text, 0, maxLength);
  return [from, to];
}

function sliceWithEllipsis(text, from, to) {
  let out = text.slice(from, to).trim();
  if (from > 0) out = `${ELLIPSIS}${out}`;
  if (to < text.length) out = `${out}${ELLIPSIS}`;
  return out;
}

function decorate(text, from, to, hits) {
  let html = markRange(text, from, to, hits).trim();
  if (from > 0) html = `${ELLIPSIS}${html}`;
  if (to < text.length) html = `${html}${ELLIPSIS}`;
  return html;
}

/**
 * Highlight every query term in a short string (used for result titles).
 * @returns {string} HTML-safe string with <mark> around matches
 */
export function highlight(text, analyzer, termSet) {
  if (typeof text !== 'string' || text === '') return '';
  const hits = findHits(text, analyzer, termSet);
  if (hits.length === 0) return escapeHtml(text);
  return markRange(text, 0, text.length, hits);
}

export default buildSnippet;
