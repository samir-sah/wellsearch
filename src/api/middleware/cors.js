const ALLOWED_METHODS = 'GET,HEAD,OPTIONS';
const ALLOWED_HEADERS = 'Content-Type,Accept';

/** Restrictive CORS for the browser search frontend. */
export function createCors({ config }) {
  const allowedOrigins = new Set(config.corsOrigins);

  return function cors(request, response, next) {
    const origin = request.get('origin');
    if (!origin) return next();

    if (allowedOrigins.has(origin)) {
      response.set('Access-Control-Allow-Origin', origin);
      response.set('Vary', 'Origin');
      response.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
      response.set('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      response.set('Access-Control-Max-Age', '600');

      if (request.method === 'OPTIONS') return response.sendStatus(204);
    }

    return next();
  };
}

export default createCors;
