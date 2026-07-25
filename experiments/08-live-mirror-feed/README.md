# Experiment 08 — live feed + local searchable mirror

## Product question

The target is functionality, not minimalism:

> shared memory is authoritative, cross-agent fresh, properly searchable, and
> local-feeling for clients that keep a live connection.

Evidence so far:

- Experiment 05: deployed DO SQL authority is correct, but laptop remote recall
  was not local-feeling.
- Experiment 06: a local SQLite/FTS mirror restores fast reads, but catch-up is a
  sync protocol.
- Experiment 07: cheap caches help bounded cases, but cannot make arbitrary peer
  writes locally fresh.

Experiment 08 tests the missing functionality: **ordered live memory events**.

```text
write → authority revision → SSE event → client mirror apply → local FTS recall
                               ↘ /events?since=N catch-up on reconnect
```

## Prototype

Local-only deterministic Node prototype:

- `src/authority.mjs`
  - `POST /remember`
  - `GET /events?since=<revision>`
  - `GET /stream?since=<revision>` Server-Sent Events feed
  - `GET /recall?q=...` authoritative search sanity endpoint
  - monotonic revision assignment and ordered event log
- `src/client.mjs`
  - SQLite + FTS5 local mirror via `node:sqlite`
  - contiguous applied `mirrorRevision` watermark
  - SSE subscription, disconnect handling, reconnect catch-up
  - local FTS recall and freshness state
- `harness.mjs`
  - writes `RESULT.md`

## Scenarios

1. Writer gets authority receipt and immediately locally recalls its own slip.
2. Peer client receives streamed event, applies to mirror, locally recalls it;
   measure writer receipt → peer visible latency.
3. Warm local FTS recall p50/p95.
4. Peer disconnects; authority accepts missed writes; peer reports stale; on
   reconnect it catches up from `/events?since=` and becomes fresh.
5. Concurrent writes preserve unique contiguous authority revisions and both
   clients converge in revision order.

## Run

```bash
cd experiments/08-live-mirror-feed
./run.sh
```

Throwaway SQLite/log files live under `.tmp/`.

## What would make this earn the complexity?

- Peer mirror visibility after authority write is consistently far below the raw
  remote-recall budget observed in experiment 05 once this is tried against a
  deployed authority.
- Disconnect/catch-up is deterministic and honest, not "eventually maybe".
- The contiguous watermark model from experiment 06 survives live fanout and
  concurrent writes.

This experiment is local only, so it proves protocol correctness and a latency
floor, not real edge/network timing. If it passes, the next experiment should
swap the authority for a deployed DO with SSE/WebSocket feed.
