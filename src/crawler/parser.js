/**
 * HTML parsing: title, metadata, links and readable text.
 *
 * Deliberately regex/scanner based rather than a DOM library, for three
 * reasons: no dependency, linear time, and total tolerance of malformed markup.
 * A crawler meets unclosed tags, stray `<`, duplicated `<head>` and truncated
 * documents constantly - there is nothing to "fail" here, only more or less
 * text extracted. Every function returns a usable result for any input.
 *
 * Script, style, template, SVG and other non-content elements are removed by
 * `htmlToText` before extraction, so their contents never reach the index.
 */

import { decodeEntities, htmlToText, normalizeWhitespace, singleLine } from '../utils/text.js';
import { isSameSite, normalizeUrl } from '../utils/url.js';

const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;
const META_RE = /<meta\b([^>]*)>/gi;
const LINK_TAG_RE = /<link\b([^>]*)>/gi;
const ANCHOR_RE = /<a\b([^>]*)>/gi;
const BASE_RE = /<base\b([^>]*)>/i;
const HTML_TAG_RE = /<html\b([^>]*)>/i;
const HEADING_RE = /<h([1-3])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
const ATTRIBUTE_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("[^"]*"|'[^']*'|[^\s"'`=<>]+))?/g;

const MAX_LINKS = 500;
const MAX_HEADINGS = 20;

/**
 * Parse one HTML document.
 *
 * @param {string} html
 * @param {string} url the URL the document was fetched from (link base)
 * @param {{ maxLinks?: number }} [options]
 * @returns {{
 *   title: string, description: string, canonical: string|null, lang: string|null,
 *   noindex: boolean, nofollow: boolean, links: string[], nofollowLinks: number,
 *   text: string, headings: string[], linkCount: number, internalLinks: number,
 *   externalLinks: number
 * }}
 */
export function parseDocument(html, url, { maxLinks = MAX_LINKS } = {}) {
  const source = typeof html === 'string' ? html : '';

  const base = resolveBase(source, url);
  const meta = extractMeta(source);
  const headings = extractHeadings(source);
  const title = extractTitle(source) || headings[0] || '';
  const { links, nofollowLinks, internalLinks, externalLinks } =
    extractLinks(source, base, { maxLinks });

  return {
    title: singleLine(title),
    description: singleLine(meta.description ?? ''),
    canonical: meta.canonical ? normalizeUrl(meta.canonical, base) : null,
    lang: extractLang(source) ?? meta.lang ?? null,
    keywords: meta.keywords ?? '',
    noindex: meta.noindex,
    nofollow: meta.nofollow,
    links,
    nofollowLinks,
    linkCount: links.length,
    internalLinks,
    externalLinks,
    text: htmlToText(source),
    headings,
  };
}

export function extractTitle(html) {
  const match = TITLE_RE.exec(html);
  if (match === null) return '';
  return normalizeWhitespace(decodeEntities(match[1]));
}

export function extractLang(html) {
  const match = HTML_TAG_RE.exec(html);
  if (match === null) return null;
  const lang = parseAttributes(match[1]).get('lang');
  if (!lang) return null;
  return lang.trim().slice(0, 16).toLowerCase() || null;
}

/**
 * `<base href>` overrides the document URL for relative links.
 * An unusable base is ignored rather than allowed to break every link.
 */
export function resolveBase(html, url) {
  const match = BASE_RE.exec(html);
  if (match !== null) {
    const href = parseAttributes(match[1]).get('href');
    if (href) {
      const resolved = normalizeUrl(href, url);
      if (resolved !== null) return resolved;
    }
  }
  return url;
}

