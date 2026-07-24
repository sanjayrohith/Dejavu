# Experiment 05 — RESULT (local, wrangler-dev)

- run timestamp: 2026-05-18T17:10:16.088Z
- brain endpoint: `http://127.0.0.1:8875`  (http)
- prototype: real Cloudflare Worker + Durable Object — local `wrangler dev`, DO uses `ctx.storage.sql`.
- worker build tag: `unknown`
- FTS mode: **fts5**
- reset endpoint at run start: disabled
- /reset action: not requested
- lastId observed at start (after optional reset): 0
- lastId observed after warm-up (3 req): 3

## Test 1 — same-client read-after-write

- receipt id: `4`  ulid: `mem_b40527d2b9a5c429cd017f6af56c94a2`  durable: `do-sql:fts5`
- recalled own write: **true**  (1 hits)

## Test 2 — receipt → *different* client recall

- receipt id: `5`  ulid: `mem_42eef3ce9f815dc3a99d4bcce07a3c40`
- second client saw the write: **true**  (1 hits)

## Test 3 — concurrency (N=64)

- writers: 64  errors: 0
- unique ulids: true  unique ids: true
- contiguous id range: true  starts at base+1: true
- id range: [6, 69]
- texts missing from recall: 0
- write latency under load: p50=41.88ms  p95=52.38ms  p99=52.44ms  max=52.44ms
- burst wall-time: 54.33ms

## Test 4 — latency (light load, sequential, M=50)

- **remember**: mean=1.60ms  p50=1.53ms  p95=2.26ms  p99=2.40ms
- **recall**:   mean=1.35ms  p50=1.29ms  p95=1.98ms  p99=2.30ms
- **e2e**:      mean=2.94ms  p50=2.86ms  p95=3.68ms  p99=3.80ms
- read-after-write losses in light-load loop: 0 (must be 0)

## Interpretation

The DO is the only authority and DO execution is single-threaded, so every
`remember` `INSERT ... RETURNING id` commits before the response leaves the
DO. A subsequent `recall` — whether issued by the same client (test 1) or
by an unrelated fetch caller (test 2) — hits the same DO and sees the row.
There is no replication lag because there is exactly one place memory lives.

Concurrency holds for the same reason: 64 parallel POSTs to
`/remember` are serialized by the DO's input gate and committed one at a time
by SQLite. Ids come back contiguous and ulids unique, with no missing payloads
on recall.

Latency numbers above are local `wrangler dev` — workerd in-process. Useful as a floor; real CF numbers come from a `--mode remote` run against a deployed URL.

FTS5 status: **fts5**. DO SQL accepted `CREATE VIRTUAL TABLE ... USING fts5(...)` and answered a MATCH query.

## Honest limitations of this prototype

- One DO id only (`idFromName("singleton")`). Sharding / placement / cold-start across many DOs are not modeled.
- Test 3's "burst" is bounded by the harness host's outbound HTTP concurrency, not by the DO itself.
- Local `wrangler dev` is not a Cloudflare durability proof. Numbers will differ on real CF; the *contract* should not.
- Ulid is `crypto.getRandomValues`-based, not time-sortable. Matches the rest of the series; not production-grade.
- No auth, no quotas, no eviction, no embeddings.
