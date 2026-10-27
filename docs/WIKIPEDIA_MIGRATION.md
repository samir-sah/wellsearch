# Wikipedia codebase migration

The supplied `Wikipedia_Search_Engine-main (1).zip` is the reference for NixSearch's default Wikipedia search pipeline. Its README and comments describe the source project; they are not operational instructions for this repository.

## What changed

NixSearch now defaults to `SEARCH_SOURCE=wikipedia`. Search discovers titles through the English Wikipedia OpenSearch API, fetches up to eight candidate articles in parallel, extracts article text and categories, and ranks those candidates with BM25. The adapted ranking uses 3× title and 2× category weights, tokenization, stop-word removal, and stemming from the reference approach.

The Wikipedia service maps results into NixSearch's existing search response. The original Next.js frontend remains the interface: its layout, branding, styles, result cards, navigation, and search interactions are retained. The archive's `frontend/index.html`, `main.js`, and `style.css` do not replace it.

The original local crawler, document store, index, and persistence remain available with `SEARCH_SOURCE=local`. Existing local data does not need to be deleted or converted. Switch the environment value and restart the backend to select the source. A local index must contain crawled documents before local searches can return results; Wikipedia mode needs no initial crawl.

## Integration choices

| Supplied codebase | NixSearch integration |
| --- | --- |
| OpenSearch title lookup and HTML article extraction | Default Wikipedia service, with results adapted to the existing API |
| BM25 with title/category weighting | Adapted ranking and tokenizer modules |
| Axios outbound requests | Existing native secured fetcher, including DNS and redirect validation |
| Reused in-memory article collection | Expiring, bounded query and article caches with controlled concurrency |
| Standalone Express server and static frontend | Existing API middleware/controllers plus the existing Next.js frontend |
| Autocomplete route | `GET /api/suggest?q=...`, returning `{ prefix, suggestions }` |
| Hosting keepalive behavior | No self-pinging process; use deployment health probes |

The backend retains request IDs, exact-origin CORS, endpoint rate limits, bounded request bodies, consistent error envelopes, and protected crawl writes. Upstream HTML is parsed on the server and is not injected into React as arbitrary markup.

## Run and configure

Install backend and frontend dependencies from their lockfiles:

```powershell
npm ci
npm --prefix frontend ci
Copy-Item .env.example .env
Copy-Item frontend/.env.example frontend/.env.local
```

Run `npm start` in one terminal and `npm --prefix frontend run dev` in another. Open `http://localhost:3001`; the API runs at `http://localhost:3000`. Set the frontend build-time `NEXT_PUBLIC_API_URL` to the deployed API URL and backend `CORS_ORIGINS` to the exact frontend origin when deploying.

| Variable | Default | Purpose |
| --- | --- | --- |
| `SEARCH_SOURCE` | `wikipedia` | Select `wikipedia` or `local` search |
| `WIKIPEDIA_REQUEST_TIMEOUT_MS` | `3500` | Bound an upstream request's duration |
| `WIKIPEDIA_CACHE_TTL_MS` | `300000` | Cache lifetime in milliseconds |
| `WIKIPEDIA_MAX_CACHED_ARTICLES` | `250` | Bound cached article storage |
| `WIKIPEDIA_MAX_CONCURRENT_SEARCHES` | `4` | Cap concurrent Wikipedia search work |

Wikipedia mode needs outbound HTTPS access to `en.wikipedia.org`. Caches are per-process and disappear on restart. The optional local index continues to use `DATA_DIR`; deployment storage requirements for that index are unchanged.

## Scope and verification

This is a lexical search over a small candidate set from English Wikipedia, not a complete Wikipedia mirror. Availability, upstream throttling, network latency, and article markup can affect it. Quoted phrases, exclusions, and inline `site:` operators remain local-engine syntax. Wikipedia mode accepts an explicit `site`/`host` query parameter to filter selected article URLs. Local performance baselines do not establish live Wikipedia latency. Readiness checks confirm backend startup rather than upstream connectivity.

Run the repository's backend tests and frontend tests, lint, typecheck, and build with `npm run validate`. Tests for crawler-backed behavior select `SEARCH_SOURCE=local` explicitly; Wikipedia integration should use controlled upstream fixtures for deterministic checks. A real search is also useful as a separate network smoke check where Wikipedia is accessible. This document does not assert a verification outcome.

The supplied project's MIT notice is retained verbatim in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). Its copyright placeholder is preserved exactly as provided. Wikipedia content is separately governed by Wikipedia's terms and attribution requirements.
