# Experiment 01 — RESULT

- brain endpoint: `http://127.0.0.1:8873`
- prototype: single Python process, ThreadingHTTPServer, SQLite WAL, global write lock around `BEGIN IMMEDIATE` (DO-shaped authority).

## Test 1 — same-client read-after-write

- receipt id: `1`  ulid: `mem_d6c63271d67d4ea69980fa6df90ed318`  durable: `sqlite-wal`
- recalled own write: **True**  (1 hits)

## Test 2 — receipt → *different* client recall

- receipt id: `2`  ulid: `mem_6943ef24b09a4ced837a50c06df95690`
- second client saw the write: **True**  (1 hits)

## Test 3 — concurrency

- writers: 64  errors: 0
- unique ulids: True  unique ids: True
- contiguous id range: True  starts at base+1: True
- id range: [3, 66]
- texts missing from recall: 0
- write latency under load: p50=3.52ms  p95=4.45ms  p99=4.50ms  max=4.52ms

## Test 4 — latency (light load)

- **remember**: mean=0.37ms  p50=0.35ms  p95=0.49ms  p99=0.57ms
- **recall**: mean=0.34ms  p50=0.33ms  p95=0.46ms  p99=0.50ms
- **e2e**: mean=0.71ms  p50=0.68ms  p95=0.95ms  p99=0.97ms

## Interpretation

Read-after-write is unconditional in this model: the DO-shaped authority commits the row inside the lock and only then returns a receipt, so any subsequent reader — the writer or another client — that hits the same authority sees it. There is no replication lag to hide, because there is exactly one place memory lives.

Concurrency holds because writes are serialized through `BEGIN IMMEDIATE` under a global threading lock — the local stand-in for a Durable Object's single-threaded execution. Ids are contiguous; ulids are unique; every payload is recallable.

## Honest limitations of this prototype

- Local fsync is not a Cloudflare durability proof. WAL+`synchronous=NORMAL` is weaker than DO storage's distributed commit; numbers will differ on real CF.
- `LIKE` recall, not FTS5. Production Dejavu uses FTS5; this experiment intentionally tests authority/visibility, not ranking.
- No network: clients and the DO share a loopback socket. CF-side latency, DO placement, and cold-start cost are not modeled here.
- No auth, no quotas, no eviction, no embeddings — those are orthogonal.
- One DO id only. The shard/routing question (one DO per owner? per workspace?) is not in scope; this prototype models the inside of one authority.
