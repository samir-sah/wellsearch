# NixSearch

NixSearch searches English Wikipedia in real time while keeping its existing Next.js interface. Its default search pipeline adapts the article discovery, extraction, tokenization, and BM25 approach from the supplied `Wikipedia_Search_Engine-main` codebase. The original crawler and persistent local index remain available through `SEARCH_SOURCE=local`.

## Features

- Live Wikipedia article discovery with OpenSearch suggestions, parallel article extraction, and title/category-weighted BM25 ranking.
- Bounded, expiring in-memory caches for Wikipedia queries and articles; no initial crawl is needed for the default search mode.
- An optional local search mode with concurrent, polite web crawling, URL canonicalisation, robots.txt support, per-host limits, and retry handling.
- SSRF-resistant fetching: local, private, link-local, metadata, mapped IPv4, and special IPv6 destinations are blocked; redirects are revalidated and sockets are pinned to validated DNS answers.
- Stemming, stop-word handling, snippets, highlighting, and pagination; the local index also supports quoted phrases, exclusions, and host filters.
- Atomic JSON persistence for the local index with recovery from missing, corrupt, or torn snapshots.
- A responsive Next.js interface with keyboard-friendly search, loading/error/no-result states, and safe external result links.
- Restricted exact-origin CORS, request/body limits, admin authentication for crawl writes, rate limiting, structured logging, and graceful shutdown.

## Architecture

```text
Next.js frontend -> REST API -> middleware -> controllers -> selected search service
                                                        -> Wikipedia OpenSearch -> articles -> BM25
                                                        -> local search engine -> persisted index -> BM25

Crawler -> URL queue -> pinned fetcher -> parser -> index manager
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and [docs/WIKIPEDIA_MIGRATION.md](docs/WIKIPEDIA_MIGRATION.md) for the migration decisions.

## Tech stack

- Node.js 18.17+ and Express 4
- Native Node HTTP(S), filesystem, DNS, test runner, and Web APIs; Cheerio for Wikipedia HTML extraction
- Next.js, React, TypeScript, Tailwind CSS, Vitest, and Testing Library

## How search works

With the default `SEARCH_SOURCE=wikipedia`, a search first discovers article titles through the English Wikipedia OpenSearch API. Up to eight articles are fetched in parallel, cleaned of navigation and other page furniture, and ranked using BM25. Title terms receive a 3× weight and category terms receive a 2× weight. Results are adapted to NixSearch's existing API response, so the frontend retains its current layout, styling, and interactions. Wikipedia availability and outbound internet access affect this mode.

With `SEARCH_SOURCE=local`, fetched documents are normalised into an inverted index with weighted title, description, and body frequencies. Stored positions support quoted phrases and proximity boosting. Search retrieves posting lists, applies BM25 and query constraints, then creates plain-text snippets and safe highlights. The crawler extracts title, description, text, links, canonical URLs, and robots directives. Index snapshots use temporary files and atomic rename; startup can rebuild from stored documents if needed.

## Local development

Requirements: Node.js 18.17 or newer and npm.

```bash
npm ci
npm --prefix frontend ci
Copy-Item .env.example .env
Copy-Item frontend/.env.example frontend/.env.local

# terminal 1
npm start

# terminal 2
npm --prefix frontend run dev
```

Open `http://localhost:3001`. The frontend and API are separate processes: the frontend runs on port 3001 and calls the backend on port 3000. Searches use Wikipedia immediately with the default configuration.

To use the original crawler-backed engine, set `SEARCH_SOURCE=local` in `.env`, restart the backend, then populate its index through the crawl API. Do not enable this endpoint publicly without an admin token.

```bash
curl -X POST http://localhost:3000/api/crawl \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://example.com/"],"maxPages":10,"maxDepth":1}'
```

Poll `GET /api/crawl/status` for a background crawl, or pass `"wait": true` for a bounded synchronous response.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Service, index, crawler, and memory status. |
| `GET /api/health/live` | Lightweight process liveness check. |
| `GET /api/health/ready` | Startup readiness check; does not probe Wikipedia availability. |
| `GET /api/search?q=BM25&limit=10` | Ranked search from the selected source. Supports `page`, `site`/`host`, and `explain`; local query operators are described below. |
| `GET /api/suggest?q=search` | Autocomplete suggestions as `{ "prefix": "search", "suggestions": [...] }`. Uses Wikipedia OpenSearch in the default mode. |
| `POST /api/crawl` | Start a crawl when enabled. Requires `Authorization: Bearer <ADMIN_TOKEN>` or `X-Admin-Token` when a token is configured. |
| `GET /api/crawl/status` | Crawl progress and recent history. |
| `POST /api/crawl/stop` | Stop an active crawl; same authentication rules as start. |
| `GET /api/stats` | Runtime and index statistics. |
| `GET /api/config` | Non-secret effective configuration. |

Example Wikipedia search:

```bash
curl "http://localhost:3000/api/search?q=information%20retrieval&limit=10"
```

Example advanced local-index search with `SEARCH_SOURCE=local`:

```bash
curl "http://localhost:3000/api/search?q=%22web%20crawler%22%20-site%3Aexample.com&limit=10"
```

Quoted phrases, exclusions, and inline `site:` syntax belong to the local engine. Wikipedia mode uses the input to discover article titles; its explicit `site`/`host` parameter filters selected article URLs.

