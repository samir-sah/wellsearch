/**
 * HTTP fetching for the crawler.
 *
 * Built on Node HTTP(S), with outbound sockets pinned to policy-validated DNS
 * answers and the controls a crawler needs:
 *
 *   1. a real timeout that also covers the body download (AbortController)
 *   2. a redirect chain we control and can count (`redirect: 'manual'`)
 *   3. a hard byte ceiling, enforced while streaming, so one 500 MB page cannot
 *      exhaust memory
 *   4. charset handling: Content-Type first, then a `<meta charset>` sniff
 *
 * This module never throws. Every failure comes back as
 * `{ ok: false, errorType, error }` so a single bad page can never take down a
 * worker, the crawl, or the server.
 */

import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { normalizeUrl } from '../utils/url.js';
import { checkCrawlTarget } from './networkPolicy.js';

const HTML_TYPES = new Set([
  'text/html', 'application/xhtml+xml', 'application/xml', 'text/xml', 'text/plain',
]);

const META_CHARSET_RE = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i;
const CHARSET_PARAM_RE = /charset\s*=\s*["']?\s*([a-z0-9_:.-]+)/i;

/** Statuses worth another attempt: transient by definition. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 509, 522, 524]);

/** Error classes worth another attempt. */
const RETRYABLE_ERRORS = new Set(['timeout', 'network', 'reset', 'dns']);

export class Fetcher {
  constructor({ config, logger, fetchImpl, lookup } = {}) {
    this.userAgent = config?.crawler?.userAgent ?? 'WellSearchBot/1.0';
    this.timeoutMs = config?.crawler?.requestTimeout ?? 10_000;
    this.maxBytes = config?.crawler?.maxContentBytes ?? 2 * 1024 * 1024;
    this.maxRedirects = config?.crawler?.maxRedirects ?? 5;
    this.allowPrivateNetwork = config?.crawler?.allowPrivateNetwork ?? false;
    this.logger = logger;
    this.fetchImpl = fetchImpl;
    this.lookup = lookup;
    this.requests = 0;
    this.bytes = 0;
  }

  /**
   * Fetch a document.
   *
   * @param {string} url
   * @param {{ acceptAnyType?: boolean, timeoutMs?: number, allowedOrigin?: string }} [options]
   * @returns {Promise<object>} never rejects
   */
  async fetch(url, { acceptAnyType = false, timeoutMs = this.timeoutMs, allowedOrigin } = {}) {
    const startedAt = performance.now();
    const redirects = [];
    let current = url;

    for (let hop = 0; hop <= this.maxRedirects; hop += 1) {
      // A source-specific client may restrict even public redirects to one
      // origin. Check before resolving or connecting to the next destination.
      if (allowedOrigin) {
        let permitted = false;
        try {
          const target = new URL(current);
          permitted = target.origin === allowedOrigin && !target.username && !target.password;
        } catch { /* invalid targets fail closed */ }
        if (!permitted) return {
          ok: false, url: current, requestedUrl: url, status: 0,
          errorType: 'blocked-origin', error: 'redirect left the permitted source origin',
          retryable: false, redirects, redirectCount: redirects.length,
          durationMs: round(performance.now() - startedAt),
        };
      }
      // Source-specific requests have one deadline for the whole redirect
      // chain rather than starting a fresh budget on every hop.
      const remaining = allowedOrigin ? timeoutMs - (performance.now() - startedAt) : timeoutMs;
      if (remaining <= 0) return {
        ok: false, url: current, requestedUrl: url, status: 0,
        errorType: 'timeout', error: 'request timed out', retryable: true,
        redirects, redirectCount: redirects.length, durationMs: round(performance.now() - startedAt),
      };
      const attempt = await this.#once(current, { timeoutMs: Math.max(1, remaining), acceptAnyType });

      if (attempt.redirectTo) {
        redirects.push({ from: current, to: attempt.redirectTo, status: attempt.status });
        current = attempt.redirectTo;
        continue;
      }

      return {
        ...attempt,
        requestedUrl: url,
        redirects,
        redirectCount: redirects.length,
        durationMs: round(performance.now() - startedAt),
      };
    }

    return {
      ok: false,
      url: current,
      requestedUrl: url,
      status: 0,
      errorType: 'too-many-redirects',
      error: `more than ${this.maxRedirects} redirects`,
      redirects,
      redirectCount: redirects.length,
      durationMs: round(performance.now() - startedAt),
      retryable: false,
    };
  }

  async #once(url, { timeoutMs, acceptAnyType }) {
    this.requests += 1;
    // DNS must fit inside the same budget as headers/body; otherwise a slow
    // resolver could keep an interactive search alive past the client timeout.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('request timed out')), timeoutMs);
    let target;
    try {
      target = await untilAborted(checkCrawlTarget(url, {
        allowPrivateNetwork: this.allowPrivateNetwork,
        lookup: this.lookup,
      }), controller.signal);
    } catch (error) {
      clearTimeout(timer);
      return { ok: false, url, status: 0, errorType: classifyError(error, controller.signal),
        error: describeError(error), retryable: true };
    }
    if (!target.allowed) {
      clearTimeout(timer);
      return {
        ok: false,
        url,
        status: 0,
        errorType: target.reason,
        error: target.reason === 'private-network'
          ? 'crawler target resolves to a blocked private or local network'
          : `crawler target validation failed: ${target.reason}`,
        retryable: false,
      };
    }

    let response;
    try {
      const requestOptions = {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': this.userAgent,
          accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5',
          'accept-language': 'en;q=0.9,*;q=0.5',
        },
      };
      response = this.fetchImpl
        ? await this.fetchImpl(url, requestOptions, target)
        : await pinnedFetch(url, target.addresses, requestOptions);
    } catch (error) {
      clearTimeout(timer);
      const errorType = classifyError(error, controller.signal);
      return {
        ok: false,
        url,
        status: 0,
        errorType,
        error: describeError(error),
        retryable: RETRYABLE_ERRORS.has(errorType),
      };
    }

    const status = response.status;
    const headers = response.headers;
    const contentType = (headers.get('content-type') ?? '').toLowerCase();

    // --- redirects -------------------------------------------------------
    if (status >= 300 && status < 400) {
      clearTimeout(timer);
      await drain(response);
      const location = headers.get('location');
      const target = location ? normalizeUrl(location, url) : null;
      if (target === null) {
        return {
          ok: false, url, status, contentType,
          errorType: 'bad-redirect',
          error: location ? `unusable redirect target: ${location}` : 'redirect without a location header',
          retryable: false,
        };
      }
      return { redirectTo: target, status, url };
    }

    // --- HTTP errors -----------------------------------------------------
    if (!response.ok) {
      clearTimeout(timer);
      await drain(response);
      return {
        ok: false,
        url,
        status,
        statusText: response.statusText,
        contentType,
        errorType: 'http',
        error: `HTTP ${status}${response.statusText ? ` ${response.statusText}` : ''}`,
        retryAfterMs: parseRetryAfter(headers.get('retry-after')),
        retryable: RETRYABLE_STATUSES.has(status),
      };
    }

    // --- content type ----------------------------------------------------
    const mime = contentType.split(';')[0].trim();
    if (!acceptAnyType && mime !== '' && !HTML_TYPES.has(mime)) {
      clearTimeout(timer);
      await drain(response);
      return {
        ok: false, url, status, contentType,
        errorType: 'unsupported-type',
        error: `unsupported content type: ${mime}`,
        retryable: false,
      };
    }

    const declaredLength = Number.parseInt(headers.get('content-length') ?? '', 10);
    if (Number.isFinite(declaredLength) && declaredLength > this.maxBytes) {
      clearTimeout(timer);
      await drain(response);
      return {
        ok: false, url, status, contentType,
        errorType: 'too-large',
        error: `content-length ${declaredLength} exceeds the ${this.maxBytes} byte limit`,
        retryable: false,
      };
    }

    // --- body ------------------------------------------------------------
    let buffer;
    let truncated = false;
    try {
      const read = await readCapped(response, this.maxBytes);
      buffer = read.buffer;
      truncated = read.truncated;
    } catch (error) {
      clearTimeout(timer);
      const errorType = classifyError(error, controller.signal);
      return {
        ok: false, url, status, contentType,
        errorType,
        error: describeError(error),
        retryable: RETRYABLE_ERRORS.has(errorType),
      };
    } finally {
      clearTimeout(timer);
    }

    this.bytes += buffer.byteLength;
    const { text, charset } = decodeBody(buffer, contentType);

    return {
      ok: true,
      url,
      finalUrl: url,
      status,
      statusText: response.statusText,
      contentType,
      charset,
      text,
      bytes: buffer.byteLength,
      truncated,
      etag: headers.get('etag'),
      lastModified: headers.get('last-modified'),
      retryable: false,
    };
  }

  stats() {
    return { requests: this.requests, bytes: this.bytes };
  }
}

