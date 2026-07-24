# Experiment 02 — event log + local materialized memory

## Hypothesis

A tiny append-only cloud-log protocol can make shared Dejavu memory **provable**
without putting a sync model in the product UI:

- writes get a durable monotonic sequence receipt;
- another runtime can deterministically catch up;
- once caught up, recall is a local SQLite FTS query;
- we can measure the gap between "durable shared write" and "other client's
  local materialization sees it" instead of hiding it.

This models a possible Cloudflare shape:

```text
MCP / app client
      │ append or fetch
      ▼
DO-like sequencer  ───► R2 immutable event segments / snapshots later
      │
      ▼
client-local SQLite + FTS5 materialized view
```

This experiment uses one local serialized HTTP sequencer and JSONL instead of a
real Durable Object and R2. If the protocol is already confusing here, Cloudflare
primitives will not rescue it.

## What it proves / does not prove

It tests:

- receipt-bearing append events;
- local materialization into SQLite FTS5;
- immediate read-after-write for the writing client after it applies its acked
  event locally;
- deterministic second-client catch-up from a sequence number;
- concurrent append sequencing;
- append, catch-up, and warm local recall latency.

It does **not** test:

- real R2 latency or object layout;
- DO placement/routing;
- WebSocket live fanout;
- authentication;
- production ranking quality.

## Run

```bash
cd experiments/02-event-log-local-materializer
./run.sh
```

The runner creates throwaway state under `.tmp/`, starts the local sequencer,
runs the benchmark harness, writes `RESULT.md`, and exits.
