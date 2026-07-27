# Loops

Each "loop" is a hypothesis + a battery of tests + the findings they produced. They're the evidence base for everything Dejavu claims.

Read in order:

## [Loop 1 — TRASH](./2026-04-25-loop-1-TRASH-confounded.md)
First attempt to test "agents reach for memory unprompted." **Confounded by CWD pollution and SKILL.md presence.** Marked trash, kept as the cautionary tale of how easy it is to test the wrong thing.

## [Loop 2 — pi's MCP is lazy](./2026-04-25-loop-2-pi-mcp-is-lazy.md)
Tried to retest with empty CWD + no SKILL/AGENTS/prompt files. Discovered pi-mcp-adapter doesn't auto-advertise MCP tools — agents have to *discover* the server before connecting. Without SKILL.md as a discovery hint, dejavu was effectively invisible. **All 10 runs collapsed to "no MCP" baseline.** Not a hypothesis test; a learning about the harness.

## [Loop 3 — three meta-tools](./2026-04-25-loop-3-three-meta-tools.md)
Built a custom harness with **three meta-tools** (`search`, `write`, `execute`) over a tool registry, no system prompt, raw Claude Opus via Cloudflare's internal Anthropic gateway. Eight scenarios. **6/8 pass on first run, 7/8 after one search-quality fix.** Token floor: 1,005 — vs OpenCode's 45,321 for the same prompt (2 orders of magnitude lighter). Confirmed: **agents reach for memory when the question shape matches their prior; world-knowledge questions never trigger recall.** That's the boundary.

## [Loop 4 — cross-session chain](./2026-04-25-loop-4-cross-session-chain.md)
The actual dejavu claim: writer agent → handoff → reader agent on same DB picks up. Four scenarios. **c3 was the headline**: writer wrote a handoff describing a refactor, reader recalled it on first turn and **executed the work** (read the file, made the edit, ran tests, reported back). Three iterations of fixes during the loop:

1. **Auto-rollup** chain-shaped slips into session handoffs (now part of the dejavu library).
2. **Always-surface dejavu_recall** in registry search results — flipped c1 from wrong-answer to correct.
3. **`DEJAVU_DB` env var** wasn't honored by the library (only by CLI). Fixed at the source.

These three changes shipped to v0.0.2.

## What's not in here
- Loop 5+: deferred. Open questions in loop 4's epilogue (writer-side gap, multi-day staleness, cross-model handoff) are real but not blockers for shipping.
