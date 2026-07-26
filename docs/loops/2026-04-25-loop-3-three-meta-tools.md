# Loop 3 — three meta-tools, no system prompt, no skill, no agents.md

**Date**: 2026-04-25
**Hypothesis**: An agent given exactly three meta-tools — `search(query)`, `write({name, code})`, `execute({name, args})` — over a directory of available tools, with no system prompt, can steer itself toward any task. The directory replaces the system prompt. The agent's own tool-writing replaces hardcoded tooling.

**Method**: Custom harness, 8-scenario battery, parallel.

- LLM: `claude-opus-4-5` via Cloudflare's internal `opencode.cloudflare.dev/anthropic` gateway (Anthropic Messages API, raw, no OpenCode ceremony).
- Three meta-tools advertised. **No system prompt.**
- Registry seeded with: `bash`, `dejavu_recall`, `dejavu_remember`, `dejavu_handoff`. Per-scenario isolated registry directories so parallel runs don't trample each other.
- Per-scenario isolated dejavu DBs.
- Loop terminates on `end_turn` or 30 tool calls.

Source: `/tmp/loop3/{harness-lib.ts, battery.ts}`. Results: `/tmp/loop3/results/summary.json`.

## Headline numbers

- **Total cost**: 32,398 tokens across 8 scenarios. Wall-clock 43.7s parallel.
- **Pass rate**: 6 / 8.
- **Cost floor**: 994 tokens for "what is 2+2" — `\~25` tool-description tokens advertised, 966 input, 42 output. **OpenCode's floor for the same prompt was 45,321.** Two orders of magnitude.

## Per-category results

| Category          | Runs | Avg tokens | Avg tool calls | Pass |
|-------------------|------|------------|----------------|------|
| trivial           | 1    | 994        | 0.0            | 1/1  |
| tool-build        | 1    | 6,678      | 3.0            | 1/1  |
| memory-hit        | 1    | 4,777      | 3.0            | 1/1  |
| memory-miss       | 1    | 4,328      | 3.0            | 1/1  |
| handoff           | 1    | 2,225      | 1.0            | 0/1  |
| compound          | 1    | 8,073      | 3.0            | 1/1  |
| memory-write      | 1    | 4,222      | 2.0            | 1/1  |
| memory-vs-world   | 1    | 1,101      | 0.0            | 0/1  |

## What worked

### s2-tool-build — "list files in /tmp/loop3"
Three calls: `search("list files directory filesystem")` → no match → `write(list_files.ts)` → `execute(list_files, {path, recursive: false})`. The agent built a tool with structured arguments matching the user's "exclude registry subdirectory" caveat — bash + ls would have been simpler but the agent chose the higher-leverage abstraction.

### s3-memory-hit — "what did we decide about better-sqlite3 vs bun:sqlite?"
Three calls: `search("better-sqlite3 bun:sqlite sqlite decision notes")` → `dejavu_recall` ranked first → `execute(dejavu_recall, {query: "better-sqlite3 bun:sqlite sqlite decision"})`. Found the planted slip with `[low — verify]` trust, cited it, and **proactively offered to promote it via keep**. Emergent behavior, not in any prompt.

### s6-compound — "count TS lines, exclude registry"
Three calls: `search` → `write(count_typescript_lines.ts)` with an `excludeDirs` parameter built into the tool's schema → `execute`. Counted 1,929 lines across 37 files. The agent encoded the user's constraint into the tool's API. Reusable.

### s7-memory-write — "remember I prefer pnpm"
Two calls: `search("preferences memory remember user settings")` → `execute(dejavu_remember, {text, tags, keep: true})`. Wrote a slip more general than the user's request — "Always use pnpm for package management tasks" rather than the literal "I prefer pnpm." Generalized the rule for future use. Tagged with `preference, tooling, package-manager, pnpm`.

### s4-memory-miss — "preferred test runner?"
Three calls: agent tried `dejavu_recall` with multiple phrasings, got no hits, told the user honestly that nothing was recorded and offered to remember the answer once told. Same behavior as the original loop-1 finding — agent doesn't hallucinate when memory is empty.

## What broke

### s5-handoff — "pick up where we left off"

Agent searched the registry with `query: "*"`. The harness's substring search returns no tools for that query (no token after stripping). Empty result → agent assumed the entire system was empty → declared no prior work and asked what to build next. **Bug is in the search response**: empty results are interpreted as terminal. The query was wrong, but the deeper issue is that empty `search()` returns offer no path forward — no hint to retry with a topical query.

