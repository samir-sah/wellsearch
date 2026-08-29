/**
 * Small async helpers shared by the crawler.
 */

/**
 * Promise-based delay that can be cancelled by an AbortSignal.
 * The timer is unref'd so a pending sleep never keeps the process alive.
 */
export function sleep(ms, signal) {
  if (!(ms > 0)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** Yield to the event loop so a long synchronous batch cannot starve the server. */
export function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

export default sleep;
