# Experiment 10 — shared-MCP local dogfood

Proves that `src/shared-mcp.ts` (the stdio MCP server that wraps `SharedDejavu`)
talks to the real `shared-server` worker through actual MCP JSON-RPC over stdio,
not just through the in-process CLI path that `shared-server/test-local.sh`
exercises.

The end-to-end shape under test:

```text
  +-----------------+        HTTP+SSE       +-----------------------+
  | MCP client A    | <───────────────────> |                       |
  |  (harness.mjs)  |  stdio MCP JSON-RPC   |  shared-mcp.ts (A)    |
  +-----------------+ <───────────────────> |   ── mirror A.sqlite  |
                                            |   ──> shared-server   |
  +-----------------+                       |  shared-mcp.ts (B)    |
  | MCP client B    | <───────────────────> |   ── mirror B.sqlite  |
  |  (harness.mjs)  |  stdio MCP JSON-RPC   |   ──> shared-server   |
  +-----------------+                       +-----------------------+
                                                       │
                                                       ▼
                                  one local wrangler-dev shared-server,
                                  random bearer token, gone on exit
```

Two **independent** `bun run src/shared-mcp.ts` processes are spawned, each with
its own `DEJAVU_SHARED_MIRROR_DB`. The harness drives both through the official
`@modelcontextprotocol/sdk` stdio client, so every assertion is the result of a
real MCP `tools/call` round-trip, not an internal API call.

## What the harness checks

For both clients:

- `tools/list` returns exactly `handoff, recall, remember, signal, status`.

For client A:

- `status` (refresh) succeeds against the live server.
- `remember` returns a slip id and a committed revision.
- `handoff` returns a committed revision.

For client B (a *different* local mirror, same authority):

- `status` refresh advances the mirror.
- `recall` finds A's slip *and* A's handoff.
- `signal { action: "forget" }` propagates.
- A second `recall` no longer sees the slip; the handoff is still visible
  (signal forget is slip-scoped).

For client A again, to prove cross-mirror convergence:

- `recall` on A's mirror no longer sees the forgotten slip; the handoff is still
  present.

Anything else makes the harness exit non-zero and writes a failure RESULT.md.

## Run

```bash
./experiments/10-shared-mcp-local-dogfood/run.sh
```

The script:

1. Generates a single-use bearer token (`exp10-<24 random chars>`).
2. Writes it to `shared-server/.dev.vars` and boots
   `wrangler dev --local` on `127.0.0.1:$EXP10_PORT` (default 8791).
3. Waits for `/v1/shared/status` to authenticate with the new token.
4. Runs `harness.mjs`, which spawns the two MCP servers and walks the flow.
5. Always cleans up: kills the wrangler-dev process, removes
   `shared-server/.dev.vars`, removes `shared-server/.tmp`, removes the
   per-client mirror sqlite files. `RESULT.md` and the run logs in `.tmp/` are
   kept so the run is auditable.

Override the port with `EXP10_PORT=8893 ./run.sh` if 8791 is taken.

## Why this exists

`shared-server/test-local.sh` proves the CLI surface. This experiment proves the
MCP surface, which is the surface every external agent (OpenCode, Claude Desktop,
Cursor, Pi, …) actually consumes. It also proves cross-client convergence
*through* MCP, not just through one client's mirror — the second `shared-mcp.ts`
process plus the harness's separate stdio session is a second MCP "agent" by
construction.
