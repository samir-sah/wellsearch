/**
 * Crawl endpoints.
 *
 * `POST /api/crawl` returns as soon as the crawl is *accepted* (202), because a
 * crawl takes seconds to minutes and holding an HTTP request open for it is how
 * you get a gateway timeout and a client that cannot tell "still working" from
 * "died". Progress is polled from `GET /api/crawl/status`.
 *
 * `wait: true` is supported for scripts and tests that do want the summary in
 * the response, bounded by a hard timeout inside the crawl manager.
 */

import { forbidden, badRequest } from '../../utils/errors.js';

export function createCrawlController({ crawlManager, config, logger }) {
  const log = logger.child({ module: 'crawl-api' });

  /** POST /api/crawl */
  async function start(request, response) {
    if (!config.api.crawlEnabled) {
      throw forbidden('the crawl API is disabled on this deployment (CRAWL_API_ENABLED=false)');
    }

    const body = request.body ?? {};
    if (typeof body !== 'object' || Array.isArray(body)) {
      throw badRequest('the request body must be a JSON object');
    }

    const wait = truthy(body.wait ?? request.query.wait);
    const waitMs = body.waitMs === undefined ? undefined : Number(body.waitMs);
    if (waitMs !== undefined && !Number.isFinite(waitMs)) {
      throw badRequest('"waitMs" must be a number of milliseconds');
    }

    const job = await crawlManager.start(body, { wait, ...(waitMs ? { waitMs } : {}) });

    log.info('crawl requested', {
      jobId: job.id,
      seeds: job.options.seeds.length,
      maxPages: job.options.maxPages,
      concurrency: job.options.concurrency,
      wait,
      requestId: request.id,
    });

    const finished = job.state === 'completed' || job.state === 'stopped' || job.state === 'failed';
    response.status(finished ? 200 : 202).json({
      ok: true,
      status: finished ? job.state : 'started',
      message: finished
        ? `crawl ${job.state}: ${job.result?.processed ?? 0} page(s) processed`
        : 'crawl started; poll /api/crawl/status for progress',
      jobId: job.id,
      statusUrl: '/api/crawl/status',
      options: job.options,
      warnings: job.warnings,
      result: job.result ?? null,
      summary: job.summary ?? null,
    });
  }

  /** GET /api/crawl/status */
  function status(request, response) {
    response.set('Cache-Control', 'no-store');
    response.json(crawlManager.status());
  }

  /** POST /api/crawl/stop */
  function stop(request, response) {
    const result = crawlManager.stop();
    log.warn('crawl stop requested', { requestId: request.id, ...result });
    response.status(result.stopped ? 202 : 409).json({
      ok: result.stopped,
      ...result,
      message: result.stopped
        ? 'stop requested; workers will finish their current pages'
        : 'no crawl is running',
    });
  }

  return { start, status, stop };
}

function truthy(value) {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export default createCrawlController;
