# Experiment 05 — RESULT (remote, workers-dev-20260518)

- run timestamp: 2026-05-18T17:12:49.309Z
- brain endpoint: `https://dejavu-exp05-deployed-do-memory-brain.cloudflare-support-chat.workers.dev`  (https)
- prototype: real Cloudflare Worker + Durable Object — deployed, DO uses `ctx.storage.sql`.
- worker build tag: `unknown`
- FTS mode: **fts5**
- reset endpoint at run start: disabled
- /reset action: not requested
- lastId observed at start (after optional reset): 0
- lastId observed after warm-up (5 req): 5

## Test 1 — same-client read-after-write

- receipt id: `6`  ulid: `mem_9cbbf17b08881802cf193e63841fe8c2`  durable: `do-sql:fts5`
- recalled own write: **true**  (1 hits)

## Test 2 — receipt → *different* client recall

- receipt id: `7`  ulid: `mem_be2cfa0c57d5ed6bb29e17491485ef6d`
- second client saw the write: **true**  (1 hits)

## Test 3 — concurrency (N=64)

- writers: 64  errors: 0
- unique ulids: true  unique ids: true
- contiguous id range: true  starts at base+1: true
- id range: [8, 71]
- texts missing from recall: 0
- write latency under load: p50=1037.28ms  p95=1092.24ms  p99=1096.53ms  max=1096.53ms
- burst wall-time: 1102.64ms

## Test 4 — latency (light load, sequential, M=50)

- **remember**: mean=252.29ms  p50=235.21ms  p95=349.87ms  p99=425.04ms
- **recall**:   mean=206.70ms  p50=188.07ms  p95=280.27ms  p99=318.16ms
- **e2e**:      mean=458.99ms  p50=455.98ms  p95=592.95ms  p99=743.20ms
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

Latency numbers above include real network RTT from the harness host to Cloudflare's edge plus DO placement + DO storage commit. They are a real measurement of how far reality is from local `wrangler dev`.

FTS5 status: **fts5**. DO SQL accepted `CREATE VIRTUAL TABLE ... USING fts5(...)` and answered a MATCH query.

## Honest limitations of this prototype

- One DO id only (`idFromName("singleton")`). Sharding / placement / cold-start across many DOs are not modeled.
- Test 3's "burst" is bounded by the harness host's outbound HTTP concurrency, not by the DO itself.
- Remote latency includes everything from harness → CF edge → DO. A bad result can be CF placement, harness network, or DO — this experiment does not separate them.
- Ulid is `crypto.getRandomValues`-based, not time-sortable. Matches the rest of the series; not production-grade.
- No auth, no quotas, no eviction, no embeddings.
