/**
 * Typed HTTP errors.
 *
 * Controllers throw these; the central error middleware turns them into the
 * one JSON error envelope the whole API uses:
 *
 *   { "error": { "code": "BAD_REQUEST", "message": "...", "details": {...} } }
 *
 * Anything thrown that is *not* an HttpError is treated as a bug: it becomes a
 * 500 with a generic message, and the real error is logged server-side only.
 * That way an internal stack trace or file path can never leak to a client.
 */

export class HttpError extends Error {
  /**
   * @param {number} status
   * @param {string} message safe to show a client
   * @param {{ code?: string, details?: object, cause?: unknown, expose?: boolean }} [options]
   */
  constructor(status, message, { code, details, cause, expose } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code ?? defaultCode(status);
    this.details = details;
    this.expose = expose ?? status < 500;
    if (cause !== undefined) this.cause = cause;
  }
}

function defaultCode(status) {
  switch (status) {
    case 400: return 'BAD_REQUEST';
    case 401: return 'UNAUTHORIZED';
    case 403: return 'FORBIDDEN';
    case 404: return 'NOT_FOUND';
    case 409: return 'CONFLICT';
    case 413: return 'PAYLOAD_TOO_LARGE';
    case 422: return 'UNPROCESSABLE';
    case 429: return 'RATE_LIMITED';
    case 503: return 'UNAVAILABLE';
    case 504: return 'TIMEOUT';
    default: return status >= 500 ? 'INTERNAL_ERROR' : 'ERROR';
  }
}

export const badRequest = (message, details) => new HttpError(400, message, { details });
export const unauthorized = (message = 'authentication required', details) =>
  new HttpError(401, message, { details });
export const forbidden = (message = 'forbidden', details) => new HttpError(403, message, { details });
export const notFound = (message = 'not found', details) => new HttpError(404, message, { details });
export const conflict = (message, details) => new HttpError(409, message, { details });
export const rateLimited = (message = 'too many requests', details) =>
  new HttpError(429, message, { details });
export const unavailable = (message = 'service unavailable', details) =>
  new HttpError(503, message, { details });

/**
 * Shape any thrown value into a client-safe response body.
 * @param {unknown} error
 */
export function toErrorResponse(error) {
  const isHttp = error instanceof HttpError;
  const status = isHttp ? error.status : statusFromUnknown(error);
  const expose = isHttp && error.expose;

  const body = {
    error: {
      code: isHttp ? error.code : defaultCode(status),
      message: expose && error?.message
        ? error.message
        : status >= 500 ? 'internal server error' : 'bad request',
    },
  };
  if (isHttp && error.details !== undefined) body.error.details = error.details;

  return { status, body };
}

/** Recognise the few non-HttpError shapes Express/JSON parsing can produce. */
function statusFromUnknown(error) {
  const status = error?.status ?? error?.statusCode;
  if (Number.isInteger(status) && status >= 400 && status <= 599) return status;
  if (error?.type === 'entity.too.large') return 413;
  if (error instanceof SyntaxError && 'body' in (error ?? {})) return 400;
  return 500;
}

export default HttpError;