**Fix candidates**:
- `search()` returns the most popular / recently-used tools when the query is syntactically empty.
- Empty-result response includes a hint: `"no tools matched. Try terms like: memory, file, http, dejavu..."` or list 3-5 tool names from the registry.
- Eat any non-alphanumeric characters in queries server-side instead of returning empty.

### s8-memory-vs-world — "how do you pronounce dejavu?"

Agent answered with **zero tool calls**. The model's prior on "how do you pronounce X" is a phonetics question, not a memory question. The seeded slip about "DAY-zha" was never consulted. The agent confidently gave the world-knowledge answer "day-ZHAH" — which was wrong by user-recorded preference.

This is the second time we've seen this exact failure (loop 1 hit it too). The pattern is clear: **memory wins when the question framing makes it a memory question; world knowledge wins when it doesn't.** Models have strong domain priors. Pronunciation is one. There are others (likely: trivia, pure technical facts, "how does X work" questions).

This is **not a dejavu problem and not a harness problem.** It's a model-prior problem. The agent doesn't search because it doesn't think it needs to. No registry-search improvement will fix it because the registry never gets queried.

The only fixes are:
1. A system prompt nudge ("for any user-specific question, search memory first") — exactly the ceremony we removed.
2. A model that's been trained to reach for memory more aggressively (a future-Claude, future-Kimi).
3. Accept that this is the boundary of "tools = system prompt" and live with it.

I lean toward #3. The bet was always going to have a boundary. It's good to know where.

## Surprising findings

### The agent generalizes user requests when writing memory.
s7 didn't just store "user prefers pnpm." It stored "User prefers pnpm over npm and yarn. npm and yarn break their workspace setup. Always use pnpm for package management tasks." It re-stated the rule for future-agents. **The act of writing memory is itself an act of generalization** — the agent wasn't told to do this.

### The agent encodes constraints into tool schemas.
s6 didn't just shell out `find . -name '*.ts' | xargs wc -l`. It built a tool with `excludeDirs` as a typed argument because the user's request had an exclude clause. **The agent is making constraints reusable**, even when no one asked.

### Search-query strategy varies wildly between scenarios.
- s2 (file listing): `"list files directory filesystem"` — descriptive
- s3 (memory hit): `"better-sqlite3 bun:sqlite sqlite decision notes"` — topical+functional mix
- s5 (handoff fail): `"*"` — wildcard, broken
- s7 (memory write): `"preferences memory remember user settings"` — functional

The agent has no consistent search strategy. It chooses query terms based on what it expects the *tool* to be named, not what the *task* is about. **This is exploitable as a harness improvement** — better-quality tool descriptions (with synonyms for both the function and the domain) should drastically improve hit rate without any agent-side change.

### Empty search results are dangerous.
s5 demonstrates that an empty `search()` response can lock the agent into the wrong world model ("there's nothing here"). Compare to recall returning `(no hits)` for dejavu — that case the agent retried. The difference: dejavu recall *had been called* by then, so the agent had a path. Search-empty offered no path. **Empty responses need to be self-extending.**

## Cost analysis

For a hypothesis-confirming run, this is cheap:

- **Trivial**: 994 tokens (~$0.005 with Opus)
- **Tool-using**: 4-8K tokens (~$0.02-$0.04)
- **Total battery (8 scenarios)**: ~32K tokens, well under $0.20

For comparison, a single OpenCode TUI session running the same `claude-opus-4-5` against `cf-portal` MCP (auto-advertise everything) starts at 45K input tokens **per turn**. Five turns = the entire battery. The harness is on the order of 50× cheaper for equivalent agentic work.

The savings come from:
1. **No system prompt.** Zero tokens spent advertising "you are an agent..."
2. **Three tools, not 70.** Cf-portal alone advertises ~50 tools in MCP, plus pi/OpenCode's built-in 6-12. The harness has 3.
3. **No skill files, no AGENTS.md.** Discovery via `search()` instead of pre-load.

This isn't free. The cost is paid in **discovery latency**: every tool the agent uses costs an extra `search()` call before it can `execute()`. For tasks the agent does often, this is fine — it's a constant overhead. For tasks where the registry has 100+ tools and the agent needs to find one, it could become a bottleneck.

That trade is worth measuring in a future loop.

## What this teaches about dejavu

The hypothesis we cared about was: "do agents reach for dejavu unprompted?"

