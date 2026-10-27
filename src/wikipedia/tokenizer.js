/**
 * Adapted from Wikipedia_Search_Engine-main/indexer/tokenizer.js.
 * Copyright (c) 2025 YOUR_NAME. SPDX-License-Identifier: MIT.
 * The original license is reproduced in THIRD_PARTY_NOTICES.md.
 */

import STOP_WORDS from './stopwords.js';

const STEP_TWO = {
  ational: 'ate', tional: 'tion', enci: 'ence', anci: 'ance',
  izer: 'ize', iser: 'ise', alism: 'al', ness: '', ment: '',
  fulness: 'ful', ousness: 'ous', iveness: 'ive', ization: 'ize',
};

/** The archive's lightweight English suffix stemmer. */
export function stem(word) {
  if (word.length <= 2) return word;

  if (word.endsWith('sses')) word = word.slice(0, -2);
  else if (word.endsWith('ies')) word = word.slice(0, -2);
  else if (word.endsWith('ss')) { /* keep */ }
  else if (word.endsWith('s') && word.length > 3) word = word.slice(0, -1);

  if (word.endsWith('eed')) {
    if (word.length > 4) word = word.slice(0, -1);
  } else if (word.endsWith('ing') && word.length > 5) {
    word = word.slice(0, -3);
    if (word.endsWith('at') || word.endsWith('bl') || word.endsWith('iz')) word += 'e';
  } else if (word.endsWith('ed') && word.length > 4) {
    word = word.slice(0, -2);
    if (word.endsWith('at') || word.endsWith('bl') || word.endsWith('iz')) word += 'e';
  }

  for (const [suffix, replacement] of Object.entries(STEP_TWO)) {
    if (word.endsWith(suffix) && word.length > suffix.length + 2) {
      word = word.slice(0, -suffix.length) + replacement;
      break;
    }
  }

  if (word.endsWith('e') && word.length > 4) word = word.slice(0, -1);
  return word;
}

function words(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s*-\s*/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

export function tokenize(text) {
  return words(text).map(stem);
}

export function tokenizeWithOriginals(text) {
  return words(text).map((original) => ({ original, stem: stem(original) }));
}

export default tokenize;
