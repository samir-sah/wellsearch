/**
 * URL normalisation for the crawl frontier.
 *
 * Two related but distinct operations:
 *   normalizeUrl(href, base) - the canonical URL we will actually *fetch*
 *   urlKey(url)              - the *dedupe* key (more aggressive: sorted query,
 *                              trailing slash folded, case-folded host)
 *
 * Keeping them separate matters: `/a` and `/a/` are different resources per
 * RFC 3986, but crawling both is almost always wasted work, so they share a
 * dedupe key while the fetched URL stays byte-faithful to the link.
 */

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/** Query parameters that never change the content, only analytics. */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'utm_name', 'utm_reader', 'utm_social', 'utm_brand', 'gclid', 'gclsrc', 'dclid',
  'fbclid', 'msclkid', 'mc_cid', 'mc_eid', 'igshid', 'yclid', 'twclid', '_ga', '_gl',
  'ref_src', 'ref_url', 's_cid', 'vero_id', 'wickedid', 'hsa_cam', 'hsa_grp',
]);

/** Extensions that are not HTML documents; skipped before a request is made. */
const NON_DOCUMENT_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg', 'tif', 'tiff',
  'mp3', 'mp4', 'm4a', 'm4v', 'wav', 'ogg', 'oga', 'ogv', 'webm', 'avi', 'mov', 'mkv', 'flac',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar', 'iso', 'dmg', 'exe', 'msi',
  'apk', 'deb', 'rpm', 'pkg', 'jar', 'war', 'bin', 'woff', 'woff2', 'ttf', 'otf', 'eot',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'epub',
  'css', 'js', 'mjs', 'map', 'wasm', 'psd', 'ai', 'eps', 'csv', 'tsv', 'parquet',
]);

export const MAX_URL_LENGTH = 2048;

export function isHttpUrl(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    return ALLOWED_PROTOCOLS.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Resolve `href` against `base` and canonicalise it.
 * Returns `null` for anything we should not fetch (bad syntax, `mailto:`,
 * `javascript:`, fragment-only links, absurdly long URLs).
 *
 * @param {string} href
 * @param {string} [base]
 * @returns {string|null}
 */
export function normalizeUrl(href, base) {
  if (typeof href !== 'string') return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  if (/^(?:javascript|mailto|tel|data|about|blob|file|ftp|ws|wss|sms|magnet):/i.test(trimmed)) {
    return null;
  }
  if (trimmed.length > MAX_URL_LENGTH) return null;

  let url;
  try {
    url = base ? new URL(trimmed, base) : new URL(trimmed);
  } catch {
    return null;
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) return null;
  if (!url.hostname) return null;

  url.hash = '';
  url.username = '';
  url.password = '';
  url.protocol = url.protocol.toLowerCase();

  // `new URL` lowercases the hostname already; the trailing dot form
  // ("example.com.") is equivalent and would otherwise crawl twice.
  if (url.hostname.endsWith('.') && url.hostname.length > 1) {
    url.hostname = url.hostname.slice(0, -1);
  }

  // Drop the port when it is the protocol default.
  if ((url.protocol === 'http:' && url.port === '80') ||
      (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }

  // Collapse `//` and resolve stray `/./` inside the path.
  if (url.pathname.includes('//') || url.pathname.includes('/./')) {
    url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/\/\.\//g, '/');
  }

  if (url.search) {
    let mutated = false;
    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) {
        url.searchParams.delete(key);
        mutated = true;
      }
    }
    if (mutated && [...url.searchParams.keys()].length === 0) url.search = '';
  }

  const result = url.toString();
  return result.length > MAX_URL_LENGTH ? null : result;
}

/**
 * Aggressive canonical form used purely for duplicate detection.
 * `http://Example.com/a/?b=2&a=1#x` and `https://example.com/a?a=1&b=2`
 * collapse to the same key.
 */
export function urlKey(input) {
  const normalized = typeof input === 'string' ? normalizeUrl(input) : null;
  if (!normalized) return null;

  const url = new URL(normalized);
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  const params = [...url.searchParams.entries()]
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  // http and https serve the same content often enough that treating them as
  // one document avoids a very common form of duplication.
  return `${url.hostname}${url.port ? `:${url.port}` : ''}${path}${params ? `?${params}` : ''}`;
}

export function getHost(input) {
  try {
    return new URL(input).hostname;
  } catch {
    return null;
  }
}

export function isSameHost(a, b) {
  const hostA = getHost(a);
  const hostB = getHost(b);
  return Boolean(hostA) && hostA === hostB;
}

/** `www.example.com` and `example.com` are usually the same site. */
export function registrableHost(input) {
  const host = getHost(input);
  return host ? host.replace(/^www\./, '') : null;
}

export function isSameSite(a, b) {
  const siteA = registrableHost(a);
  const siteB = registrableHost(b);
  return Boolean(siteA) && siteA === siteB;
}

/** Extension based pre-filter: avoids downloading media we cannot index. */
export function looksLikeDocument(input) {
  let pathname;
  try {
    pathname = new URL(input).pathname;
  } catch {
    return false;
  }
  const lastSegment = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = lastSegment.lastIndexOf('.');
  if (dot <= 0) return true; // no extension: assume a document
  const ext = lastSegment.slice(dot + 1).toLowerCase();
  return !NON_DOCUMENT_EXTENSIONS.has(ext);
}

/** Path depth, used to prefer shallow (usually more important) pages. */
export function pathDepth(input) {
  try {
    return new URL(input).pathname.split('/').filter(Boolean).length;
  } catch {
    return 0;
  }
}

/** Compact display form: `example.com › docs › guide`-ish breadcrumb source. */
export function displayUrl(input, maxLength = 90) {
  let url;
  try {
    url = new URL(input);
  } catch {
    return String(input ?? '');
  }
  const shown = `${url.hostname}${url.pathname === '/' ? '' : url.pathname}${url.search}`;
  if (shown.length <= maxLength) return shown;
  return `${shown.slice(0, maxLength - 1)}…`;
}

export function robotsUrlFor(input) {
  try {
    const url = new URL(input);
    return `${url.protocol}//${url.host}/robots.txt`;
  } catch {
    return null;
  }
}