In this harness, with a registry where dejavu is one of four tools, the agents:
- **Reached for `dejavu_recall`** when the question framed itself as memory-related (s3, s4, s5*) — *star because s5's failure was a search-side bug, not a dejavu-side bug*.
- **Reached for `dejavu_remember`** when the question was a write-memory request (s7), and **enriched the user's request** with generalization and tagging.
- **Did NOT reach for dejavu** when the question framed itself as world-knowledge (s8, and arguably s5).
- **Generalized when storing** — wrote richer slips than asked.

That's a clear mandate for dejavu's current shape. Memory-shaped questions get memory-shaped behavior. The boundary is the model's prior on "is this a memory question?" — which we cannot influence from inside the tool.

## What's next

Three directions, in priority order:

### 1. Sharpen search() to be self-extending on empty.
Loop's biggest fixable bug. Add a retry hint or pre-populated suggestion list when no tokens match. **One file change, ~10 lines.** Re-run battery to confirm s5 flips to pass.

### 2. Test scaling with a larger registry.
Right now 4 tools. What happens at 50? At 500? The hypothesis says agents will use `search()` to slice through it. That's the second-order claim worth testing — the harness scales with registry size while ceremony-laden harnesses scale with system-prompt size.

### 3. Cross-session test (the original dejavu goal).
This loop has each scenario in its own DB. The real dejavu value is two agents on the same DB across sessions. Run a "writer" agent that does the work + handoffs, then a "reader" agent on the same DB asks the follow-up. Measure whether the reader uses the writer's slips/handoff.

I'd do **#1 next round, #3 the round after**, defer #2 unless the registry-size question gets concrete. Loop hypothesis: test cheap improvements first, measure, only then invest in big changes.

---

## Post-fix run (same day)

Implemented #1 and a related dejavu library bug-fix; re-ran the battery.

### Changes

1. **`searchRegistry`**: strip non-alphanumerics from the query (so `"*"` and similar produce zero tokens), and on zero matches return a self-extending response listing the registry's tools with truncated descriptions plus an instruction to retry or `write()`.
2. **`defaultDbPath()`**: now reads `DEJAVU_DB` env var. Was silently ignored by library callers (only the CLI was honoring it). Real product bug discovered while debugging s5 — the harness was passing `DEJAVU_DB` to the library and the library was using `~/.dejavu/dejavu.db` regardless. Tests + bench still 100%.

### Post-fix numbers

| Category          | Pre tokens | Post tokens | Pre calls | Post calls | Pre pass | Post pass |
|-------------------|------------|-------------|-----------|------------|----------|-----------|
| trivial           | 994        | 1,005       | 0         | 0          | yes      | yes       |
| tool-build        | 6,678      | **4,220**   | 3         | 2          | yes      | yes       |
| memory-hit        | 4,777      | 5,022       | 3         | 3          | yes      | yes       |
| memory-miss       | 4,328      | 4,034       | 3         | 2          | yes      | yes       |
| handoff           | 2,225      | **20,621**  | 1         | 10         | **NO**   | **yes**   |
| compound          | 8,073      | 9,738       | 3         | 4          | yes      | yes       |
| memory-write      | 4,222      | 4,255       | 2         | 2          | yes      | yes       |
| memory-vs-world   | 1,101      | 1,125       | 0         | 0          | NO       | NO        |
| **aggregate**     | **32,398** | **50,020**  | —         | —          | **6/8**  | **7/8**   |

Pass rate: 6/8 → 7/8. s5 flipped to pass. s8 remains the model-prior boundary (no fix possible without prompt ceremony).

### Findings from the post-fix run

#### S2's token cost dropped 37% from a tiny search change.
Pre: agent did `search → write → execute` (3 calls). Post: agent did `search → execute(bash)` (2 calls). When the search response *included examples of what's available*, the agent saw `bash` in the listing and used it instead of writing a custom tool. **The agent's "write a tool" reflex was actually overhead** in this case — it wrote a custom tool because it didn't realize `bash` already existed. Better search visibility, less wheel-reinvention.

This is a deeper finding than I expected: **richer search responses cause the agent to use existing tools instead of writing new ones**. The trade is between the cost of writing a higher-abstraction tool (more tokens up front, reusable later) vs. invoking a generic primitive (cheaper, less reusable). Surface affects choice.

#### S5's behavior was extraordinary.
The agent's full sequence on "Pick up where we left off":

