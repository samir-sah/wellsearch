/**
 * The inverted index.
 *
 * Layout:
 *
 *   postings : Map< term, Map< docId, { tf, positions } > >
 *   docLengths: Map< docId, |D| >          (weighted term count)
 *   docTerms  : Map< docId, string[] >     (unique terms, for O(t) removal)
 *
 * A nested `Map` is used rather than a plain object because:
 *   - keys stay strings without prototype-pollution hazards ("__proto__",
 *     "constructor" are real term candidates in a web corpus),
 *   - `Map` has O(1) size and does not de-optimise into dictionary mode when
 *     keys are added and deleted repeatedly,
 *   - iteration order is insertion order, which makes serialisation stable.
 *
 * Retrieval never scans documents: a query touches only the posting lists of
 * its own terms, so cost is proportional to SUM(df(q)) rather than to N.
 *
 * `docTerms` is the one deliberate space/time trade-off: it duplicates the term
 * strings per document (string *references*, not copies) so that
 * `removeDocument` costs O(unique terms in the document) instead of O(all
 * terms in the corpus). It is rebuilt on load and therefore never serialised.
 */

export const INDEX_FORMAT_VERSION = 2;

export class InvertedIndex {
  /**
   * @param {object} [options]
   * @param {boolean} [options.storePositions] keep term positions (phrase search)
   * @param {number} [options.maxPositionsPerTerm] cap positions per (term, doc)
   */
  constructor({ storePositions = true, maxPositionsPerTerm = 64 } = {}) {
    /** @type {Map<string, Map<string, {tf:number, positions:number[]|null}>>} */
    this.postings = new Map();
    /** @type {Map<string, number>} */
    this.docLengths = new Map();
    /** @type {Map<string, string[]>} */
    this.docTerms = new Map();

    this.storePositions = storePositions;
    this.maxPositionsPerTerm = maxPositionsPerTerm;
    this.totalLength = 0;
  }

  /* ----------------------------------------------------------------------- */
  /* Corpus statistics                                                        */
  /* ----------------------------------------------------------------------- */

  /** N - number of indexed documents. */
  get documentCount() {
    return this.docLengths.size;
  }

  /** Size of the term dictionary. */
  get termCount() {
    return this.postings.size;
  }

  /** avgdl - mean document length, used by BM25 length normalisation. */
  get averageDocumentLength() {
    return this.docLengths.size === 0 ? 0 : this.totalLength / this.docLengths.size;
  }

  /* ----------------------------------------------------------------------- */
  /* Mutation                                                                 */
  /* ----------------------------------------------------------------------- */

  /**
   * Add (or replace) a document.
   *
   * @param {object} document
   * @param {string} document.id
   * @param {Map<string, {tf:number, positions?:number[]|null}>} document.terms
   * @param {number} [document.length] defaults to the sum of term frequencies
   * @returns {number} the indexed document length |D|
   */
  addDocument({ id, terms, length }) {
    if (typeof id !== 'string' || id === '') {
      throw new TypeError('addDocument: id must be a non-empty string');
    }
    if (!(terms instanceof Map)) {
      throw new TypeError('addDocument: terms must be a Map of term -> {tf, positions}');
    }

    // Re-indexing the same id must not double count.
    if (this.docLengths.has(id)) this.removeDocument(id);

    const uniqueTerms = new Array(terms.size);
    let cursor = 0;
    let computedLength = 0;

    for (const [term, entry] of terms) {
      const tf = entry?.tf ?? 0;
      if (!(tf > 0)) continue;

      let postingList = this.postings.get(term);
      if (postingList === undefined) {
        postingList = new Map();
        this.postings.set(term, postingList);
      }

      let positions = null;
      if (this.storePositions && Array.isArray(entry.positions) && entry.positions.length > 0) {
        positions = entry.positions.length > this.maxPositionsPerTerm
          ? entry.positions.slice(0, this.maxPositionsPerTerm)
          : entry.positions;
      }

      postingList.set(id, { tf, positions });
      uniqueTerms[cursor] = term;
      cursor += 1;
      computedLength += tf;
    }

    uniqueTerms.length = cursor;

    const documentLength = Number.isFinite(length) && length > 0 ? length : computedLength;
    this.docLengths.set(id, documentLength);
    this.docTerms.set(id, uniqueTerms);
    this.totalLength += documentLength;

    return documentLength;
  }

