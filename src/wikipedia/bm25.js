/**
 * Adapted from Wikipedia_Search_Engine-main/server/server.js (BM25/snippets).
 * Copyright (c) 2025 YOUR_NAME. SPDX-License-Identifier: MIT.
 * The original license is reproduced in THIRD_PARTY_NOTICES.md.
 */

import { tokenize } from './tokenizer.js';

/** BM25 over title (weight 3), article text (1), and categories (2). */
export class BM25Index {
  constructor({ k1 = 1.5, b = 0.75 } = {}) {
    if (!Number.isFinite(k1) || k1 < 0 || !Number.isFinite(b) || b < 0 || b > 1) {
      throw new TypeError('BM25 requires k1 >= 0 and b between 0 and 1');
    }
    this.k1 = k1;
    this.b = b;
    this.documents = new Map();
    this.index = new Map();
    this.documentTerms = new Map();
    this.documentLengths = new Map();
    this.totalTokens = 0;
  }

  get docCount() { return this.documents.size; }
  get avgdl() { return this.docCount ? this.totalTokens / this.docCount : 1; }

  addDocument(input) {
    const id = documentIdentity(input);
    const doc = {
      ...input,
      id,
      title: String(input.title ?? ''),
      content: String(input.content ?? ''),
      categories: Array.isArray(input.categories)
        ? input.categories.filter((category) => typeof category === 'string') : [],
    };
    this.removeDocument(id);

    // Tokenize fields before applying weight: repeating raw strings merges the
    // last word of one copy with the first word of the next ("PhysicsPhysics").
    const tf = new Map();
    for (const [text, weight] of [
      [doc.title, 3], [doc.content, 1], [doc.categories.join(' '), 2],
    ]) {
      for (const term of tokenize(text)) tf.set(term, (tf.get(term) ?? 0) + weight);
    }

    let length = 0;
    for (const [term, frequency] of tf) {
      if (!this.index.has(term)) this.index.set(term, new Map());
      this.index.get(term).set(id, frequency);
      length += frequency;
    }
    this.documents.set(id, doc);
    this.documentTerms.set(id, tf);
    this.documentLengths.set(id, length);
    this.totalTokens += length;
    return doc;
  }

  removeDocument(id) {
    if (!this.documents.has(id)) return false;
    for (const term of this.documentTerms.get(id).keys()) {
      const postings = this.index.get(term);
      postings.delete(id);
      if (postings.size === 0) this.index.delete(term);
    }
    this.totalTokens -= this.documentLengths.get(id);
    this.documents.delete(id);
    this.documentTerms.delete(id);
    this.documentLengths.delete(id);
    return true;
  }

  clear() {
    this.documents.clear();
    this.index.clear();
    this.documentTerms.clear();
    this.documentLengths.clear();
    this.totalTokens = 0;
  }

  search(query, limit = 10) {
    return this.searchTerms(tokenize(query), limit);
  }

  /** Score query tokens already produced by the archive tokenizer exactly once. */
  searchTerms(queryTerms, limit = 10) {
    const terms = [...new Set(Array.isArray(queryTerms)
      ? queryTerms.filter((term) => typeof term === 'string' && term.length > 0) : [])];
    const maxResults = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 10;
    if (!terms.length || !maxResults || !this.docCount) return [];
    const scores = new Map();
    const matches = new Map();

    for (const term of terms) {
      const postings = this.index.get(term);
      if (!postings) continue;
      const idf = Math.log(1 + (this.docCount - postings.size + 0.5) / (postings.size + 0.5));
      for (const [id, tf] of postings) {
        const norm = 1 - this.b + this.b * (this.documentLengths.get(id) / (this.avgdl || 1));
        const score = idf * tf * (this.k1 + 1) / (tf + this.k1 * norm);
        scores.set(id, (scores.get(id) ?? 0) + score);
        if (!matches.has(id)) matches.set(id, []);
        matches.get(id).push(term);
      }
    }

    return [...scores.entries()]
      .sort(([aId, aScore], [bId, bScore]) => bScore - aScore || compare(aId, bId))
      .slice(0, maxResults)
      .map(([id, score]) => ({
        doc: this.documents.get(id),
        score,
        snippet: buildSnippet(this.documents.get(id).content, terms),
        matchedTerms: matches.get(id).length,
        matchedTermList: matches.get(id),
        documentLength: this.documentLengths.get(id),
      }));
  }

  titles() { return [...this.documents.values()].map((doc) => doc.title); }

  stats() {
    return {
      documents: this.docCount,
      terms: this.index.size,
      avgdl: Math.round(this.avgdl),
      totalTokens: this.totalTokens,
    };
  }
}

function compare(a, b) {
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function documentIdentity(doc) {
  if (!doc || typeof doc !== 'object') throw new TypeError('document is required');
  if (typeof doc.url === 'string' && doc.url) {
    try {
      const url = new URL(doc.url);
      if (url.origin === 'https://en.wikipedia.org' && url.pathname.startsWith('/wiki/')) {
        const title = decodeURIComponent(url.pathname.slice('/wiki/'.length)).replace(/ /g, '_');
        return `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`;
      }
      url.hash = '';
      return url.href;
    } catch { /* accept an explicit stable id if the URL is malformed */ }
  }
  if (doc.id === undefined || doc.id === null || String(doc.id) === '') {
    throw new TypeError('document needs a stable URL or id');
  }
  return String(doc.id);
}

/** Plain text only. Rendering and escaping belong to the existing UI. */
export function buildSnippet(content, terms, maxLen = 240) {
  const text = String(content ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maxLen) return text;
  const lower = text.toLowerCase();
  let bestPos = 0;
  let bestHits = -1;
  for (let i = 0; i <= Math.max(0, text.length - maxLen); i += 30) {
    const window = lower.slice(i, i + maxLen);
    const hits = terms.filter((term) => window.includes(term)).length;
    if (hits > bestHits) { bestHits = hits; bestPos = i; }
  }
  let end = bestPos + maxLen;
  // Avoid cutting a word when a nearby word boundary is available.
  if (bestPos > 0) {
    const boundary = text.indexOf(' ', bestPos);
    if (boundary > bestPos && boundary < bestPos + 30) bestPos = boundary + 1;
  }
  const endBoundary = text.lastIndexOf(' ', end);
  if (endBoundary > end - 30) end = endBoundary;
  return `${bestPos > 0 ? '…' : ''}${text.slice(bestPos, end).trim()}${end < text.length ? '…' : ''}`;
}

export default BM25Index;