1. `search("*")` → got the new self-extending response listing all 4 tools.
2. `execute(dejavu_recall, {query: "recent work session progress"})` → got the planted handoff back: "Mid-refactor of auth.ts. Next: migrate JWT parsing helper to lib/jwt.ts. Tests will fail until move is complete."
3. `execute(bash, "cat auth.ts; ls -la")` — looking for the file mentioned in the handoff.
4. `execute(bash, "find . -name 'auth.ts' -o -name 'jwt.ts'")` — when it wasn't in CWD.
5. `execute(bash, "find /tmp -name 'auth.ts'; find ~ -maxdepth 4 -name 'auth.ts'")` — broader search.
6. `execute(bash, "pwd && ls -la scenarios/")` — orienting.
7. `execute(bash, "cat /Users/jcoeyman/lab/src/lib/auth.ts")` — found a real `auth.ts` in a real project.
8. `execute(bash, "cat /Users/jcoeyman/lab/src/lib/jwt.ts; ls .../lib/")` — checking if the move was already done.
9. `execute(bash, "grep -r 'parseToken|JWT|jwt' /Users/jcoeyman/lab/src/lib/")` — verifying.
10. `execute(bash, "cd /Users/jcoeyman/lab && npm test")` — **ran the actual test suite**.

It then concluded the handoff's "tests will fail" claim was stale because `npm test` reported 33 passing / 0 failing, and reported back to the user that the work appeared to already be complete or mismatch the current state.

**The agent treated the handoff as a directive, not as a string.** It used memory to drive *action*, not just to inform. This is the deepest validation of the dejavu-handoff abstraction we've gotten — handoffs work as intended, with no prompting at all about how to use them.

The 20K-token cost is a feature, not a bug, in this read: the agent did the work asked of it. "Pick up where we left off" is itself a directive verb, not a recall request. The cost is the cost of doing the work.

This also exposes a subtle hazard: an agent acting on an old handoff might do real work (like running tests, modifying files) on real systems. In production, the handoff lifecycle needs to think about staleness — old handoffs shouldn't drive action. Dejavu's current model has no staleness for handoffs (they don't expire). Worth considering: a `handoff.completed_at` field, or a "handoffs older than N days are advisory only" convention, or letting agents themselves mark a handoff as resolved.

#### S8 is unfixable without ceremony.
Same outcome as before: 0 tool calls, world-knowledge answer, wrong pronunciation. The pattern is now clear across loop 1 + loop 3. **The boundary of "tools as system prompt" is the model's prior on whether a question is a tool-eligible question.** Pronunciation reads as trivia. Trivia gets answered from world knowledge. Memory never gets asked.

The fix exists — system-prompt nudge "for any user-specific question, search memory first" — but it's exactly the ceremony the bet rejects. **Accepting this boundary is part of the bet.** Some questions will get model-prior wrong answers. The dejavu value proposition is for the questions where memory wins, which is the majority of agentic work.

### What this loop teaches us

1. **`search` quality is the lever.** A 10-line change to its empty-result behavior moved the agent's behavior more than any prompt change ever could. The harness's *responses* to tool calls are the actual control surface for agent behavior in this design.

2. **The agent prefers existing tools when they're visible.** S2's drop from 3 calls to 2 happened because the empty-search response listed `bash` and the agent recognized it could use that instead of writing `list_files.ts`. Surfacing existing tools = reducing redundant tool-writing.

3. **Handoffs become *executable* in this harness.** Not just informational. The agent reads a handoff and tries to do the next thing. This is wildly powerful and slightly dangerous; needs design thinking on staleness.

4. **The "memory vs world knowledge" boundary is real and stable.** Two loops, same failure mode on the same shape of question. Don't keep bashing on it; accept it; design around it.

5. **`DEJAVU_DB` env-var was a real bug for library users.** Library callers couldn't isolate which DB they hit. CLI worked, library didn't. Found via the harness, fixed at the source. Pure win.

### Where loop 4 should go

Cross-session, the original dejavu goal. Two agents in sequence, sharing a DB:

- **Writer**: given a task, does the work, calls `dejavu_remember` and `dejavu_handoff` along the way.
- **Reader**: a fresh agent (new harness instance, new context) on the same DB, given a follow-up question that requires the writer's context.

Measure: does the reader find what the writer wrote? Does the handoff carry the right load-bearing detail? Does the writer write *enough* without prompting? Does the reader use it?

This is the **end-to-end test of the dejavu product proposition**: agents jot for the next agent, and the next agent picks it up. Loop 3 confirms each agent's individual behavior. Loop 4 confirms the chain.
