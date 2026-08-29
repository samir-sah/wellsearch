/**
 * Centralised error handling.
 *
 * Two rules:
 *   1. Every error leaves through here, in one JSON envelope, so a client never
 *      has to parse an HTML stack trace.
 *   2. Only `HttpError` messages are shown to clients. Anything else is a bug:
 *      logged in full server-side, reported as a generic 500. Internal paths,
 *      SQL, stack traces and file names never cross the wire in any environment.
 *
 * The handler is deliberately defensive - a failure while reporting a failure
 * (e.g. headers already sent by a partially streamed response) must not take
 * the process down.
 */

import { HttpError, toErrorResponse } from '../../utils/errors.js';

/** 404 for unmatched API routes. Must be mounted after all routes. */
export function notFoundHandler(request, response, next) {
  next(new HttpError(404, `no route for ${request.method} ${request.path}`, {
    code: 'NOT_FOUND',
  }));
}

/**
 * @param {{ logger: object }} options
 * @returns {import('express').ErrorRequestHandler}
 */
export function createErrorHandler({ logger }) {
  const log = logger.child({ module: 'http' });

  return function errorHandler(error, request, response, next) {
    const { status, body } = toErrorResponse(error);

    // Attach the request id so a user-visible error can be matched to a log line.
    if (request.id) body.error.requestId = request.id;

    const fields = {
      method: request.method,
      path: request.originalUrl,
      status,
      requestId: request.id,
      error,
    };
    if (status >= 500) log.error('request failed', fields);
    else log.warn('request rejected', fields);

    if (response.headersSent) {
      // Too late for JSON; the client will see a truncated body. Just close.
      response.destroy?.();
      return;
    }

    try {
      response.status(status).json(body);
    } catch {
      next?.(error);
    }
  };
}

export default createErrorHandler;
