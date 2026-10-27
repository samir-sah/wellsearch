# WellSearch architecture

WellSearch is split into HTTP composition, application services, and two selectable search sources. `SEARCH_SOURCE=wikipedia` is the default and searches live English Wikipedia content. `SEARCH_SOURCE=local` retains the original crawler and persistent index. Both return the same response shape to the Next.js interface.

The frontend uses Montserrat with a white-dominant palette, royal green accents, translucent glass surfaces, and matte controls. Hover and keyboard-focus feedback keep controls clear, while reduced-motion preferences limit decorative movement. Presentation changes do not alter the search API contract.

```text
Frontend
    ↓
REST API
    ↓
Middleware (request id/logging, CORS, auth, rate limits, error envelope)
    ↓
Controllers
    ↓
Services
    ├── Selected search service
    │      ├── Wikipedia OpenSearch title discovery
    │      │      ↓
    │      │   Secured article fetch → Cheerio extraction → weighted BM25
    │      │      ↕
    │      │   Bounded TTL query/article caches
    │      │
    │      └── Local search engine
    │      ↓
    │   Tokenizer / analyzer
    │      ↓
    │   Inverted index ──→ BM25 ──→ Document store ──→ Persistence
    │
    └── Crawl manager
           ↓
        Crawler
           ↓
        URL queue
           ↓
        Fetcher
           ↓
        Document extraction
           ↓
        Index manager
```

## HTTP layer

`src/app.js` creates Express without opening a port, which makes the HTTP contract testable. It applies a short request identifier/logger, exact-origin CORS, JSON body limits, then health, search, and crawl routes. The final error handler turns expected errors into a stable JSON envelope and converts unexpected exceptions to an opaque 500 response.

`src/server.js` owns listening and shutdown. It loads services before accepting requests, applies connection timeouts, stops crawls, closes sockets after a bounded grace period, and flushes the index on `SIGINT` or `SIGTERM`.

The API listens on port 3000 by default. The Next.js frontend runs independently on port 3001 and uses `NEXT_PUBLIC_API_URL` to reach the API. `CORS_ORIGINS` must include the frontend's exact origin. The archive's static HTML/CSS frontend is not used.

## Wikipedia search

The Wikipedia service adapts the supplied codebase's OpenSearch discovery, article extraction, tokenization, and BM25 ranking into the existing search contract. It discovers titles, loads up to eight articles in parallel, extracts useful article text and categories with Cheerio, and computes BM25 using a 3× title weight and a 2× category weight. Article URLs provide stable result identities. Existing result cards consume plain-text fields and safe highlight data rather than rendering upstream HTML.

Query and article caches have a configurable TTL and bounded storage. Concurrent search work is capped. The relevant settings are `WIKIPEDIA_REQUEST_TIMEOUT_MS`, `WIKIPEDIA_CACHE_TTL_MS`, `WIKIPEDIA_MAX_CACHED_ARTICLES`, and `WIKIPEDIA_MAX_CONCURRENT_SEARCHES`. These caches are process memory, not persistent snapshots or a complete Wikipedia index. The service requires outbound network access and is subject to upstream availability.

`GET /api/suggest?q=...` exposes suggestions in a consistent `{ prefix, suggestions }` object. The default source obtains them from Wikipedia OpenSearch. `GET /api/search` uses the source selected when the backend starts; no frontend redesign or initial local crawl is necessary.

Phrase, exclusion, and inline `site:` query parsing remain features of the local engine. Wikipedia title discovery uses the input as a search string; the explicit `site`/`host` parameter can filter its article URLs. Startup readiness does not probe Wikipedia or certify upstream network availability.

## Local search and index

`IndexManager` owns the `DocumentStore`, `InvertedIndex`, analyzer, and persistence lifecycle. Documents are normalised, de-duplicated by canonical URL/content hash, and analysed by field. Weighted title, description, and body terms are stored as posting frequencies; position lists are stored for phrase matching.

`SearchEngine` parses free terms, quoted phrases, exclusions, and host filters. It gathers relevant posting lists, calculates BM25 scores, applies phrase/proximity logic, orders deterministic ties by document id, and produces paginated result records with snippets. The response includes real stage timing and diagnostic values.

Snapshots use documents, index, and stats JSON files. Each file is written to a sibling temporary file and renamed atomically. Startup tolerates an absent snapshot, quarantines corrupt JSON, rebuilds the index from documents when possible, and reconciles torn snapshots.

## Crawling

```text
Seed URLs
   ↓
URL queue (canonicalisation, dedupe, depth/page/host/politeness budgets)
   ↓
Concurrent workers
   ↓
Fetcher (DNS/network policy, pinned socket, timeout, redirect loop, byte cap)
   ↓
Robots cache + HTML parser
   ↓
Index manager
```

The crawler shares one queue across worker loops. It respects robots directives and per-host delay, limits response bytes, treats individual page failures as crawl data, and persists after a completed job. A crawl manager adds request validation, configured ceilings, single-flight execution, and status/history suitable for the REST API.

## Security decisions

Outbound crawl targets are checked before every request and redirect. The policy blocks localhost, metadata hostnames, private IPv4, link-local, shared, reserved, multicast, mapped IPv4, unique-local IPv6, link-local IPv6, documentation, and multicast IPv6 ranges. The fetcher connects to a validated address instead of resolving the hostname again, preventing DNS rebinding between validation and connection while keeping the original host/TLS name.

Production defaults to an empty CORS allowlist and a disabled crawl API. Enabling public crawl writes requires a strong admin token. Rate limits are endpoint-specific and bounded in memory; deployments with multiple processes need an upstream shared limiter.

Wikipedia fetching uses the same native fetcher and network policy as the crawler, keeping redirect validation, DNS pinning, deadlines, and response limits. The imported server's permissive CORS, Axios path, static UI, and deployment keepalive behavior are not carried over. License attribution for the adapted code is in `THIRD_PARTY_NOTICES.md`.
