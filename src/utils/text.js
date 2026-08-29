/**
 * Text utilities: HTML -> readable text, entity decoding, escaping, and the
 * small formatting helpers used by the CLI scripts.
 *
 * The HTML handling here is deliberately tolerant rather than spec compliant:
 * a crawler meets malformed markup constantly (unclosed <script>, stray `<`,
 * bare ampersands) and must never throw on it.
 */

/** Named HTML entities that actually show up in crawled prose. */
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  thinsp: ' ', shy: '', copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“',
  rdquo: '”', sbquo: '‚', bdquo: '„', dagger: '†', Dagger: '‡',
  bull: '•', middot: '·', deg: '°', plusmn: '±', frac12: '½',
  frac14: '¼', frac34: '¾', times: '×', divide: '÷', ne: '≠',
  le: '≤', ge: '≥', minus: '−', laquo: '«', raquo: '»',
  lsaquo: '‹', rsaquo: '›', euro: '€', pound: '£', yen: '¥',
  cent: '¢', sect: '§', para: '¶', micro: 'µ', alpha: 'α',
  beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π', sigma: 'σ',
  omega: 'ω', lambda: 'λ', mu: 'μ', infin: '∞', sum: '∑',
  radic: '√', asymp: '≈', equiv: '≡', larr: '←', rarr: '→',
  harr: '↔', uarr: '↑', darr: '↓', prime: '′', Prime: '″',
  eacute: 'é', egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü',
  ouml: 'ö', auml: 'ä', szlig: 'ß', ntilde: 'ñ', aring: 'å',
  oslash: 'ø', aelig: 'æ', oelig: 'œ',
};

const ENTITY_RE = /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});?/g;

/** Zero-width and format characters that would otherwise split tokens. */
const INVISIBLE_RE = /[\u00ad\u200b-\u200f\u2060\ufeff]/g;

/** Unicode combining marks, removed after NFD to fold accents. */
const COMBINING_RE = /[\u0300-\u036f]/g;

/**
 * Decode numeric and common named HTML entities.
 * Unknown entities are left untouched (better a literal `&foo;` than data loss).
 */
export function decodeEntities(input) {
  if (typeof input !== 'string' || input.indexOf('&') === -1) return input ?? '';
  return input.replace(ENTITY_RE, (match, body) => {
    if (body[0] === '#') {
      const isHex = body[1] === 'x' || body[1] === 'X';
      const code = Number.parseInt(isHex ? body.slice(2) : body.slice(1), isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      // Surrogate halves are invalid on their own.
      if (code >= 0xd800 && code <= 0xdfff) return '';
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body];
    if (named !== undefined) return named;
    const lower = NAMED_ENTITIES[body.toLowerCase()];
    return lower !== undefined ? lower : match;
  });
}

/** Escape a string for safe interpolation into HTML. */
export function escapeHtml(input) {
  if (input === null || input === undefined) return '';
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Remove an element and its contents, tolerating a missing closing tag.
 * Linear scan; no regex backtracking on adversarial input.
 */
export function stripElement(html, tag) {
  const open = `<${tag}`;
  const close = `</${tag}`;
  const lower = html.toLowerCase();
  let out = '';
  let cursor = 0;

  for (;;) {
    const start = lower.indexOf(open, cursor);
    if (start === -1) break;

    // Guard against matching `<scriptish>` when looking for `<script>`.
    const after = lower[start + open.length];
    if (after !== undefined && /[a-z0-9]/.test(after)) {
      out += html.slice(cursor, start + open.length);
      cursor = start + open.length;
      continue;
    }

    out += html.slice(cursor, start);
    const closeAt = lower.indexOf(close, start + open.length);
    if (closeAt === -1) {
      cursor = html.length; // unterminated element: drop the rest
      break;
    }
    const closeEnd = html.indexOf('>', closeAt);
    cursor = closeEnd === -1 ? html.length : closeEnd + 1;
  }

  out += html.slice(cursor);
  return out;
}

const NON_CONTENT_ELEMENTS = [
  'script', 'style', 'noscript', 'template', 'svg', 'math', 'iframe',
  'object', 'embed', 'canvas', 'audio', 'video', 'select', 'button',
];

/** Block level tags become line breaks so sentences do not run together. */
const BLOCK_TAG_RE =
  /<\/?(?:p|div|br|hr|li|ul|ol|dl|dt|dd|tr|td|th|table|thead|tbody|tfoot|h[1-6]|section|article|aside|header|footer|nav|main|form|fieldset|figure|figcaption|blockquote|pre|address|details|summary|caption|option|label)\b[^>]*>/gi;

/**
 * Extract readable text from an HTML document.
 * Steps: drop comments/doctype -> drop non-content elements -> block tags to
 * newlines -> drop remaining tags -> decode entities -> normalise whitespace.
 */
export function htmlToText(html) {
  if (typeof html !== 'string' || html === '') return '';

  let text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, ' ')
    .replace(/<!doctype[^>]*>/gi, ' ');

  for (const tag of NON_CONTENT_ELEMENTS) text = stripElement(text, tag);

  text = text
    .replace(BLOCK_TAG_RE, '\n')
    .replace(/<[^>]*>/g, ' ');

  return normalizeWhitespace(decodeEntities(text));
}

/**
 * Collapse runs of whitespace while keeping paragraph boundaries.
 * Also removes zero-width characters that would break tokenisation.
 */
export function normalizeWhitespace(input) {
  if (typeof input !== 'string') return '';
  return input
    .replace(INVISIBLE_RE, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Single-line variant used for titles and snippets. */
export function singleLine(input) {
  return normalizeWhitespace(input).replace(/\n+/g, ' ');
}

const FOLD_MAP = {
  'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'đ': 'd',
  'ł': 'l', 'þ': 'th', 'ð': 'd', 'ı': 'i', 'ſ': 's',
};
const FOLD_RE = /[ßæœøđłþðıſ]/g;

/**
 * Fold accents so that "cafe" with and without the acute accent produce the
 * same token. NFD + combining-mark removal handles most Latin scripts; the map
 * above covers the letters that have no canonical decomposition.
 */
export function foldDiacritics(input) {
  if (typeof input !== 'string' || input === '') return '';
  let folded = input;
  if (FOLD_RE.test(folded)) {
    FOLD_RE.lastIndex = 0;
    folded = folded.replace(FOLD_RE, (ch) => FOLD_MAP[ch] ?? ch);
  }
  FOLD_RE.lastIndex = 0;
  return folded.normalize('NFD').replace(COMBINING_RE, '');
}

/** Truncate on a word boundary when possible. */
export function truncate(input, maxLength, suffix = '…') {
  const text = String(input ?? '');
  if (text.length <= maxLength) return text;
  const cut = text.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(' ');
  const body = lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut;
  return body.replace(/[\s.,;:!?-]+$/, '') + suffix;
}

/* -------------------------------------------------------------------------- */
/* Formatting helpers (CLI + dashboard)                                        */
/* -------------------------------------------------------------------------- */

export function formatNumber(value) {
  if (!Number.isFinite(value)) return String(value);
  return value.toLocaleString('en-US');
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return '-';
  if (ms < 1) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 0)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${(seconds - minutes * 60).toFixed(1)}s`;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '-';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)}${units[unit]}`;
}