  /**
   * Remove a document and every posting that references it.
   * @returns {boolean} whether the document existed
   */
  removeDocument(id) {
    const length = this.docLengths.get(id);
    if (length === undefined) return false;

    const terms = this.docTerms.get(id);
    if (terms) {
      for (const term of terms) {
        const postingList = this.postings.get(term);
        if (postingList === undefined) continue;
        postingList.delete(id);
        // Drop empty posting lists so `termCount` stays truthful.
        if (postingList.size === 0) this.postings.delete(term);
      }
    } else {
      // Defensive path: docTerms lost (should not happen) - full sweep.
      for (const [term, postingList] of this.postings) {
        if (postingList.delete(id) && postingList.size === 0) this.postings.delete(term);
      }
    }

    this.docLengths.delete(id);
    this.docTerms.delete(id);
    this.totalLength -= length;
    if (this.totalLength < 0) this.totalLength = 0;
    return true;
  }

  clear() {
    this.postings.clear();
    this.docLengths.clear();
    this.docTerms.clear();
    this.totalLength = 0;
  }

  /* ----------------------------------------------------------------------- */
  /* Lookup                                                                   */
  /* ----------------------------------------------------------------------- */

  /**
   * @param {string} term
   * @returns {Map<string, {tf:number, positions:number[]|null}>|undefined}
   */
  getPostingList(term) {
    return this.postings.get(term);
  }

  /** df(term) - how many documents contain the term. */
  getDocumentFrequency(term) {
    const postingList = this.postings.get(term);
    return postingList === undefined ? 0 : postingList.size;
  }

  /** |D| for a document, or 0 when unknown. */
  getDocumentLength(id) {
    return this.docLengths.get(id) ?? 0;
  }

  /** tf(term, doc). */
  getTermFrequency(term, id) {
    return this.postings.get(term)?.get(id)?.tf ?? 0;
  }

  getPositions(term, id) {
    return this.postings.get(term)?.get(id)?.positions ?? null;
  }

  hasDocument(id) {
    return this.docLengths.has(id);
  }

  hasTerm(term) {
    return this.postings.has(term);
  }

  /** Unique terms of a document (index order, not text order). */
  getDocumentTerms(id) {
    return this.docTerms.get(id) ?? [];
  }

  /** Iterate the dictionary: `for (const term of index.terms())`. */
  terms() {
    return this.postings.keys();
  }

  documentIds() {
    return this.docLengths.keys();
  }

  /**
   * Query terms sorted by ascending document frequency.
   * Cheap but effective: processing the rarest term first keeps the score
   * accumulator small and makes intersection-style filters short-circuit early.
   */
  sortByDocumentFrequency(termList) {
    return [...termList]
      .map((term) => ({ term, df: this.getDocumentFrequency(term) }))
      .sort((a, b) => a.df - b.df);
  }

  stats() {
    let postingCount = 0;
    let positionCount = 0;
    for (const postingList of this.postings.values()) {
      postingCount += postingList.size;
      if (this.storePositions) {
        for (const posting of postingList.values()) {
          if (posting.positions) positionCount += posting.positions.length;
        }
      }
    }
    return {
      documents: this.documentCount,
      terms: this.termCount,
      postings: postingCount,
      positions: positionCount,
      totalLength: this.totalLength,
      averageDocumentLength: Number(this.averageDocumentLength.toFixed(2)),
      storePositions: this.storePositions,
    };
  }

  /* ----------------------------------------------------------------------- */
  /* Serialisation                                                            */
  /* ----------------------------------------------------------------------- */

