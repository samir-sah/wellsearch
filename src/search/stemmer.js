/**
 * Porter stemmer - a direct implementation of
 *   M.F. Porter, "An algorithm for suffix stripping", Program 14(3), 1980.
 *
 * The algorithm reduces morphological variants to a common stem so that
 * "connect", "connected", "connecting", "connection" and "connections" all
 * collapse onto "connect". A stem is not a linguistic root: "distributed"
 * becomes "distribut", which is fine because the *same* function is applied to
 * documents and queries, so the two always agree.
 *
 * Notation used throughout (from the paper):
 *   c   a consonant, v a vowel
 *   C   a sequence of one or more consonants
 *   V   a sequence of one or more vowels
 *   m   the "measure" of a word: the number of VC repetitions in
 *       [C] (VC){m} [V]
 *
 * `y` is a vowel when preceded by a consonant and a consonant otherwise; the
 * word-initial case is handled by temporarily upper-casing it, which is the
 * trick used in Porter's own reference implementation.
 */

const CONSONANT = '[^aeiou]';
const VOWEL = '[aeiouy]';
/** C - a consonant sequence. `y` only counts as a consonant at the start. */
const C_SEQ = `${CONSONANT}[^aeiouy]*`;
/** V - a vowel sequence. */
const V_SEQ = `${VOWEL}[aeiou]*`;

const M_GT_0 = new RegExp(`^(${C_SEQ})?${V_SEQ}${C_SEQ}`);
const M_EQ_1 = new RegExp(`^(${C_SEQ})?${V_SEQ}${C_SEQ}(${V_SEQ})?$`);
const M_GT_1 = new RegExp(`^(${C_SEQ})?${V_SEQ}${C_SEQ}${V_SEQ}${C_SEQ}`);
/** *v* - the stem contains a vowel. */
const HAS_VOWEL = new RegExp(`^(${C_SEQ})?${VOWEL}`);
/** *d - ends with a double consonant, excluding l, s, z. */
const DOUBLE_CONSONANT = /([^aeiouylsz])\1$/;
/** *o - ends cvc, where the final consonant is not w, x or y. */
const ENDS_CVC = new RegExp(`^${C_SEQ}${VOWEL}[^aeiouwxy]$`);

/** Step 2 suffix replacements: applied when m(stem) > 0. */
const STEP2 = new Map(Object.entries({
  ational: 'ate', tional: 'tion', enci: 'ence', anci: 'ance', izer: 'ize',
  bli: 'ble', alli: 'al', entli: 'ent', eli: 'e', ousli: 'ous',
  ization: 'ize', ation: 'ate', ator: 'ate', alism: 'al', iveness: 'ive',
  fulness: 'ful', ousness: 'ous', aliti: 'al', iviti: 'ive', biliti: 'ble',
  logi: 'log',
}));

/** Step 3 suffix replacements: applied when m(stem) > 0. */
const STEP3 = new Map(Object.entries({
  icate: 'ic', ative: '', alize: 'al', iciti: 'ic', ical: 'ic',
  ful: '', ness: '',
}));

/** Step 4 suffixes: removed entirely when m(stem) > 1. */
const STEP4 = [
  'ement', 'ance', 'ence', 'able', 'ible', 'ment', 'ent', 'ant', 'ism',
  'ate', 'iti', 'ous', 'ive', 'ize', 'al', 'er', 'ic', 'ou',
];

const STEP2_RE = new RegExp(`(${[...STEP2.keys()].join('|')})$`);
const STEP3_RE = new RegExp(`(${[...STEP3.keys()].join('|')})$`);
const STEP4_RE = new RegExp(`(${STEP4.join('|')})$`);

/** Plurals and past participles: SSES/IES/SS/S. */
function step1a(word) {
  if (word.length > 4 && word.endsWith('sses')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('ies')) return word.slice(0, -2);
  if (word.endsWith('ss')) return word;
  if (word.length > 2 && word.endsWith('s')) return word.slice(0, -1);
  return word;
}

