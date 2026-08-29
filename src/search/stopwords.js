/**
 * English stop words.
 *
 * The list is intentionally conservative: it removes closed-class function
 * words (determiners, pronouns, auxiliaries, prepositions, conjunctions) that
 * carry almost no discriminative power, but keeps words that are frequently
 * part of a real query ("how", "why", "not", "no", "than" are kept because
 * queries like "how to" or "not null" lose their meaning without them...
 * except that "how" and "to" are so common they are removed anyway - see
 * QUESTION_WORDS below, which callers can splice back in).
 *
 * BM25 already down-weights very frequent terms via IDF, so stop-word removal
 * here is mainly an index-size and latency optimisation: the top ~150 words of
 * English account for roughly half of all tokens in running prose.
 */

const BASE_STOP_WORDS = [
  // articles / determiners
  'a', 'an', 'the', 'this', 'that', 'these', 'those', 'each', 'every', 'either',
  'neither', 'another', 'such', 'some', 'any', 'all', 'both', 'few', 'many',
  'much', 'most', 'other', 'others', 'own', 'same',
  // pronouns
  'i', 'me', 'my', 'mine', 'myself', 'we', 'us', 'our', 'ours', 'ourselves',
  'you', 'your', 'yours', 'yourself', 'yourselves', 'he', 'him', 'his',
  'himself', 'she', 'her', 'hers', 'herself', 'it', 'its', 'itself', 'they',
  'them', 'their', 'theirs', 'themselves', 'who', 'whom', 'whose', 'which',
  'what', 'whatever', 'whoever', 'someone', 'something', 'anyone', 'anything',
  'everyone', 'everything', 'nobody', 'none',
  // be / have / do / modals
  'am', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has',
  'had', 'having', 'do', 'does', 'did', 'doing', 'done', 'will', 'would',
  'shall', 'should', 'can', 'could', 'may', 'might', 'must', 'ought',
  // contraction remnants (apostrophes are stripped during tokenisation)
  'dont', 'doesnt', 'didnt', 'isnt', 'arent', 'wasnt', 'werent', 'cant',
  'cannot', 'couldnt', 'shouldnt', 'wouldnt', 'wont', 'im', 'ive', 'ill',
  'id', 'youre', 'youve', 'youll', 'hes', 'shes', 'theyre', 'theyve',
  'theres', 'thats', 'whats', 'lets',
  // prepositions / conjunctions / particles
  'of', 'to', 'in', 'on', 'at', 'by', 'for', 'with', 'about', 'against',
  'between', 'into', 'through', 'during', 'before', 'after', 'above',
  'below', 'from', 'up', 'down', 'out', 'off', 'over', 'under', 'again',
  'further', 'then', 'once', 'here', 'there', 'when', 'where', 'while',
  'and', 'or', 'but', 'nor', 'if', 'because', 'as', 'until', 'unless',
  'although', 'though', 'since', 'so', 'than', 'too', 'very', 'just',
  'also', 'however', 'therefore', 'thus', 'hence', 'moreover',
  // adverbs / fillers with near-zero retrieval value
  'now', 'ever', 'never', 'always', 'often', 'usually', 'perhaps', 'maybe',
  'quite', 'rather', 'really', 'even', 'still', 'yet', 'already', 'about',
  'onto', 'upon', 'via', 'per', 'etc',
  // web boilerplate
  'http', 'https', 'www', 'com', 'html', 'href', 'click', 'page', 'home',
];

/**
 * Words that are stop words in prose but often meaningful in a query.
 * Not removed by default; exported so the behaviour is documented and
 * configurable rather than hidden.
 */
export const QUESTION_WORDS = ['how', 'why', 'not', 'no', 'without'];

export const DEFAULT_STOP_WORDS = Object.freeze([...new Set(BASE_STOP_WORDS)]);

/**
 * @param {object} [options]
 * @param {boolean} [options.enabled] when false an empty set is returned
 * @param {string[]} [options.extra]  additional words to remove
 * @param {string[]} [options.keep]   words to *not* treat as stop words
 * @returns {Set<string>}
 */
export function createStopWordSet({ enabled = true, extra = [], keep = [] } = {}) {
  if (!enabled) return new Set();
  const set = new Set(DEFAULT_STOP_WORDS);
  for (const word of extra) {
    const normalized = String(word).trim().toLowerCase();
    if (normalized) set.add(normalized);
  }
  for (const word of keep) set.delete(String(word).trim().toLowerCase());
  return set;
}

export const defaultStopWords = createStopWordSet();