  /**
   * Streaming serialiser: yields JSON fragments so a large index can be
   * written to disk without building one giant string (which would both spike
   * memory and block the event loop for the whole stringify).
   *
   * Format:
   *   { version, storePositions, documentCount, totalLength,
   *     documents: [[docId, length], ...],
   *     terms: { term: [[docId, tf, positions?], ...], ... } }
   */
  *serialize({ chunkSize = 250 } = {}) {
    yield `{"version":${INDEX_FORMAT_VERSION},` +
      `"storePositions":${this.storePositions ? 'true' : 'false'},` +
      `"documentCount":${this.documentCount},` +
      `"totalLength":${this.totalLength},"documents":[`;

    let first = true;
    let buffer = '';
    for (const [id, length] of this.docLengths) {
      buffer += `${first ? '' : ','}[${JSON.stringify(id)},${length}]`;
      first = false;
      if (buffer.length > 64 * 1024) {
        yield buffer;
        buffer = '';
      }
    }
    if (buffer) yield buffer;

    yield '],"terms":{';

    let termIndex = 0;
    buffer = '';
    for (const [term, postingList] of this.postings) {
      buffer += termIndex === 0 ? '' : ',';
      buffer += `${JSON.stringify(term)}:[`;
      let firstPosting = true;
      for (const [docId, posting] of postingList) {
        buffer += firstPosting ? '' : ',';
        firstPosting = false;
        if (this.storePositions && posting.positions && posting.positions.length) {
          buffer += `[${JSON.stringify(docId)},${posting.tf},[${posting.positions.join(',')}]]`;
        } else {
          buffer += `[${JSON.stringify(docId)},${posting.tf}]`;
        }
      }
      buffer += ']';
      termIndex += 1;
      if (termIndex % chunkSize === 0) {
        yield buffer;
        buffer = '';
      }
    }
    if (buffer) yield buffer;

    yield '}}';
  }

  /** Whole-index snapshot (used by tests; prefer `serialize()` for I/O). */
  toJSON() {
    let json = '';
    for (const chunk of this.serialize()) json += chunk;
    return JSON.parse(json);
  }

  /**
   * Rebuild an index from `serialize()` output.
   * Unknown/corrupt entries are skipped rather than throwing, so a partially
   * damaged file still yields a usable index.
   *
   * @param {object} data
   * @param {{storePositions?: boolean, maxPositionsPerTerm?: number}} [options]
   */
  static fromJSON(data, options = {}) {
    const index = new InvertedIndex({
      storePositions: options.storePositions ?? data?.storePositions ?? true,
      maxPositionsPerTerm: options.maxPositionsPerTerm ?? 64,
    });

    if (!data || typeof data !== 'object') return index;

    if (Array.isArray(data.documents)) {
      for (const entry of data.documents) {
        if (!Array.isArray(entry)) continue;
        const [id, length] = entry;
        if (typeof id !== 'string' || !Number.isFinite(length)) continue;
        index.docLengths.set(id, length);
        index.totalLength += length;
      }
    }

    const terms = data.terms;
    if (terms && typeof terms === 'object') {
      // Accumulate per-document term lists while walking the dictionary.
      const docTerms = new Map();
      for (const id of index.docLengths.keys()) docTerms.set(id, []);

      for (const [term, postings] of Object.entries(terms)) {
        if (!Array.isArray(postings) || postings.length === 0) continue;
        const postingList = new Map();
        for (const posting of postings) {
          if (!Array.isArray(posting)) continue;
          const [docId, tf, positions] = posting;
          if (typeof docId !== 'string' || !Number.isFinite(tf) || tf <= 0) continue;
          if (!index.docLengths.has(docId)) continue; // orphaned posting
          postingList.set(docId, {
            tf,
            positions: index.storePositions && Array.isArray(positions) ? positions : null,
          });
          const list = docTerms.get(docId);
          if (list) list.push(term);
        }
        if (postingList.size > 0) index.postings.set(term, postingList);
      }

      index.docTerms = docTerms;
    }

    return index;
  }
}

export default InvertedIndex;
