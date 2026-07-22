# Dejavu shared server

This is the hosted half of shared Dejavu.

```text
client saves memory
       ↓
this server stores it once and gives it a change number
       ↓ live updates
connected clients update their searchable local copy
```

## Run locally

Create `shared-server/.dev.vars` with a token-to-memory-space mapping:

```bash
cat > shared-server/.dev.vars <<'EOF'
DEJAVU_SHARED_TOKENS=dev-token:personal,team-token:project-docs
EOF
cd shared-server
wrangler dev --local --ip 127.0.0.1 --port 8790
```

Then, from another terminal in the repo:

```bash
DEJAVU_SHARED_GATEWAY=http://127.0.0.1:8790 \
DEJAVU_SHARED_TOKEN=dev-token \
bun run src/cli.ts shared status
# reports the personal space; team-token reaches project-docs instead
```

## Try the whole flow locally

From the repo root:

```bash
./shared-server/test-local.sh
```

This boots the server with a throwaway local token and proves:

```text
client A saves memory and a handoff
client B downloads them into its searchable local copy
client B marks the memory used, then deletes it
client B no longer stores or recalls the deleted memory
server replay history no longer contains that memory text
```

The script cleans up its temporary token and local copies when it exits.

## Deployment status

**Local dogfood only for now. Do not deploy yet.**

Before personal or AX employee deployment, complete the security review in
[`../docs/shared-security-review.md`](../docs/shared-security-review.md). AX
employee usage needs verified employee identity and per-user separation; the
current local token mode is not that design.

## Authentication and separation in local development

Every request requires:

```http
Authorization: Bearer <token>
```

Configure local tokens with:

```text
DEJAVU_SHARED_TOKENS=<token>:<memory-space>,<token>:<memory-space>
```

Each mapped memory space is routed to its own Durable Object. A token mapped to
`personal` cannot list or stream changes in `project-docs`; the integration
test proves this boundary. This makes local development honest about isolation.

`DEJAVU_SHARED_TOKEN=<token>` remains temporarily compatible with earlier local
demos and maps only to a space named `local`. Do not use it for new examples.
Both forms are still bearer tokens and are local proof mechanisms only, not the
approved deployed auth model.

Do not publish this server unauthenticated or deploy it before security review.

## Bounded stream lifetime

Each authenticated `/v1/shared/stream` connection is closed after a bounded
TTL (default 900 seconds; override via `DEJAVU_SHARED_STREAM_TTL_SECONDS`, or
set `unbounded` to opt out). The server sends:

```text
event: expires
data: { "reason": "stream-ttl", "ttlSeconds": N, "expiresAt": "..." }
```

immediately after the hello frame, and:

```text
event: closed
data: { "reason": "stream-ttl" }
```

at the TTL boundary. The reconnect is the enforcement point for future
deployed token rotation or revocation; do not deploy with `unbounded`.

## Code map

| File | Purpose |
|---|---|
| `src/worker.ts` | Maps local tokens to separated memory spaces and serves the API. |
| Durable Object SQL | Stores one space's saved memories and numbered changes. |
| `/v1/shared/stream` | Sends live saved changes. |
| `/v1/shared/events` | Downloads missed changes, including deletions, after reconnect. |

This first server supports the implemented shared client tools: remember,
handoff, signal, delete, status, events, and live updates. A delete is retained
as a numbered deletion change so an offline local copy can remove its prior
memory row after reconnecting. Historical `remember` payloads for that slip are
redacted to `{ slipId, purged: true }`, so replay retains ordering but not the
memory text, tags, author, or session id.
