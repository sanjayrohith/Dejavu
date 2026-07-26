# Shared memory security review

**Deployment paused.** Shared Dejavu works locally. It is not approved for any deployment until this review resolves.

## Why this matters

Shared Dejavu stores durable personal/work context and delivers it live to connected clients. A mistake exposes more than a demo endpoint: preferences, project decisions, handoffs, possibly internal work context.

## What is already in place

### Token-to-space isolation (local)

```text
DEJAVU_SHARED_TOKENS=alice-token:alice,bob-token:bob
```

Each space reaches a different Durable Object via `idFromName("space:" + space)`. Tests prove one token cannot read another space's events, status, or stream. The legacy `DEJAVU_SHARED_TOKEN=<token>` setting still maps to one `local` space for compatibility.

This stops accidental global sharing in local dogfood. It is **not** deployed identity.

### Bounded SSE stream lifetime

The server closes each authenticated `/v1/shared/stream` after a bounded TTL (default 900 s; configurable via `DEJAVU_SHARED_STREAM_TTL_SECONDS`; `unbounded` opts out and is not for deploys).

```text
event: expires
data: { "reason": "stream-ttl", "ttlSeconds": N, "expiresAt": "..." }

event: closed
data: { "reason": "stream-ttl" }
```

`SharedDejavu` reconnects a few seconds before announced expiry, which re-evaluates credentials and resumes from the contiguous watermark.

This bounds how long an existing authenticated stream can deliver new memories without re-authentication. It is **not** session revocation.

### Hard delete with server-replay redaction

`delete(id)`:

- removes content from synced searchable local copies (live + after offline catch-up);
- rewrites prior `remember` payloads for that slip on the server to `{ slipId, purged: true }`, preserving the revision slot without text, tags, author, or session id.

A new local copy catching up across purged history records the redacted revision without materializing content. Hard delete is **not** erasure from observability logs or future backups.

## What is missing

### Deployed identity

Bearer tokens do not identify verified users. No revocation per client. No session expiry beyond the SSE TTL. Unsafe as an employee service.

### Public exposure boundary

Any real deployment must terminate behind a real authentication boundary. The current `workers_dev = false` config is the right local default; deployment account, route, and edge policy are unresolved.

### Content policy

Memory is plaintext in local SQLite and in Durable Object SQL. There is no policy yet for what content is allowed (secrets, internal data, customer info) or for encryption at rest of either local copies or server-held content.

### Audit and observability retention

No audit trail for writes or sensitive reads. Observability log retention, backup retention, and replica retention are undefined — `delete` redacts server replay history, but not logs.

## Questions to answer before deploying

1. Personal-only first, or employee-facing?
2. What identity owns a memory space?
3. How does a local MCP client authenticate without a long-lived reusable secret?
4. How are sessions revoked? (Bounded TTL exists; deployed revocation does not.)
5. What content is prohibited from memory?
6. What audit logging is required, and what content must logs avoid?
7. Observability log + backup retention policy when `delete` runs?
8. Where may local SQLite copies live, and how are they protected at rest?

## Work checklist

Already done:

- [x] Local token-to-space isolation with cross-space access tests.
- [x] Bounded SSE TTL with `expires` / `closed` lifecycle events and client auto-reconnect tests.
- [x] Hard `delete` separates from legacy `forget`; purges local copies and redacts server replay history.

Open:

- [ ] Threat-model endpoints, local copies, live stream, token loss, cross-user access.
- [ ] Choose deployed identity + session design (verified user, short-lived credentials, revocation).
- [ ] Gate or remove bearer-token mode outside local dev.
- [ ] Define observability-log, backup, retention, and full-erasure semantics.
- [ ] Define audit logging without logging memory content.
- [ ] Define content policy: what may not be stored in shared memory.
- [ ] Encryption story for local copies and server-held content if employee use.
- [ ] Review deployment account, routes, and edge policy before any deploy command.

## What is allowed right now

```bash
./shared-server/test-local.sh
```

Local Wrangler, throwaway token, temporary SQLite copies, cleaned up on exit.

Not allowed:

```bash
wrangler deploy
```
