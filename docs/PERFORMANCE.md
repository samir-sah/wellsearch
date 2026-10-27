# Search performance

Live Wikipedia retrieval and local-index search have different costs. The Wikipedia measurements below include network requests; the historical local baseline later in this document uses an in-memory corpus and does not establish live Wikipedia latency. Neither is a comparison with other search engines or a production latency guarantee.

## Live Wikipedia comparison — October 28, 2026

Runtime: Node.js v22.15.0 on Windows (`win32`, `x64`). Each query was searched once with an uncached corpus and immediately repeated against the same process. All six requests in each sample returned HTTP 200, with 7–8 results and no warnings.

The earlier production path performed an OpenSearch lookup followed by up to eight parallel HTML article downloads. Its first searches spent over 99% of server time retrieving and extracting upstream content. The new default performs one MediaWiki query for candidates, lead extracts, categories, and canonical URLs. Server caches also reuse the query-specific BM25 index.

| Query | Previous cold HTTP | Batched cold HTTP | Batched warm HTTP | Upstream requests, cold / warm | Upstream bytes, cold |
| --- | ---: | ---: | ---: | ---: | ---: |
| Quantum computing | 1,795.91 ms | 606.81 ms | 16.04 ms | 1 / 0 | 11,455 |
| Renaissance art | 2,566.08 ms | 676.67 ms | 3.98 ms | 1 / 0 | 15,817 |
| Neuroscience | 2,231.62 ms | 825.34 ms | 3.52 ms | 1 / 0 | 17,643 |

Average cold HTTP latency in this sample fell from 2,197.87 ms to 702.94 ms, about 68% lower. Previous warm HTTP times were 12.74 ms, 7.32 ms, and 7.54 ms respectively. These were separate sequential measurements, with different Wikipedia and network cache conditions; the sample is indicative and does not isolate every cause of the improvement. One warm sample was slower despite less server work, illustrating why individual wall-clock measurements should not be treated as guarantees.

The optimized API reported these internal times:

| Query | Cold server total | Cold retrieval | Warm server total | Results |
| --- | ---: | ---: | ---: | ---: |
| Quantum computing | 560.41 ms | 555.01 ms | 0.66 ms | 7 |
| Renaissance art | 672.60 ms | 669.77 ms | 0.58 ms | 8 |
| Neuroscience | 820.60 ms | 818.01 ms | 0.61 ms | 8 |

An additional profile of the earlier path for “Ancient Rome” made nine upstream requests, downloaded 4,234,155 bytes, and took 2,303.08 ms: 548.71 ms for discovery followed by 1,754.39 ms for parallel HTML fetching and extraction. Only 27,039 content characters were retained. This separate diagnostic explains the wasted download and parsing work; it is not a matched before/after result for that query.

### Method and reproduction

Run the opt-in benchmark from the repository root:

```bash
node scripts/benchmark-wikipedia.js

# Optional custom queries
node scripts/benchmark-wikipedia.js "Quantum computing" "Renaissance art"
```

The script builds the production service and HTTP app with Wikipedia selected, index loading disabled, and a fresh in-memory cache. It listens on an ephemeral loopback port and uses real HTTP requests to the API, which in turn contacts live English Wikipedia through the secured fetcher. It prints JSON per cold/warm request, including client wall time, API stage timings, upstream request/byte deltas, result count, warnings, and errors, then closes the server and services. It does not write or replace the local index. The script is separate from `npm test` and requires outbound HTTPS and loopback network access.

The previous baseline was collected from the running local backend before the optimization, using the same three queries once followed by an immediate repeat. The new measurements used the benchmark script. API timings cover backend work, while HTTP wall time includes the local connection, response transfer, and client parsing. Upstream bytes are response-body bytes reported by the fetcher, excluding transport overhead. The browser's response cache is bypassed in these measurements.

MediaWiki's [prefix-search generator](https://www.mediawiki.org/wiki/API:Prefixsearch), [TextExtracts](https://www.mediawiki.org/wiki/Extension:TextExtracts), [categories](https://www.mediawiki.org/wiki/API:Categories), and [page information](https://www.mediawiki.org/wiki/API:Info) provide the batched response. The client retains up to eight candidates, 4,000 characters of each introductory extract, and 20 visible categories. Lead extracts and prefix-search candidates can differ from the earlier first 4,000 characters of cleaned HTML paragraphs and OpenSearch candidates. Equal result counts do not establish equal scores, ordering, or relevance; body-only matches can be lost. Ranking quality needs a separate judged-query evaluation.

The backend uses bounded TTL query/article caches, normalizes whitespace and case in query keys, and shares simultaneous retrievals for the same key. Each corpus retains its own BM25 index. The frontend separately keeps up to 30 completed responses for 30 seconds, excluding errors, aborted requests, and responses with warnings. Warm browser reuse avoids an API request altogether, but this cache does not remove the cost of a new query or guarantee upstream availability.

## Historical local-index release baseline

This local baseline uses a three-document in-memory corpus indexed through the production `IndexManager`, then performs 1,000 production `SearchEngine.search("distributed systems")` calls after a short warm-up. It does not include Wikipedia requests, HTTP transfer, or browser rendering.

- **Runtime**: Node.js v22.15.0 (`win32` `x64`)
- **CPU**: AMD Ryzen 5 5600H with Radeon Graphics (12 logical cores)
- **Iterations**: 1,000 queries (`"distributed systems"`)
- **Corpus**: 3 documents indexed via `IndexManager`

| Metric | Result |
| --- | --- |
| Total duration | 63.16 ms |
| Throughput | ~15,833 QPS |
| Average latency | 0.058 ms |
| p50 latency | 0.049 ms |
| p95 latency | 0.089 ms |
| p99 latency | 0.222 ms |
| Max latency | 0.327 ms |

Crawl throughput is reported per real crawl in the `summary.throughput` object. Persistence duration and byte counts are reported by `IndexManager.stats()`. These values should be re-measured with the intended corpus and deployment storage before setting service-level objectives.
