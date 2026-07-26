# Loop 2 — pi's MCP is lazy. The harness was the wrong harness.

**Date**: 2026-04-25
**Hypothesis**: For memory-only questions in an empty CWD, an agent with dejavu tools in its MCP advertise produces a better/cheaper answer than one without — based purely on tool descriptions, no SKILL.md, no AGENTS.md, no framing.
**Method**: 5 scenarios × 2 modes, empty `/tmp/dejavu-loop-2/empty/` CWD, pi flags `--no-skills --no-context-files --no-prompt-templates`.

## Result

| id                   | with    | without | save% | with-ok | no-ok | recall | explore-Δ |
|----------------------|---------|---------|-------|---------|-------|--------|-----------|
| s1-private-fact      | 4,969   | 4,973   | 0%    | NO      | NO    | 0      | 0         |
| s2-personal-decision | 5,242   | 5,274   | 1%    | NO      | NO    | 0      | 0         |
| s3-prior-handoff     | 5,616   | 5,226   | -7%   | NO      | NO    | 0      | 0         |
| s4-disambiguation    | 4,927   | 4,995   | 1%    | yes*    | yes*  | 0      | 0         |
| s5-control           | 4,875   | 4,860   | 0%    | yes     | yes   | 0      | 0         |

*both modes were "kinda right" — the phrase check was too lax. The actual planted pronunciation ("DAY-zha") was not used in either response. World-knowledge "DAY-zhah" came out for both.

10.8 seconds parallel.

## What this isn't

Not a measurement of "do tool descriptions work as system prompts." This run failed to test that hypothesis at all.

## What this is

A measurement of pi's MCP loading model.

**Pi's pi-mcp-adapter does not auto-advertise MCP tools.** When pi launches with an MCP config, the server is *configured* but its tools are not visible to the model until the agent issues `mcp { connect: "<server>" }`. With no SKILL.md telling the agent that an MCP server named "dejavu" exists, **the agent has zero signal that MCP tools are available**, and so never connects to anything. All 10 runs (with-dejavu and without-dejavu) had the same effective tools.

That explains the 0% delta. Both arms were the same arm.

In the loop 1 transcripts, the connect call was always present:

```
1. bash: ls ~/.pi/agent/skills/dejavu/...
2. read: /Users/.../skills/dejavu/SKILL.md
...
8. mcp: {"connect":"dejavu"}
9. mcp: {"tool":"dejavu_recall", ...}
```

Pi's first move was reading the SKILL.md to learn what dejavu was, and only *then* connecting. Strip the SKILL.md and the agent has no anchor — nothing to discover.

## What this means for the bigger bet

The "tools as system prompt, no ceremony" hypothesis has two regimes:

1. **Eager-MCP clients (OpenCode, Claude Desktop):** tools are in the system prompt's tool list from turn 1. The agent sees `dejavu_recall` with its description before any user message. SKILL.md is genuinely redundant. Loop 1's data, despite its CWD confound, did show recall calls happening — the tools were *visible*.

2. **Lazy-MCP clients (pi):** tools are not advertised. The agent has to *discover* MCP servers exist before it can use them. SKILL.md is the discovery mechanism. Without it, MCP is invisible.

So: in pi, SKILL.md is not a decaying prompt. It's the entire MCP advertise mechanism, smuggled in via skill-discovery. That's a pi design choice — and it makes "no ceremony" impossible inside pi without changing pi.

For dejavu, this means:
- **OpenCode harness is the canonical harness for testing the hypothesis.** Tools-only, no SKILL, empty CWD, run from OpenCode.
- **Pi can still be a dejavu consumer**, but it requires an entry in `~/.pi/agent/skills/dejavu/SKILL.md` for the agent to know dejavu exists — which is exactly the "ceremony" we wanted to eliminate. That's pi's problem, not dejavu's.

## Action

- Loop 2 results: **invalidated** as a test of the hypothesis. Kept as documentation of pi's MCP model.
- Next loop: rebuild harness around OpenCode (which auto-advertises) or a minimal MCP client that connects+lists at startup.
- No SKILL.md restored. Codebase stays clean.
- For pi-dejavu users specifically, a one-time `dejavu init-pi` could *optionally* drop a marker file at `~/.pi/agent/skills/dejavu/SKILL.md` containing literally just the tool descriptions (not behavior bullets) — but that's a packaging convenience, not a dejavu product feature.
