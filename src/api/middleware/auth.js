/**
 * Admin authentication for the write endpoints.
 *
 * `ADMIN_TOKEN` is read from the environment (never hard-coded, never logged,
 * never returned by /api/stats - only the boolean "is one set"). When it is
 * empty the write endpoints stay open, which is what you want on localhost and
 * is not what you want on a public URL, so:
 *
 *   - production configuration rejects an enabled crawl API without a strong token
 *   - the comparison is constant-time, so the token cannot be recovered by
 *     timing the response
 *
 * Accepted forms: `Authorization: Bearer <token>` or `X-Admin-Token: <token>`.
 */

import { timingSafeEqual } from 'node:crypto';
import { unauthorized } from '../../utils/errors.js';

export function createAdminAuth({ config, logger }) {
  const expected = config.api.adminToken;

  return function adminAuth(request, response, next) {
    if (!expected) {
      // Open mode: no token configured. Flag it on the response so a deployment
      // that forgot to set one can be spotted from the outside.
      response.setHeader('X-Admin-Auth', 'disabled');
      next();
      return;
    }

    const provided = readToken(request);
    if (!provided || !safeEqual(provided, expected)) {
      logger?.warn('admin authentication failed', {
        path: request.originalUrl,
        ip: request.ip,
        provided: provided ? 'invalid' : 'missing',
      });
      next(unauthorized('a valid admin token is required for this endpoint', {
        header: 'Authorization: Bearer <ADMIN_TOKEN>',
      }));
      return;
    }

    request.isAdmin = true;
    next();
  };
}

function readToken(request) {
  const header = request.get('authorization');
  if (header) {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  const custom = request.get('x-admin-token');
  return custom ? custom.trim() : null;
}

/** Constant-time comparison that tolerates different lengths. */
function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) {
    // Still burn a comparison so length is not learnable from timing alone.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export default createAdminAuth;
