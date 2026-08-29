# NixSearch

NixSearch is a small web search engine built around its own crawler, document store, inverted index, and BM25 ranking pipeline. The browser UI talks to the same REST API used by the automated integration tests.

## Features

- Concurrent, polite web crawling with URL canonicalisation, robots.txt support, per-host limits, and retry handling.
- SSRF-resistant fetching: local, private, link-local, metadata, mapped IPv4, and special IPv6 destinations are blocked; redirects are revalidated and sockets are pinned to validated DNS answers.
- Field-weighted BM25 search, stemming, stop-word handling, phrase matching, exclusions, host filters, snippets, highlighting, pagination, and suggestions.
- Atomic JSON persistence with recovery from missing, corrupt, or torn index snapshots.
- A responsive Next.js interface with keyboard-friendly search, loading/error/no-result states, and safe external result links.
- Restricted exact-origin CORS, request/body limits, admin authentication for crawl writes, rate limiting, structured logging, and graceful shutdown.

## Architecture

```text
Next.js frontend -> REST API -> middleware -> controllers -> services
                                                        -> search engine -> analyzer -> inverted index -> BM25
                                                        -> document store -> atomic persistence

Crawler -> URL queue -> pinned fetcher -> parser -> index manager
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the detailed design.

## Tech stack

- Node.js 18.17+ and Express 4
- Native Node HTTP(S), filesystem, DNS, test runner, and Web APIs
- Next.js, React, TypeScript, Tailwind CSS, Vitest, and Testing Library

## How search works

Each fetched document is normalised and analysed into terms. Terms are held in an inverted index with weighted title, description, and body frequencies; positions support quoted phrases and proximity boosting. At query time, NixSearch retrieves only the relevant posting lists, applies BM25, filters phrase/exclusion/host constraints, then builds plain-text snippets and safe highlights.

The crawler parses HTML into title, description, text, links, canonical URLs, and robots directives. Index snapshots are written with a temporary file followed by rename; startup can rebuild from stored documents if the index is unavailable.

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

Open `http://localhost:3001`. The development frontend defaults to `http://localhost:3000` for its API.

To crawl a site locally, use the API. Do not enable this endpoint publicly without an admin token.

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
| `GET /api/health/ready` | Index-load readiness check. |
| `GET /api/search?q=BM25&limit=10` | Ranked search. Supports `page`, `site`/`host`, and `explain`. |
| `POST /api/crawl` | Start a crawl when enabled. Requires `Authorization: Bearer <ADMIN_TOKEN>` or `X-Admin-Token` when a token is configured. |
| `GET /api/crawl/status` | Crawl progress and recent history. |
| `POST /api/crawl/stop` | Stop an active crawl; same authentication rules as start. |
| `GET /api/stats` | Runtime and index statistics. |
| `GET /api/config` | Non-secret effective configuration. |

Example search:

```bash
curl "http://localhost:3000/api/search?q=%22web%20crawler%22%20-site%3Aexample.com&limit=10"
```

All API errors use a JSON envelope: `{ "error": { "code", "message", "requestId" } }`. Internal error details and stacks are not exposed.

## Environment variables

Copy [`.env.example`](.env.example) and adjust only what the deployment needs. Important settings are:

- `NODE_ENV`, `HOST`, `PORT`, `CORS_ORIGINS`, and `DATA_DIR`
- `CRAWLER_CONCURRENCY`, `MAX_PAGES`, `MAX_DEPTH`, `REQUEST_TIMEOUT`, `MAX_CONTENT_BYTES`, and `MAX_REDIRECTS`
- `BM25_K1`, `BM25_B`, field weights, and search limits
- `CRAWL_API_ENABLED` and `ADMIN_TOKEN`
- `RATE_LIMIT_WINDOW_MS`, `SEARCH_RATE_LIMIT`, `CRAWL_RATE_LIMIT`, and `BODY_LIMIT`

`CORS_ORIGINS` accepts exact comma-separated origins only. In production crawl writes are disabled by default; enabling them requires an `ADMIN_TOKEN` of at least 32 characters. `ALLOW_PRIVATE_NETWORK` is honoured only in test mode, never in development or production.

Set `NEXT_PUBLIC_API_URL` in `frontend/.env.local` (or deployment environment) to the backend’s public URL, without a trailing slash.

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

The backend suite covers API contracts, error envelopes, CORS, authentication, crawl/index/search/persistence restart flow, graceful shutdown, and SSRF controls. The frontend suite covers the search interaction and API error handling.

## Security

The crawler validates every target and redirect, rejects non-public network ranges by default, and uses the exact DNS answers it validated for outbound sockets. Search and crawl endpoints have separate fixed-window limits. Crawl writes can be disabled and protected with a constant-time token comparison. Browser responses are CORS-restricted, request payloads are capped, generated HTML is not injected into the React UI, and API failures are client-safe.

This is a single-process application. Its in-memory limiter is therefore per instance; use a shared edge or rate-limit service when deploying multiple replicas.

## Deployment

Install from lockfiles with `npm ci` in the repository and frontend directories. Configure production values for at least `NODE_ENV=production`, `CORS_ORIGINS`, `NEXT_PUBLIC_API_URL`, and a persistent writable `DATA_DIR`. Build the UI with `npm --prefix frontend run build`; run the backend with `npm start` and the UI with `npm --prefix frontend start`.

Probe `/api/health/live` for liveness and `/api/health/ready` for readiness. Send `SIGINT` or `SIGTERM` for graceful crawler stop and index flushing.

## Performance

Search work is posting-list based rather than corpus-scan based. The API returns per-request measured timing in `took` and `timings`; crawl summaries return real throughput and persistence statistics. These figures vary by corpus, disk, network, and host, so NixSearch intentionally does not make universal speed claims. The release audit records its local baseline and method in `docs/PERFORMANCE.md`.

## Limitations and future work

- Persistence is a local JSON snapshot, suitable for a single instance rather than distributed indexing.
- Crawling is intentionally conservative and does not execute JavaScript-rendered pages.
- The crawler has no sitemap ingestion, recrawl scheduler, or distributed queue.
- Ranking is lexical BM25; it does not use semantic/vector retrieval or personalised ranking.

Potential future work includes a durable shared store, recrawl scheduling, sitemap support, larger-corpus evaluation, and optional semantic retrieval—only after their operational requirements are designed and tested.