/**
 * Connect only to the validated address set. The URL hostname is retained in
 * Host and TLS servername, so virtual hosting and certificate checks stay intact.
 */
async function pinnedFetch(input, addresses, { signal, headers }) {
  const url = new URL(input);
  let lastError;
  for (const { address, family } of addresses) {
    try {
      return await requestAddress(url, { address, family, signal, headers });
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw error;
    }
  }
  throw lastError ?? new Error('no validated address available');
}

function requestAddress(url, { address, family, signal, headers }) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.request({
      protocol: url.protocol,
      hostname: address,
      family,
      port: url.port || undefined,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { ...headers, host: url.host },
      servername: url.hostname,
      rejectUnauthorized: true,
      signal,
      agent: false,
    }, (incoming) => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((item) => responseHeaders.append(key, item));
        else if (value !== undefined) responseHeaders.set(key, value);
      }
      try {
        // Response forbids bodies on these statuses. Passing the stream would
        // throw from this event callback, outside the fetcher's error handling.
        const noBody = [204, 205, 304].includes(incoming.statusCode);
        if (noBody) incoming.resume();
        resolve(new Response(noBody ? null : Readable.toWeb(incoming), {
          status: incoming.statusCode,
          statusText: incoming.statusMessage,
          headers: responseHeaders,
        }));
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    request.once('error', reject);
    request.end();
  });
}

