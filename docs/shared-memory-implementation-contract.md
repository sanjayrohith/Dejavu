# Shared memory implementation contract

The invariants the server, local copy, sync transport, and client all maintain. Anything that violates these is a bug, not a tradeoff.

## Invariants

1. **The server is truth.** A shared memory write commits in the server before its receipt returns.
2. **Monotonic revision order.** Every committed change receives one per-space integer revision. Revisions are unique and totally ordered.
3. **Fanout never blocks commits.** Live delivery is best-effort relative to the durable write response. A backpressured subscriber may disconnect; it must never wedge `remember` / `handoff` / `signal` / `delete`.
4. **Local copies are rebuildable.** A local copy is read acceleration, not write authority. Any change can be re-derived from the server's ordered log.
5. **Watermark is contiguous.** `mirrorRevision = R` means every change in `[1..R]` has been applied. Applying an own acked revision `85` while peer revisions `23..84` are missing must not advance the watermark beyond `22`.
6. **Gaps are explicit.** A behind or disconnected client surfaces `fresh: false` and the exact `behind` count, then repairs from `GET /events?since=R`.
7. **Deletion is replayable and redacted.** A `delete` commits as a numbered change. Local copies remove slip content and FTS rows when applying it; offline clients do the same after catch-up. The server rewrites prior `remember` payloads for that slip to `{ slipId, purged: true }` while preserving the revision slot. This does not promise erasure from external logs or future backups.
8. **Live streams are bounded.** The server announces a TTL on stream open and closes the stream at the announced time. Clients reconnect from their current watermark.

## Event type

```ts
export type SharedMemoryEventType = "remember" | "handoff" | "signal" | "delete" | "link";

export interface SharedMemoryEvent<T = unknown> {
  revision: number;
  eventId: string;       // globally unique ULID-like id
  type: SharedMemoryEventType;
  authority: string;     // per-space id/slug, opaque to clients
  committedAt: string;   // ISO timestamp
  payload: T;
}
```

Payloads:

```ts
export interface SharedRememberPayload {
  slipId: string;
  text: string;
  tags: string[];
  authoredBy: string;
  sessionId: string;
  state: "kept";
}

// After deletion, prior remember events for that slip replay as:
export interface SharedPurgedRememberPayload {
  slipId: string;
  purged: true;
}
```

Clients applying a purged remember must record its revision but never materialize content.

## Write receipt

```ts
export interface SharedWriteReceipt<T = unknown> {
  ok: true;
  id: string;                    // domain id, e.g. slipId
  event: SharedMemoryEvent<T>;
  receipt: {
    authority: string;
    revision: number;
    committedAt: string;
  };
  recallable: true;
}
```

The event included in a receipt is the canonical event. The writer applies it directly to its own local copy for read-after-write. No second network round-trip.

## HTTP endpoints

```http
POST /v1/shared/remember
POST /v1/shared/handoff
POST /v1/shared/signal
POST /v1/shared/delete
GET  /v1/shared/events?since=<revision>&limit=<n>
GET  /v1/shared/stream?since=<revision>      # SSE
GET  /v1/shared/status
```

Every request requires `Authorization: Bearer <token>`. The token maps to one named memory space; cross-space access is impossible.

`events` response:

```ts
export interface SharedEventsResponse {
  ok: true;
  authority: string;
  headRevision: number;
  events: SharedMemoryEvent[];   // strictly revision-ascending
}
```

`status` response:

```ts
export interface SharedAuthorityStatus {
  ok: true;
  authority: string;
  headRevision: number;
}
```

## Live feed seam

On subscribe, the server sends:

```text
event: hello
data: <SharedAuthorityStatus JSON>

event: expires
data: { "reason": "stream-ttl", "ttlSeconds": 900, "expiresAt": "..." }

(event: memory frames, one per change...)
```

Then at TTL boundary:

```text
event: closed
data: { "reason": "stream-ttl" }
```

Each memory frame:

```text
id: 9182
event: memory
data: <SharedMemoryEvent JSON>
```

Clients SHOULD treat `expires` as a hint to reconnect before the TTL elapses. They MUST be prepared for the stream to close at the announced time. Reconnect uses the same `since` watermark so no committed memory is missed. The `SharedDejavu` client does this automatically; override with `onStreamLifecycle` / `autoReconnectOnExpiry: false`.

## Local copy seam

Behavior the local copy exports:

```ts
apply(event):        { applied: boolean; mirrorRevision: number }
applyReceipt(receipt): same
catchUp(fetchEvents): Promise<{ applied: number; mirrorRevision: number; headRevision: number }>
recallLocal(query):   RecallResult
freshness(headRevision): { mirrorRevision, headRevision, behind, fresh }
```

Local copy storage owns:

- applied event id / revision dedupe;
- contiguous watermark metadata;
- materialized kept slips;
- removal of materialized slip and FTS content on a deletion change;
- recording purged remember revisions without materializing content;
- local FTS over memory text and tags.

## Code map

| Concern | Source |
|---|---|
| Wire types | `src/shared-contract.ts` |
| Server (deployed) | `shared-server/src/worker.ts` |
| Server (in-process, tests) | `src/shared-authority/` |
| Local copy | `src/shared-mirror/mirror.ts` |
| Sync transport | `src/shared-mirror/connection.ts`, `sse-client.ts` |
| Client facade | `src/shared-client/index.ts` |
| Agent tools | `src/shared-mcp.ts` |
