/**
 * Request logging + a short request id.
 *
 * The id is generated per request and returned in `X-Request-Id`, so a 500 seen
 * by a user can be found in the logs. Health checks are logged at debug level
 * only - a hosting platform hitting /api/health every 30 seconds would
 * otherwise bury everything else.
 *
 * Duration is measured with `process.hrtime.bigint()` on the response 'finish'
 * event, so it is the real time to the last byte, not the time to first handler.
 */

import { randomUUID } from 'node:crypto';

const QUIET_PATHS = new Set(['/api/health', '/api/health/live', '/api/health/ready', '/favicon.ico']);

export function createRequestLogger({ logger }) {
  const log = logger.child({ module: 'http' });

  return function requestLogger(request, response, next) {
    const start = process.hrtime.bigint();
    const requestId = request.get('x-request-id')?.slice(0, 64) || randomUUID().slice(0, 8);
    request.id = requestId;
    response.setHeader('X-Request-Id', requestId);

    response.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const level = response.statusCode >= 500 ? 'error'
        : response.statusCode >= 400 ? 'warn'
          : QUIET_PATHS.has(request.path) ? 'debug' : 'info';

      log[level]('request', {
        requestId,
        method: request.method,
        path: request.originalUrl.length > 200 ? `${request.originalUrl.slice(0, 200)}…` : request.originalUrl,
        status: response.statusCode,
        ms: Math.round(durationMs * 100) / 100,
        bytes: Number(response.getHeader('content-length')) || undefined,
      });
    });

    next();
  };
}

export default createRequestLogger;
