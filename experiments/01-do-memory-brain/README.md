# Experiment 01 — DO-shaped memory brain

## Hypothesis

A single authoritative DO-like process can satisfy Dejavu's shared-memory
contract without any of the syncing, materializing, or "eventually visible"
machinery. Specifically:

- `remember` returns a receipt **only after** the row is durably committed.
- After that receipt, `recall` always sees the write — for the same client
  *and* for any other client — because there is exactly one place memory
  lives.
- Concurrent writers are serialized through the authority; their ids form a
  contiguous monotonic range and nothing is lost.

If the simplest possible "one process, one DB, one lock" model already
satisfies the contract, then Dejavu's eventual Cloudflare implementation
(Durable Object + DO SQL storage MCP) does not have to design around
replication lag, materialization, or read-after-write races — only around
sharding and durability inside one authority.

## Architecture (and how it maps to the eventual Cloudflare shape)

```text
        MCP / agent clients
        ┌──────┬──────┐
        │alice │bob   │   ... separate processes / HTTP clients
        └───┬──┴───┬──┘
            ▼      ▼
    ┌────────────────────────┐
    │  DO-shaped authority   │   ← single Python process in this experiment
    │  ┌──────────────────┐  │
    │  │ write lock       │  │   ← global threading.Lock() around BEGIN IMMEDIATE
    │  │   ↓              │  │
    │  │ SQLite (WAL)     │  │   ← single file: .tmp/brain.sqlite
    │  └──────────────────┘  │
    └────────────────────────┘
```

This experiment → eventual Dejavu shape:

| Experiment (local)                              | Production (Cloudflare)                        |
| ---                                             | ---                                            |
| Single Python process, ThreadingHTTPServer      | Durable Object (single-threaded execution)     |
| `threading.Lock()` around `BEGIN IMMEDIATE`     | DO's natural single-flight per request         |
| `.tmp/brain.sqlite` with WAL                    | DO SQL storage (`state.storage.sql`)           |
| `POST /remember`, `GET /recall`                 | MCP `remember` / `recall` tool handlers in the DO |
| Loopback HTTP                                   | Worker → DO stub fetch / `BrowserRendering`-style RPC |

The point is that the **shape** is identical: every read and every write
funnels through one authority that owns its own database. There is no
"second copy" of memory anywhere. That is the property under test.

## What this experiment tests

1. **Same-client read-after-write** — alice writes, alice immediately reads,
   alice sees her own write.
2. **Cross-client read-after-receipt** — alice writes; *bob*, a fully
   separate client, immediately reads and sees alice's write. This is the
   actual interesting property: it is the one a sync-based design cannot give
   you cheaply.
3. **Concurrency** — 64 concurrent writers across multiple "agents" hit the
   brain at once. Verify (a) every receipt is unique, (b) ids form a
   contiguous monotonic range, (c) every payload is recallable afterward.
4. **Latency** — p50 / p95 / p99 for `remember`, `recall`, and round-trip
   under light load, on loopback.

## What this experiment intentionally does **not** test

- Real Cloudflare DO durability or placement latency (we have a loopback
  socket and a local fsync).
- FTS5 ranking quality (we use `LIKE`; ranking is orthogonal).
- Authentication / quotas / abuse.
- Embeddings, vector recall, or any "smart" recall.
- Sharding across owners. The experiment runs **inside one authority**; the
  shard/route question ("one DO per owner? per workspace?") is the next
  experiment, not this one.

If this experiment passes, it does not prove DO + SQLite is the right answer
in production. It proves the *shape* is sound — that a single-authority model
gives us the contract we want, so we can stop designing around lag.

## How to run

```bash
cd experiments/01-do-memory-brain
./run.sh
```

`run.sh` will:

1. wipe `.tmp/`,
2. start `brain.py` on `PORT` (default `8873`) with `.tmp/brain.sqlite`,
3. wait for `/health`,
4. run `harness.py`, which performs all four tests,
5. write `RESULT.md` and print it,
6. kill the brain process on exit.

Only Python 3 stdlib + `sqlite3` are required. No installs.

## Files

- `brain.py` — the DO-shaped authority (HTTP + SQLite + lock).
- `harness.py` — runs the four tests, writes `RESULT.md`.
- `run.sh` — orchestrates start / wait / run / teardown.
- `RESULT.md` — observed results from the most recent run.
- `.tmp/` — throwaway state, gitignored by virtue of being under the
  experiment directory; recreated each run.