All API errors use a JSON envelope: `{ "error": { "code", "message", "requestId" } }`. Internal error details and stacks are not exposed.

## Environment variables

Copy [`.env.example`](.env.example) and adjust only what the deployment needs. Important settings are:

- `NODE_ENV`, `HOST`, `PORT`, `CORS_ORIGINS`, and `DATA_DIR`
- `SEARCH_SOURCE` (`wikipedia` by default, or `local`)
- `WIKIPEDIA_REQUEST_TIMEOUT_MS` (3500), `WIKIPEDIA_CACHE_TTL_MS` (300000), `WIKIPEDIA_MAX_CACHED_ARTICLES` (250), and `WIKIPEDIA_MAX_CONCURRENT_SEARCHES` (4)
- `CRAWLER_CONCURRENCY`, `MAX_PAGES`, `MAX_DEPTH`, `REQUEST_TIMEOUT`, `MAX_CONTENT_BYTES`, and `MAX_REDIRECTS`
- `BM25_K1`, `BM25_B`, field weights, and search limits
- `CRAWL_API_ENABLED` and `ADMIN_TOKEN`
- `RATE_LIMIT_WINDOW_MS`, `SEARCH_RATE_LIMIT`, `CRAWL_RATE_LIMIT`, and `BODY_LIMIT`

`CORS_ORIGINS` accepts exact comma-separated origins only. In production crawl writes are disabled by default; enabling them requires an `ADMIN_TOKEN` of at least 32 characters. `ALLOW_PRIVATE_NETWORK` is honoured only in test mode, never in development or production.

Set `NEXT_PUBLIC_API_URL` in `frontend/.env.local` (or the frontend build environment) to the backend's public URL, without a trailing slash. Add the frontend's exact origin to backend `CORS_ORIGINS`. Wikipedia caches live only in the backend process and expire or disappear on restart; `DATA_DIR` stores the optional local index, not a permanent Wikipedia mirror.

## Testing and quality checks

```bash
npm test
npm --prefix frontend test
npm --prefix frontend run lint
npm --prefix frontend run typecheck
npm --prefix frontend run build

# convenience command for the full automated suite
npm run validate
```

The backend suite covers API contracts, error envelopes, CORS, authentication, crawl/index/search/persistence restart flow, graceful shutdown, and SSRF controls. Local-index tests select `SEARCH_SOURCE=local` explicitly. The frontend suite covers the search interaction and API error handling. These commands are verification instructions, not a claim that they have passed in every environment.

## Security

Outbound fetching validates every target and redirect, rejects non-public network ranges by default, and uses the exact DNS answers it validated for outbound sockets. Wikipedia requests use this secured native fetch path. Search and crawl endpoints have separate fixed-window limits. Crawl writes can be disabled and protected with a constant-time token comparison. Browser responses are CORS-restricted, request payloads are capped, generated HTML is not injected into the React UI, and API failures are client-safe.

This is a single-process application. Its in-memory limiter is therefore per instance; use a shared edge or rate-limit service when deploying multiple replicas.

## Deployment

Install from lockfiles with `npm ci` in the repository and frontend directories. Configure production values for at least `NODE_ENV=production`, `SEARCH_SOURCE`, `CORS_ORIGINS`, and `NEXT_PUBLIC_API_URL`. A persistent writable `DATA_DIR` is needed when retaining the local index. Build the UI with `npm --prefix frontend run build`; run the backend with `npm start` and the UI with `npm --prefix frontend start`. Route public traffic to both services as appropriate; the backend does not serve a replacement static frontend.

Wikipedia mode requires outbound HTTPS access to `en.wikipedia.org`. No self-pinging or hosting keepalive loop is installed. Deploy health probes using the platform's normal liveness and readiness features.

Probe `/api/health/live` for liveness and `/api/health/ready` for startup readiness. Readiness does not make a network request or guarantee Wikipedia is reachable. Send `SIGINT` or `SIGTERM` for graceful crawler stop and index flushing.

## Performance

Local-index search uses posting lists. Wikipedia search includes upstream discovery and article downloads, with faster repeat requests when caches are warm. The API returns measured request timing in `took` and `timings`; crawl summaries return throughput and persistence statistics. These figures vary by corpus, disk, network, and host. The existing local-index baseline and method are recorded in `docs/PERFORMANCE.md`; they do not establish Wikipedia latency.

## Limitations and future work

- Persistence is a local JSON snapshot, suitable for a single instance rather than distributed indexing.
- Wikipedia search covers English Wikipedia candidates returned by OpenSearch, not the whole web or the entire Wikipedia corpus in one ranking pass. Upstream outages, page markup changes, and rate limits can affect results.
- Crawling is intentionally conservative and does not execute JavaScript-rendered pages.
- The crawler has no sitemap ingestion, recrawl scheduler, or distributed queue.
- Ranking is lexical BM25; it does not use semantic/vector retrieval or personalised ranking.

Potential future work includes a durable shared store, recrawl scheduling, sitemap support, larger-corpus evaluation, and optional semantic retrieval—only after their operational requirements are designed and tested.

The adapted Wikipedia code is MIT licensed; its original attribution is retained in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Wikipedia article content remains subject to Wikipedia's own terms and attribution requirements.
