# Experiment 03 — real Cloudflare DO memory brain

## Hypothesis

Experiment 01 showed that a single authoritative process with one SQLite
database and a global write lock satisfies Dejavu's shared-memory contract
— receipt-then-recall is unconditional, cross-client visibility is free,
concurrent writers serialize cleanly, and there is no "eventual" anywhere.

Experiment 03 asks the next, sharper question:

> Does that result survive when the "authority" is a real Cloudflare
> Durable Object using `ctx.storage.sql`, instead of a Python stand-in?

If yes, the eventual Dejavu deployment on Cloudflare can stay shaped exactly
like experiment 01 — one DO per memory shard, one SQL DB inside it, no
replication-aware code anywhere in the agent layer. Receipts mean what
they say.

## Architecture (and how it maps to the eventual Cloudflare shape)

```text
        HTTP clients (harness, MCP, agents)
        ┌────────┬────────┐
        │ alice  │ bob    │   ... separate fetch() callers
        └───┬────┴───┬────┘
            ▼        ▼
        ┌─────────────────┐
        │  Worker (router) │   ← env.BRAIN.idFromName("singleton")
        └────────┬─────────┘
                 ▼
        ┌──────────────────────────────┐
        │  Durable Object: BrainDO     │   ← single-threaded execution
        │  ┌────────────────────────┐  │
        │  │ ctx.storage.sql        │  │   ← real DO SQL (libSQL/SQLite)
        │  │   memory(id, ulid, …) │  │
        │  │   memory_fts (FTS5)    │  │   ← if local DO SQL supports it,
        │  │   or LIKE fallback     │  │     otherwise documented fallback
        │  └────────────────────────┘  │
        └──────────────────────────────┘
```

This experiment → eventual Dejavu shape:

| this experiment                              | eventual Dejavu                                 |
| -------------------------------------------- | --------------------------------------------- |
| `BRAIN.idFromName("singleton")`              | one DO id per memory shard (per owner/space)  |
| `ctx.storage.sql` inside the DO              | same — DO SQL storage is the canonical path   |
| Worker is a pure router                      | same — Worker is the MCP/HTTP edge            |
| FTS5 if available, else LIKE                 | FTS5; this experiment proves which path works |
| `wrangler dev --local`                       | real CF deploy (out of scope here)            |

## What this experiment tests

1. **Same-client read-after-write.** `POST /remember` returns a receipt; an
   immediately-following `GET /recall?q=` from the *same* client sees it.
2. **Cross-client visibility.** Client A writes; an independent fetch
   ("client B") immediately sees the row. There is no shared client state,
   so this is a real property of the DO.
3. **Concurrent writers.** 64 parallel `/remember` calls — verify unique
   ulids, contiguous ids, zero missing payloads on recall, write latency
   percentiles.
4. **Light-load latency.** 50 sequential write+read pairs; record p50/p95/p99
   for `remember`, `recall`, and end-to-end.

A separate, important sub-result is recorded in `RESULT.md`: whether local
DO SQL (workerd's SQLite) actually accepts `CREATE VIRTUAL TABLE ... USING
fts5`. If it does, the harness uses FTS5 prefix-MATCH. If it doesn't, the
exact error is captured and the same code path falls back to `LIKE`, so the
visibility and concurrency claims are tested either way. The passing FTS path
also explicitly indexes the inserted row in the write turn: an intermediate
trigger-only version accepted writes but failed the immediate-recall assertion,
which is exactly the regression this experiment exists to catch.

## Files

- `wrangler.toml` — single DO binding `BRAIN` → class `BrainDO`, opted into
  SQL storage via `new_sqlite_classes`.
- `src/worker.ts` — Worker entry routes every request to the singleton DO;
  `BrainDO` owns schema init, `/remember`, `/recall`, `/health`.
- `harness.mjs` — Node 22 native `fetch` test runner; no dependencies.
- `run.sh` — boots `wrangler dev --local` on 127.0.0.1:8874, waits for
  `/health`, runs the harness, writes `RESULT.md`, kills wrangler.
- `RESULT.md` — generated.

## Run it

```bash
bash ./run.sh
```

Defaults to port `8874`; override with `PORT=9000 bash ./run.sh`.

Strictly local — no `wrangler deploy`, no account mutation, no remote CF
API calls. The DO's storage lives under `.wrangler/state/` (gitignored at
the repo root).

## Honest limitations

- Local `workerd` is not a Cloudflare durability proof. Numbers will differ
  on real CF; the *contract* should not.
- One DO id only — placement / sharding / cold-start unmodeled.
- No auth, no quotas, no eviction, no embeddings — orthogonal to the
  visibility question this experiment exists to answer.
- Test 3's parallelism is capped by Node fetch concurrency in front of the
  DO, not by the DO itself.