/** Read a response body, stopping hard at `maxBytes`. */
async function readCapped(response, maxBytes) {
  if (!response.body) return { buffer: new Uint8Array(0), truncated: false };

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;

    if (total + value.byteLength > maxBytes) {
      chunks.push(value.subarray(0, maxBytes - total));
      total = maxBytes;
      truncated = true;
      try {
        await reader.cancel();
      } catch { /* the socket is being torn down anyway */ }
      break;
    }

    chunks.push(value);
    total += value.byteLength;
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { buffer, truncated };
}

/**
 * Decode bytes to text: Content-Type charset first, then a `<meta charset>`
 * sniff for the very common case of a server that does not declare one.
 */
function decodeBody(buffer, contentType) {
  const declared = CHARSET_PARAM_RE.exec(contentType)?.[1]?.toLowerCase();
  let charset = declared ?? 'utf-8';
  let text = decodeWith(buffer, charset);

  if (!declared) {
    const sniffed = META_CHARSET_RE.exec(text.slice(0, 4096))?.[1]?.toLowerCase();
    if (sniffed && sniffed !== 'utf-8' && sniffed !== 'utf8') {
      const retry = decodeWith(buffer, sniffed, true);
      if (retry !== null) {
        text = retry;
        charset = sniffed;
      }
    }
  }

  return { text, charset };
}

function decodeWith(buffer, label, strict = false) {
  try {
    return new TextDecoder(label).decode(buffer);
  } catch {
    return strict ? null : new TextDecoder('utf-8').decode(buffer);
  }
}

/** Consume and discard a body so the socket can be reused. */
async function drain(response) {
  try {
    if (response.body && !response.bodyUsed) await response.body.cancel();
  } catch { /* ignore */ }
}

function classifyError(error, signal) {
  if (signal?.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') return 'timeout';
  const code = error?.cause?.code ?? error?.code ?? '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
  if (code === 'ECONNREFUSED') return 'refused';
  if (code === 'ECONNRESET' || code === 'EPIPE') return 'reset';
  if (code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'ERR_TLS_CERT_ALTNAME_INVALID') return 'tls';
  return 'network';
}

function describeError(error) {
  if (!error) return 'unknown error';
  const code = error.cause?.code ?? error.code;
  const message = error.cause?.message ?? error.message ?? String(error);
  return code ? `${code}: ${message}` : message;
}

function parseRetryAfter(value) {
  if (!value) return null;
  const seconds = Number.parseInt(value, 10);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 60_000);
  return null;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

export { RETRYABLE_ERRORS, RETRYABLE_STATUSES };
export default Fetcher;

function untilAborted(task, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('request timed out'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(task).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
