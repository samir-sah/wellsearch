/**
 * Okapi BM25.
 *
 *   score(D, Q) = SUM over q in Q of
 *
 *                              tf(q, D) * (k1 + 1)
 *       idf(q) * ---------------------------------------------
 *                 tf(q, D) + k1 * (1 - b + b * |D| / avgdl)
 *
 * Two knobs:
 *   k1  term-frequency saturation. As tf grows the numerator and denominator
 *       both grow, so the contribution tends to idf * (k1 + 1); a document
 *       mentioning a term 50 times is not 50x more relevant than one
 *       mentioning it once. k1 = 0 ignores tf entirely.
 *   b   length normalisation. b = 0 ignores document length, b = 1 fully
 *       normalises by |D| / avgdl, penalising long documents that match a term
 *       simply because they contain more words.
 *
 * IDF uses the standard probabilistic form with the +1 smoothing that keeps it
 * non-negative:
 *
 *       idf(q) = ln(1 + (N - df + 0.5) / (df + 0.5))
 *
 * Without the outer `1 +`, a term appearing in more than half the corpus gets a
 * negative weight, which lets an irrelevant document outrank a relevant one.
 */

export const DEFAULT_K1 = 1.5;
export const DEFAULT_B = 0.75;

/**
 * Inverse document frequency.
 * @param {number} totalDocuments N
 * @param {number} documentFrequency df - documents containing the term
 */
export function idf(totalDocuments, documentFrequency) {
  if (!(totalDocuments > 0) || !(documentFrequency > 0)) return 0;
  const df = Math.min(documentFrequency, totalDocuments);
  return Math.log(1 + (totalDocuments - df + 0.5) / (df + 0.5));
}

/**
 * The tf component, i.e. everything except idf.
 * Split out so it can be unit-tested and so the scorer can hoist the
 * length-normalisation factor out of the inner loop.
 */
export function termFrequencyComponent(tf, documentLength, averageDocumentLength, k1 = DEFAULT_K1, b = DEFAULT_B) {
  if (!(tf > 0)) return 0;
  const avgdl = averageDocumentLength > 0 ? averageDocumentLength : 1;
  const lengthNorm = 1 - b + b * (documentLength / avgdl);
  return (tf * (k1 + 1)) / (tf + k1 * lengthNorm);
}

/**
 * BM25 contribution of one query term to one document.
 */
export function termScore(
  tf,
  documentLength,
  averageDocumentLength,
  idfValue,
  k1 = DEFAULT_K1,
  b = DEFAULT_B,
) {
  return idfValue * termFrequencyComponent(tf, documentLength, averageDocumentLength, k1, b);
}

/**
 * Small holder for the two parameters plus the per-query precomputation.
 * Keeping this stateless with respect to the index means a caller can score
 * against any index snapshot.
 */
export class BM25 {
  constructor({ k1 = DEFAULT_K1, b = DEFAULT_B } = {}) {
    this.k1 = k1;
    this.b = b;
  }

  idf(totalDocuments, documentFrequency) {
    return idf(totalDocuments, documentFrequency);
  }

  /**
   * Hoisted form for the scoring loop.
   *
   * `k1 * (1 - b + b * |D| / avgdl)` depends only on the document, so it is
   * computed once per (document, query) pair instead of once per term.
   */
  lengthPenalty(documentLength, averageDocumentLength) {
    const avgdl = averageDocumentLength > 0 ? averageDocumentLength : 1;
    return this.k1 * (1 - this.b + this.b * (documentLength / avgdl));
  }

  /**
   * @param {number} tf term frequency in the document
   * @param {number} idfValue precomputed idf for the term
   * @param {number} penalty precomputed `lengthPenalty(|D|, avgdl)`
   */
  score(tf, idfValue, penalty) {
    return (idfValue * (tf * (this.k1 + 1))) / (tf + penalty);
  }

  /**
   * Reference implementation kept for tests: scores a single document from
   * scratch, without any hoisting, using the formula exactly as written above.
   *
   * @param {Map<string, number>} termFrequencies term -> tf in this document
   * @param {string[]} queryTerms
   * @param {{ totalDocuments: number, documentFrequency(term: string): number,
   *           documentLength: number, averageDocumentLength: number }} stats
   */
  scoreDocument(termFrequencies, queryTerms, stats) {
    let total = 0;
    for (const term of queryTerms) {
      const tf = termFrequencies.get(term) ?? 0;
      if (tf <= 0) continue;
      total += termScore(
        tf,
        stats.documentLength,
        stats.averageDocumentLength,
        idf(stats.totalDocuments, stats.documentFrequency(term)),
        this.k1,
        this.b,
      );
    }
    return total;
  }
}

export default BM25;
