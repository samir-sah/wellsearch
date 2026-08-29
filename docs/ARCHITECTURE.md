# NixSearch architecture

NixSearch is deliberately split into HTTP composition, application services, and the two core pipelines: crawling/indexing and search/ranking.

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
    ├── Search engine
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

## Search and index

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
