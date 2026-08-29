/**
 * Wraps an async route handler so a rejected promise reaches Express's error
 * handler instead of becoming an unhandled rejection.
 *
 * Express 4 does not await handlers, so without this every `await` in a
 * controller is a potential silent 500 with a hanging request. Express 5 does
 * this natively; when this app moves to it, this file simply becomes a no-op.
 */
export function asyncHandler(handler) {
  return function wrapped(request, response, next) {
    try {
      const result = handler(request, response, next);
      if (result && typeof result.then === 'function') result.catch(next);
    } catch (error) {
      next(error);
    }
  };
}

export default asyncHandler;