/** `<meta>` plus `<link rel=canonical>`. */
export function extractMeta(html) {
  const result = {
    description: '', keywords: '', canonical: null, lang: null, noindex: false, nofollow: false,
  };

  META_RE.lastIndex = 0;
  let match;
  while ((match = META_RE.exec(html)) !== null) {
    const attributes = parseAttributes(match[1]);
    const name = (attributes.get('name') ?? attributes.get('property') ?? '').toLowerCase();
    const content = attributes.get('content');
    if (!content) continue;

    switch (name) {
      case 'description':
      case 'og:description':
      case 'twitter:description':
        if (!result.description) result.description = normalizeWhitespace(decodeEntities(content));
        break;
      case 'keywords':
        result.keywords = normalizeWhitespace(decodeEntities(content));
        break;
      case 'language':
      case 'content-language':
        result.lang = content.trim().slice(0, 16).toLowerCase();
        break;
      case 'robots':
      case 'nixsearchbot': {
        const directives = content.toLowerCase();
        if (directives.includes('noindex') || directives.includes('none')) result.noindex = true;
        if (directives.includes('nofollow') || directives.includes('none')) result.nofollow = true;
        break;
      }
      default:
        break;
    }
  }
  META_RE.lastIndex = 0;

  LINK_TAG_RE.lastIndex = 0;
  while ((match = LINK_TAG_RE.exec(html)) !== null) {
    const attributes = parseAttributes(match[1]);
    const rel = (attributes.get('rel') ?? '').toLowerCase();
    if (rel.split(/\s+/).includes('canonical')) {
      const href = attributes.get('href');
      if (href && result.canonical === null) result.canonical = decodeEntities(href).trim();
    }
  }
  LINK_TAG_RE.lastIndex = 0;

  return result;
}

export function extractHeadings(html, limit = MAX_HEADINGS) {
  const headings = [];
  HEADING_RE.lastIndex = 0;
  let match;
  while ((match = HEADING_RE.exec(html)) !== null && headings.length < limit) {
    const text = normalizeWhitespace(decodeEntities(stripTags(match[2])));
    if (text) headings.push(text.slice(0, 200));
  }
  HEADING_RE.lastIndex = 0;
  return headings;
}

/**
 * Collect outbound links, resolved against `base`, normalised and de-duplicated
 * in document order. `rel="nofollow"` links are counted but not followed.
 */
export function extractLinks(html, base, { maxLinks = MAX_LINKS } = {}) {
  const seen = new Set();
  const links = [];
  let nofollowLinks = 0;
  let internalLinks = 0;
  let externalLinks = 0;

  ANCHOR_RE.lastIndex = 0;
  let match;
  while ((match = ANCHOR_RE.exec(html)) !== null) {
    if (links.length >= maxLinks) break;

    const attributes = parseAttributes(match[1]);
    const href = attributes.get('href');
    if (!href) continue;

    const rel = (attributes.get('rel') ?? '').toLowerCase().split(/\s+/);
    if (rel.includes('nofollow')) {
      nofollowLinks += 1;
      continue;
    }

    const resolved = normalizeUrl(decodeEntities(href), base);
    if (resolved === null || seen.has(resolved)) continue;

    seen.add(resolved);
    links.push(resolved);
    if (isSameSite(base, resolved)) internalLinks += 1;
    else externalLinks += 1;
  }
  ANCHOR_RE.lastIndex = 0;

  return { links, nofollowLinks, internalLinks, externalLinks };
}

/**
 * Parse a tag's attribute list into a Map.
 * Unquoted, single-quoted, double-quoted and valueless attributes all work;
 * a duplicate attribute keeps the first value, matching browser behaviour.
 */
export function parseAttributes(tagBody) {
  const attributes = new Map();
  if (typeof tagBody !== 'string' || tagBody === '') return attributes;

  ATTRIBUTE_RE.lastIndex = 0;
  let match;
  while ((match = ATTRIBUTE_RE.exec(tagBody)) !== null) {
    const name = match[1].toLowerCase();
    if (attributes.has(name)) continue;
    let value = match[2] ?? '';
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'")) value = value.slice(1, -1);
    attributes.set(name, value);
  }
  ATTRIBUTE_RE.lastIndex = 0;

  return attributes;
}

function stripTags(html) {
  return html.replace(/<[^>]*>/g, ' ');
}

export default parseDocument;
