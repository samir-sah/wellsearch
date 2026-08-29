# Performance baseline

The release baseline is intentionally local and reproducible, not a comparison with other search engines. It uses a three-document in-memory corpus indexed through the production `IndexManager`, then performs 1,000 production `SearchEngine.search("distributed systems")` calls after a short warm-up. The recorded values are added during the final release audit alongside the host/runtime used.

## Release audit baseline

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
