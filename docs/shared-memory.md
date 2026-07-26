# Shared memory

Dejavu runs entirely on one computer. Shared mode adds one memory server and a live-synced searchable local copy on every connected machine.

## The idea

```text
agent saves memory
       ↓
 memory server  ── live update ──→  searchable local copy
       ↑                                ↓
       └────── download missed ─── instant recall
```

The server is the source of truth. Each connected client keeps a small SQLite + FTS copy so reads feel local. A save returns a numbered receipt. A client that was offline reports it is behind and downloads missed changes before claiming it is current.

That is the whole design.

## Why this shape

A remote-only search was correct but slow: roughly 188 ms recall and 456 ms write-then-read in deployed measurements. A small cache made repeats faster but could return an old empty answer after a peer write.

A live local copy gives:

- one server decides what is saved;
- writes return clear numbered receipts;
- connected clients receive new memories live;
- local FTS search is effectively instant (~0.01 ms p50);
- disconnected clients know they are behind;
- reconnect downloads missed numbered changes in order.

## Public API

```ts
import { SharedDejavu } from "dejavu";

const memory = await SharedDejavu.connect({
  gateway: "https://memory.example",
  token: process.env.DEJAVU_SHARED_TOKEN,
});

const saved = await memory.remember("Use live updates so shared recall stays local.", {
  tags: ["decision"],
});

saved.receipt.revision;          // numbered saved change
memory.recall("shared recall");  // searches local copy
memory.status();                 // live / behind / current

await memory.handoff("Finished the sync layer", { next: ["wire MCP"] });
await memory.signal(saved.id, "used");
await memory.delete(saved.id);   // removes locally + redacts server replay
```

## How saving works

```text
remember("use pnpm")
  → server commits change 9182
  → caller receives receipt 9182
  → caller adds the saved memory to its local copy immediately
  → connected peers receive change 9182 live
```

A slow or broken peer cannot delay the save response. It disconnects and syncs missed changes later.

## How reconnect works

```text
local copy has changes through 9179
server has changes through 9182
client reports: behind by 3
client downloads changes 9180..9182
client reports: current
```

The contiguous-watermark invariant: the client stores the last change for which it has **every earlier change**, not merely the largest number seen. If it sees change 9182 before 9180 and 9181, the writer can still recall it locally, but `status` reports behind until 9180 and 9181 land.

## Hard delete

`delete(id)` is a numbered change:

- removes the slip from synced searchable local copies (live and after offline catch-up);
- rewrites prior `remember` payloads for that slip on the server to `{ slipId, purged: true }`, keeping the revision slot for offline replay but dropping the text, tags, author, and session.

A new local copy catching up across a purged history records the redacted revision without materializing content.

Hard delete does **not** promise erasure from external logs, future backups, or replicas. Those are deployment policy questions.

## Bounded stream lifetime

Each authenticated `/v1/shared/stream` connection is closed by the server after a bounded TTL (default 900 seconds; configurable via `DEJAVU_SHARED_STREAM_TTL_SECONDS`; `unbounded` opts out and is not for deploys).

The server sends:

```text
event: expires
data: { "reason": "stream-ttl", "ttlSeconds": 900, "expiresAt": "..." }
```

right after the hello frame, and:

```text
event: closed
data: { "reason": "stream-ttl" }
```

at the TTL boundary.

`SharedDejavu` reconnects automatically a few seconds before announced expiry, which re-evaluates credentials and resumes from the contiguous watermark. Override with `onStreamLifecycle` / `autoReconnectOnExpiry: false`.

This bounds how long an existing authenticated stream can deliver new memories without re-authentication. It is a foundation for deployed token rotation and revocation, not a substitute for them.

## Agent tools

```text
recall    search the local copy
remember  save a memory; receipt is recallable locally immediately
handoff   leave work for the next agent
signal    used | wrong | (legacy) forget
delete    remove memory content locally and redact its server replay entry
status    check whether the local copy is current
```

MCP wiring example:

```jsonc
{
  "mcpServers": {
    "dejavu-shared": {
      "command": "bun",
      "args": ["run", "<path-to-dejavu>/src/cli.ts", "shared", "mcp"],
      "env": {
        "DEJAVU_SHARED_GATEWAY": "https://memory.example",
        "DEJAVU_SHARED_TOKEN": "<your-token>"
      }
    }
  }
}
```

## HTTP endpoints

```http
POST /v1/shared/remember
POST /v1/shared/handoff
POST /v1/shared/signal
POST /v1/shared/delete
GET  /v1/shared/status
GET  /v1/shared/events?since=<number>&limit=<number>
GET  /v1/shared/stream?since=<number>
```

Every request requires `Authorization: Bearer <token>`. The server maps a token to one named memory space (separate Durable Object). Tests prove one token cannot read another space's changes.

## Code map

| Layer | Source |
|---|---|
| Wire protocol | `src/shared-contract.ts` |
| Server (deployed) | `shared-server/src/worker.ts` |
| Server (in-process, for tests) | `src/shared-authority/` |
| Local searchable copy | `src/shared-mirror/mirror.ts` |
| Sync transport | `src/shared-mirror/connection.ts`, `sse-client.ts` |
| Client facade | `src/shared-client/index.ts` |
| Agent tools | `src/shared-mcp.ts` |

## Safety and deployment status

**Local dogfood only. Deployment is paused.**

Open work before any deploy lives in [`shared-security-review.md`](./shared-security-review.md):

- Local mapped tokens prove isolated memory spaces. They are not a deployed identity/permissions design.
- Bounded SSE lifetime exists. Deployed session revocation does not.
- `delete` purges synced local copies and server replay history. Observability logs and backups remain a policy question.
- Local SQLite copies are plaintext. Do not store secrets without an explicit encryption story.

## Implementation contract

Invariants the server, local copy, and client maintain — see [`shared-memory-implementation-contract.md`](./shared-memory-implementation-contract.md).

## Proof receipts

Experiments explain *why* the design looks this way. They are not required reading.

| Experiment | What it showed |
|---|---|
| `05-deployed-do-memory-brain` | One remote server is correct, but remote-only recall feels slow. |
| `06-do-authority-local-hot-mirror` | A searchable local copy works; gaps must be tracked correctly. |
| `07-cheap-local-feel` | Small caches help but cannot guarantee fresh peer memory. |
| `08-live-mirror-feed` | Live updates + local search work locally. |
| `09-deployed-live-mirror-feed` | Personal-account remote run passed after fixing stream backpressure and test isolation. |
| `10-shared-mcp-local-dogfood` | Two real MCP stdio clients converge through live updates and reconnect catch-up. |

Final experiment 09 remote run measured:

```text
peer write start → other local copy searchable: ~485 ms
warm local recall:                              ~0.01 ms p50
```
