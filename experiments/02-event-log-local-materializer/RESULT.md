# Result — Experiment 02 event log + local materializer

Run verdict: **PASS**

## Observed locally

- Writer append receipts: **p50 0.50 ms · p95 0.66 ms · max 5.02 ms** across 40 sequential writes.
- Apply acked event to writer-local SQLite FTS: **p50 0.06 ms · p95 0.14 ms · max 0.79 ms**.
- Warm local FTS recall after apply: **p50 0.03 ms · p95 0.05 ms · max 0.09 ms**.
- Other-client pull + SQLite materialization: **p50 0.43 ms · p95 0.61 ms · max 0.74 ms**.
- Immediate writer read-after-write after ack/apply: **40/40**.
- Second-client catch-up then recall: **40/40**.
- Concurrent append receipt sequences: **unique=true**, **contiguous=true** over 24 requests.
- Final second-client catch-up applied **24** concurrent events; HTTP fetch portion **0.46 ms**; latest sequence **64**.
- Second materialized DB rows: **64**.

## What this says

This design can make durable writes crisp: the sequencer responds only after the
append log is fsync'd, and a client can apply that exact acked event locally and
recall it with local FTS immediately. Another runtime deterministically catches up
by sequence and sees the same memory without any ambiguous indexing phase.

## What is still suspicious

- The writer's "immediate" read is immediate only after it applies its own
  receipt locally. That is simple in one SDK, but it is still protocol logic.
- Another client does **not** see the write until it fetches or receives a live
  fanout event. A real product would need a DO subscription/WebSocket/SSE or
  fetch-on-recall rule.
- This uses JSONL + local fsync, not real Durable Objects or R2 segments. R2
  segment flush, snapshots, and compaction are untested.
- SQLite FTS5 is available in local Python here; browser/Worker WASM parity is
  a separate question.

Command: `./run.sh`