/** EED/ED/ING, with the cleanup rules (AT->ATE, double consonant, cvc+e). */
function step1b(word) {
  if (word.length > 3 && word.endsWith('eed')) {
    // (m>0) EED -> EE
    return M_GT_0.test(word.slice(0, -3)) ? word.slice(0, -1) : word;
  }

  let stem = null;
  if (word.length > 2 && word.endsWith('ed')) stem = word.slice(0, -2);
  else if (word.length > 3 && word.endsWith('ing')) stem = word.slice(0, -3);
  if (stem === null || !HAS_VOWEL.test(stem)) return word;

  if (/(?:at|bl|iz)$/.test(stem)) return `${stem}e`;
  if (DOUBLE_CONSONANT.test(stem)) return stem.slice(0, -1);
  if (ENDS_CVC.test(stem)) return `${stem}e`;
  return stem;
}

/** (*v*) Y -> I, so that "happy" and "happier" share a stem. */
function step1c(word) {
  if (word.length > 2 && word.endsWith('y')) {
    const stem = word.slice(0, -1);
    if (HAS_VOWEL.test(stem)) return `${stem}i`;
  }
  return word;
}

function applySuffixMap(word, suffixRe, table) {
  const match = suffixRe.exec(word);
  if (!match) return word;
  const suffix = match[1];
  const stem = word.slice(0, word.length - suffix.length);
  if (stem.length === 0 || !M_GT_0.test(stem)) return word;
  return stem + table.get(suffix);
}

/** Derivational suffixes, pass 1 (-ational -> -ate, ...). */
function step2(word) {
  return applySuffixMap(word, STEP2_RE, STEP2);
}

/** Derivational suffixes, pass 2 (-icate -> -ic, -ness -> null, ...). */
function step3(word) {
  return applySuffixMap(word, STEP3_RE, STEP3);
}

/** Remove residual suffixes when the stem is long enough (m > 1). */
function step4(word) {
  const match = STEP4_RE.exec(word);
  if (match) {
    const stem = word.slice(0, word.length - match[1].length);
    if (stem.length > 0 && M_GT_1.test(stem)) return stem;
    return word;
  }
  // (m>1) ION -> null, but only after S or T ("adoption" -> "adopt").
  if (word.endsWith('ion') && word.length > 4) {
    const previous = word[word.length - 4];
    if (previous === 's' || previous === 't') {
      const stem = word.slice(0, -3);
      if (M_GT_1.test(stem)) return stem;
    }
  }
  return word;
}

/** Tidy up: drop a final `e`, and reduce `ll` to `l`. */
function step5(word) {
  let result = word;

  if (result.length > 1 && result.endsWith('e')) {
    const stem = result.slice(0, -1);
    if (M_GT_1.test(stem) || (M_EQ_1.test(stem) && !ENDS_CVC.test(stem))) {
      result = stem;
    }
  }

  if (result.endsWith('ll') && M_GT_1.test(result)) {
    result = result.slice(0, -1);
  }

  return result;
}

/**
 * Stem a single lower-case word. Words shorter than three characters are
 * returned unchanged (the algorithm is not meaningful for them).
 *
 * @param {string} word
 * @returns {string}
 */
export function porterStem(word) {
  if (typeof word !== 'string') return '';
  if (word.length < 3) return word;

  // Word-initial `y` behaves as a consonant.
  const initialY = word[0] === 'y';
  let result = initialY ? `Y${word.slice(1)}` : word;

  result = step1a(result);
  result = step1b(result);
  result = step1c(result);
  result = step2(result);
  result = step3(result);
  result = step4(result);
  result = step5(result);

  return initialY ? `y${result.slice(1)}` : result;
}

/**
 * Memoising wrapper. Stemming is pure and the same words recur constantly
 * (Zipf's law), so a cache turns most calls into a Map lookup. The cache is
 * bounded so a hostile corpus cannot grow it without limit.
 */
export class Stemmer {
  constructor({ maxCacheSize = 100_000 } = {}) {
    this.cache = new Map();
    this.maxCacheSize = maxCacheSize;
    this.hits = 0;
    this.misses = 0;
  }

  stem(word) {
    const cached = this.cache.get(word);
    if (cached !== undefined) {
      this.hits += 1;
      return cached;
    }
    this.misses += 1;
    const stemmed = porterStem(word);
    if (this.cache.size >= this.maxCacheSize) this.cache.clear();
    this.cache.set(word, stemmed);
    return stemmed;
  }

  get size() {
    return this.cache.size;
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }
}

/** Process-wide stemmer, shared by the indexer and the query parser. */
export const stemmer = new Stemmer();

/** Convenience binding: `stem('running') === 'run'`. */
export const stem = (word) => stemmer.stem(word);

export default stem;
