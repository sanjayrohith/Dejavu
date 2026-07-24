# Experiment 03 — RESULT

- brain endpoint: `http://127.0.0.1:8883`
- prototype: real Cloudflare Worker + Durable Object running under `wrangler dev` (local), DO uses `ctx.storage.sql`.
- FTS mode: **fts5**

## Test 1 — same-client read-after-write

- receipt id: `1`  ulid: `mem_e40a53de95e01d2ccc21e400253a9f2d`  durable: `do-sql:fts5`
- recalled own write: **true**  (1 hits)

## Test 2 — receipt → *different* client recall

- receipt id: `2`  ulid: `mem_a95629cc7efb2ed7fa9162cc05385e09`
- second client saw the write: **true**  (1 hits)

## Test 3 — concurrency

- writers: 64  errors: 0
- unique ulids: true  unique ids: true
- contiguous id range: true  starts at base+1: true
- id range: [3, 66]
- texts missing from recall: 0
- write latency under load: p50=41.91ms  p95=51.33ms  p99=51.35ms  max=51.35ms
- burst wall-time: 55.52ms

## Test 4 — latency (light load, sequential)

- **remember**: mean=1.84ms  p50=1.73ms  p95=2.37ms  p99=2.83ms
- **recall**:   mean=1.60ms  p50=1.41ms  p95=2.60ms  p99=3.26ms
- **e2e**:      mean=3.44ms  p50=3.28ms  p95=4.42ms  p99=5.14ms

## Interpretation

The DO is the only authority and DO execution is single-threaded, so every `remember`
`INSERT ... RETURNING id` commits before the response leaves the DO. A subsequent
`recall` — whether issued by the same client (test 1) or by an unrelated fetch caller
(test 2) — hits the same DO and sees the row. There is no replication lag because
there is exactly one place memory lives, just like experiment 01 — but this time
the "one place" is a real Durable Object's SQL storage running in workerd.

Concurrency holds for the same reason: 64 parallel POSTs to `/remember` are
serialized by the DO's input gate and committed one at a time by SQLite. Ids come
back contiguous and ulids unique, with no missing payloads on recall.

FTS5 status: **fts5**. Local DO SQL accepted `CREATE VIRTUAL TABLE ... USING fts5(...)` and answered a MATCH query. During the spike, a trigger-only FTS version and an over-aggressive hyphen sanitizer both failed immediate recall before the passing implementation explicitly indexed writes in the DO turn and tokenized queries like FTS5. Real Dejavu can use FTS5 here, but this read-after-write test must stay in CI.

## Honest limitations of this prototype

- One DO id only (`idFromName("singleton")`). Sharding / placement / cold-start are not modeled.
- `wrangler dev` local. No real CF placement, no real DO-storage durability commit path, no real network egress.
- Ulid is `crypto.getRandomValues`-based, not time-sortable. Matches experiment 01's shape; not a production-grade id.
- No auth, no quotas, no eviction, no embeddings.
- Test 3's "burst" is bounded by Node's fetch concurrency, not by the DO. The DO would see more pressure from real Workers in front of it.
