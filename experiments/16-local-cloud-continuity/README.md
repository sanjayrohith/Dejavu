# Experiment 16 — local/cloud continuity without stale-state theater

## Question

Can one continuity model span a local coding agent and a cloud-shaped agent while semantic memory is asynchronous and either client can disconnect?

This experiment tests one deliberately narrow model:

> **Repository-scoped Dejavu owns the active local handoff. The shared Worker +
> Durable Object protocol is the exact, revisioned transport for operational
> continuity. Supermemory is a derived semantic index and is never allowed to
> certify operational freshness.**

The model is useful even if semantic extraction fails: exact work can continue
from the handoff and authority log, while semantic state remains explicitly
`queued`, `indexing`, `failed`, or timed out. The harness proves or disproves
each half independently.

## Real components

```text
local client process                    cloud-shaped client process
  Dejavu DB (repo scope)                    separate Dejavu DB (same scope identity)
  SharedDejavu mirror A                     SharedDejavu mirror B
           │                                      │
           └── HTTP + SSE ─ local Worker + SQLite Durable Object

                   real supermemory-server v0.0.2
                         127.0.0.1:6767
                   async document processing/search
```

No core product code is replaced or mocked. `run.sh` boots the repository's
`shared-server` under real local `wrangler dev`; its `MEMORY` binding is a
SQLite Durable Object. `harness.mjs` starts two independent Bun processes, each
with separate Dejavu and shared-mirror SQLite files. It sends synthetic documents
to the already-running real local Supermemory REST API.

## Assertions

1. **Scope:** two synthetic Git checkouts with the same normalized origin derive
   the same Dejavu repository scope; an unrelated origin derives a different one.
2. **Immediate operational continuity:** the local process gets a local active
   handoff and numbered authority receipts. The connected cloud process sees the
   exact slip and handoff through its own mirror. Its independent local Dejavu DB
   stays empty—scope identity is not misrepresented as transport.
3. **Pending semantic state:** Supermemory `/v3/documents` returns a real job.
   Its immediate document status must be an explicit pending status. Search
   visibility is counted only when the submitted document ID appears, not when
   an unrelated approximate match appears.
4. **Disconnect/staleness:** cloud disconnects its SSE/catch-up connection. A
   local write advances authority. Cloud's local recall misses it, and an
   authority-head probe must report `fresh=false` with a positive revision gap.
5. **Reconnect/catch-up:** reconnect downloads missed events and advances the
   contiguous watermark before local recall or freshness is accepted.
6. **Resolution:** cloud commits an exact revisioned `RESOLVED` record; local
   resolves its repository-scoped handoff, so it stops directing work.
   A separate semantic resolution document is observed without being treated as
   authority.

`RESULT.md` contains measured timings, statuses, revisions, and the event log.
A terminal Supermemory `failed` status is an honest partial disproof, not a
harness failure: operational continuity can pass while full semantic extraction
does not.

## Prerequisite

A real local Supermemory server must already be listening at
`http://127.0.0.1:6767` (override with `SUPERMEMORY_URL`). The run refuses to
continue unless `/` and `/v4/openapi` respond. This experiment does not start,
mock, or configure Supermemory and sends synthetic data only.

Required local commands: `bun`, `node`, `wrangler`, `curl`, `git`, and `lsof`.

## Run

```bash
./experiments/16-local-cloud-continuity/run.sh
```

Optional controls:

```bash
EXP16_PORT=8896 \
EXP16_SEMANTIC_TIMEOUT_MS=120000 \
SUPERMEMORY_URL=http://127.0.0.1:6767 \
./experiments/16-local-cloud-continuity/run.sh
```

The script chooses a free port, uses a one-run bearer token, keeps wrangler
state under this experiment's `.tmp/`, and never writes `shared-server/.dev.vars`
or shared wrangler state. On exit it stops the Worker, removes local/mirror DBs,
and the harness deletes submitted Supermemory documents. Logs remain in
`.tmp/`; `.tmp/` is gitignored.

## Reading the result correctly

- `fresh=true` is meaningful only when mirror revision equals observed authority
  head after connected catch-up.
- Supermemory chunk search visibility can precede full document processing. The
  result therefore reports search visibility and terminal processing status as
  separate facts.
- `failed` or timeout never becomes “eventually fresh.” The exact authority path
  remains usable, but semantic completion is disproved or still pending.
- Shared handoffs currently have no shared resolve event. The cloud resolution
  is represented by an exact revisioned resolution slip, while the directive
  lifecycle is resolved in Dejavu's repository-scoped handoff store.
  That seam is a finding, not hidden by the harness.
