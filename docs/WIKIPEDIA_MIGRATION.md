# Wikipedia codebase migration

The supplied `Wikipedia_Search_Engine-main (1).zip` is the reference for WellSearch's default Wikipedia search pipeline. Its README and comments describe the source project; they are not operational instructions for this repository.

## What changed

WellSearch defaults to `SEARCH_SOURCE=wikipedia`. Search now obtains up to eight English Wikipedia candidates, plain-text lead extracts, canonical URLs, and visible categories in one MediaWiki `action=query` request using `generator=prefixsearch`. It retains up to 4,000 characters and 20 categories per article and ranks those candidates with BM25. The adapted ranking uses 3× title and 2× category weights, tokenization, stop-word removal, and stemming from the reference approach. Autocomplete still uses the OpenSearch API.

The original integration performed OpenSearch discovery followed by parallel full HTML downloads and Cheerio extraction. The batched request removes those extra downloads and parsing work. Introductory extracts are not identical to the earlier first 4,000 characters of cleaned HTML paragraphs, and prefix-search candidates can differ from OpenSearch candidates. Scores and ordering may therefore change; this is not a claim of identical relevance or complete-article coverage. Legacy `suggest` and `fetchArticle` methods remain for injected clients without the new `searchArticles` method, rather than as an automatic fallback on production errors.

The Wikipedia service maps results into WellSearch's search response. The Next.js frontend remains the interface, with its result cards, navigation, and search interactions. Its current presentation uses a white-dominant background, royal green accents, glass surfaces, matte controls, Montserrat typography, and hover/focus feedback that respects reduced-motion preferences. The archive's `frontend/index.html`, `main.js`, and `style.css` do not replace it.

The original local crawler, document store, index, and persistence remain available with `SEARCH_SOURCE=local`. Existing local data does not need to be deleted or converted. Switch the environment value and restart the backend to select the source. A local index must contain crawled documents before local searches can return results; Wikipedia mode needs no initial crawl.

## Integration choices

| Supplied codebase | WellSearch integration |
| --- | --- |
| OpenSearch title lookup and HTML article extraction | Replaced in the default search path by one batched MediaWiki query for candidates, lead extracts, categories, and URLs; OpenSearch remains for autocomplete |
| BM25 with title/category weighting | Adapted ranking and tokenizer modules |
| Axios outbound requests | Existing native secured fetcher, including DNS and redirect validation |
| Reused in-memory article collection | Expiring, bounded query and article caches with query-specific BM25 index reuse and controlled concurrency; separate short browser response cache |
| Standalone Express server and static frontend | Existing API middleware/controllers plus the existing Next.js frontend |
| Autocomplete route | `GET /api/suggest?q=...`, returning `{ prefix, suggestions }` |
| Hosting keepalive behavior | No self-pinging process; use deployment health probes |

The backend retains request IDs, exact-origin CORS, endpoint rate limits, bounded request bodies, consistent error envelopes, and protected crawl writes. MediaWiki JSON is validated on the server and upstream HTML is not injected into React as arbitrary markup. The secured fetcher still validates origins and DNS answers and enforces request deadlines and response byte limits.

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

Wikipedia mode needs outbound HTTPS access to `en.wikipedia.org`. Server caches are per-process and disappear on restart. Server query keys normalize whitespace and case; cached corpora retain their own BM25 indexes. The frontend additionally caches up to 30 completed successful responses for 30 seconds by trimmed query, excluding errors, aborted requests, and responses with warnings. The optional local index continues to use `DATA_DIR`; deployment storage requirements for that index are unchanged.

## Scope and verification

This is a lexical search over lead extracts from a small candidate set from English Wikipedia, not a complete Wikipedia mirror. Relevant body-only terms can be missed. Availability, upstream throttling, network latency, and API changes can affect it. Quoted phrases, exclusions, and inline `site:` operators remain local-engine syntax. Wikipedia mode accepts an explicit `site`/`host` query parameter to filter selected article URLs. Local performance baselines do not establish live Wikipedia latency. Readiness checks confirm backend startup rather than upstream connectivity.

Run the repository's backend tests and frontend tests, lint, typecheck, and build with `npm run validate`. Tests for crawler-backed behavior select `SEARCH_SOURCE=local` explicitly; Wikipedia integration uses controlled upstream fixtures for deterministic checks. For a separate live HTTP benchmark, run `node scripts/benchmark-wikipedia.js` where Wikipedia is accessible. It starts an ephemeral local API and performs a cold and warm search for each sample query; it is not run by `npm test`. See [PERFORMANCE.md](PERFORMANCE.md) for measured results and the limitations of the comparison. This document does not assert an automated verification outcome.

The supplied project's MIT notice is retained verbatim in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). Its copyright placeholder is preserved exactly as provided. Wikipedia content is separately governed by Wikipedia's terms and attribution requirements.
