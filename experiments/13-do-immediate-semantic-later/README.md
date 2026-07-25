# Experiment 13 — DO immediate, semantic later

## Question

Can one API expose two honest speeds of memory?

1. An exact continuity record is committed in Durable Object SQLite and is available by id on the next read.
2. Semantic extraction/indexing is asynchronous and remains explicitly pending/stale until a real Supermemory search proves visibility.

The contract is deliberately asymmetric: an exact receipt is authoritative immediately; semantic freshness is an observation, never an inference from a queue receipt.

## Architecture

```text
POST /records ──> local Worker ──> one real Durable Object
                                      └─ ctx.storage.sql INSERT
                                            │ committed receipt
                                            └─ immediate GET /records/:id

(after that GET passes)
harness ──> POST http://127.0.0.1:6767/v3/documents
        ──> PATCH DO state to submitted (pending=true, stale=true)
        ──> poll real POST /v3/search
        ──> only an exact returned document id + marker permits `visible`
```

The harness is the asynchronous adapter on purpose. The DO's fast path has no network dependency on Supermemory. A production implementation would replace the adapter with a queue/workflow while preserving the same durable outbox/status contract.

The status fields are intentionally redundant and difficult to misread:

| state | pending | stale | fresh |
| --- | --- | --- | --- |
| `pending` | true | true | false |
| `submitted` | true | true | false |
| `visible` | false | false | true |
| `failed` | false | true | false |

`submitted` means only that Supermemory returned a document id (normally with `status: queued`). It does **not** mean searchable. The harness records `visible` only after `/v3/search` returns that same document id and a chunk containing the synthetic marker.

## Requirements

- Node 22+
- `wrangler` on `PATH`
- the real local Supermemory server already running at `http://127.0.0.1:6767`
- no credentials are required when that server applies its localhost key automatically

Only synthetic content is sent. No repository or user content is submitted.

## Run

From this directory:

```bash
bash run.sh
```

Useful overrides:

```bash
PORT=9013 \
SUPERMEMORY_BASE=http://127.0.0.1:6767 \
SEMANTIC_TIMEOUT_MS=180000 \
SEMANTIC_POLL_MS=500 \
bash run.sh
```

`run.sh` starts a real local `wrangler dev` Worker/DO, runs `node --test test.mjs`, then runs `harness.mjs`. The harness overwrites `RESULT.md` with measured timings and exits 2 if semantic visibility was not observed before timeout. Importantly, that timeout still leaves an honest result file saying the record is submitted/stale; it never fabricates freshness.

To run pieces manually, first start Wrangler:

```bash
wrangler dev --local --port 8913
node --test test.mjs
node harness.mjs
```

## What is tested

- The POST response says committed and echoes exact content from DO SQLite.
- An immediate independent GET returns byte-for-byte identical content.
- Both responses say semantic `pending`, stale, and not fresh before any Supermemory request.
- The Supermemory add call uses the real `/v3/documents` endpoint.
- A queued document is persisted as `submitted` but still stale/not fresh.
- Search polling uses the real `/v3/search` endpoint and records time to first verified visibility.
- State can become fresh only after that observation.

## Boundaries

- `wrangler dev --local` exercises workerd's real DO API and SQLite implementation, not Cloudflare's production durability infrastructure.
- One named DO and one synthetic record do not establish throughput, tail latency, or a semantic-lag SLO.
- Search visibility demonstrates local Supermemory indexing/search catch-up. It does not inspect or claim details of Supermemory's internal extraction stages.
- Polling itself bounds the timing precision by `SEMANTIC_POLL_MS` plus request latency.
- A crashed adapter can leave a durable record in `pending`/`submitted`; that explicit stale state is preferable to a false freshness claim, but retry/recovery machinery is outside this experiment.
