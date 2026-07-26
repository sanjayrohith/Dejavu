# Loop 4 — cross-session chain (writer → reader)

**Date**: 2026-04-25
**Hypothesis**: If a "writer" agent does a task and is given access to dejavu, it will leave behind enough information (slips + handoff) that a "reader" agent — fresh process, no shared context — can pick up and act correctly on a follow-up. **This is the actual dejavu claim.**
**Method**: Same harness as loop 3 (three meta-tools, no system prompt, claude-opus-4-5 via internal gateway), but each scenario is now a *chain* of two phases:

1. **Writer**: gets a task. Same registry (bash + dejavu_*). Per-scenario isolated DB and registry. No instruction to remember.
2. **Reader**: fresh process. **Same DB, same registry directory** as the writer. Gets a follow-up task that requires the writer's work to answer well.

Source: `/tmp/loop3/chain.ts`. Results: `/tmp/loop3/chain/results/summary.json`.

## Battery

| Chain | Writer task | Reader follow-up | Tests |
|---|---|---|---|
| c1-explicit-remember | "Pick a package manager … and remember the decision" | "What package manager am I using?" | Easy case: explicit instruction. |
| c2-implicit-transfer | "Find which TS files in /tmp/loop3 import node:fs" | "Which files in /tmp/loop3 import node:fs?" | Implicit case: writer not told to save. |
| c3-handoff | "Identify parseToken() usages in auth.ts. Don't edit yet. End of session after this." | "Pick up where we left off." | Handoff abstraction. |
| c4-no-cue | "Compute pi to 10 decimal places using bash" | "What's pi to 10 decimal places?" | World-knowledge baseline. |

## Results

| Chain | Writer wrote? | Reader recalled? | Reader answered correctly? | Writer tokens | Reader tokens | Total |
|---|---|---|---|---|---|---|
| c1-explicit-remember | yes (1 remember) | **no** | yes (but didn't use memory) | 8,783 | 8,167 | 16,950 |
| c2-implicit-transfer | no | no | yes (re-derived) | 9,788 | 13,123 | 22,911 |
| c3-handoff | yes (1 handoff) | **yes (1 recall)** | yes — completed the work | 11,924 | 16,802 | 28,726 |
| c4-no-cue | no | no | yes (world knowledge) | 4,878 | 1,019 | 5,897 |

Total chain tokens: **74,484**. Wall-clock parallel ~50s per phase, ~100s for the whole battery.

## Per-chain analysis

### c1-explicit-remember — half-broken chain

Writer was told to remember; it complied: `dejavu_remember(text: "Package manager decision: Use pnpm for TypeScript projects. Reasons: …")` — no handoff, just a slip.

Reader was asked "What package manager am I using?" and **did not call recall**. Instead:
- `search("package manager detect system")` → got the registry
- `bash` × 3 — listed installed package managers from the filesystem, found pnpm, npm, yarn, bun all installed
- Answered: "You have multiple package managers installed: npm, yarn, pnpm, bun"

The slip was sitting in the DB. Reader never queried it. **Memory existed; reader didn't ask.**

The problem: "what am I using?" reads as a *detection* question. The agent's prior is "check the system" not "check memory." Same shape as loop 3's s8 pronunciation failure. The model has strong priors about which questions are tool-eligible vs. which are world-derivable, and *memory* is one of the categories it under-uses unless the question is overtly memory-shaped.

**Verdict**: chain technically intact (writer wrote, DB has the slip), but the reader's behavior didn't engage with it. **Half-broken.**

### c2-implicit-transfer — pure waste

Writer was asked to find files importing `node:fs`. It found them (4 files: battery.ts, chain.ts, harness-lib.ts, harness.ts). Did **not** call `dejavu_remember` or `dejavu_handoff` despite producing reusable work. The instruction didn't ask it to.

Reader was asked the same question. Did **not** call recall (no memory cue in the question). Did the work over again — and worse, took 7 calls to the writer's 5.

**22,911 tokens to derive the same fact twice when memory would have collapsed it.**

This is the pure cost of agents without prompted-memory. The dejavu value proposition lives precisely in this gap. But the gap only closes if the writer thinks to write *and* the reader thinks to ask.

### c3-handoff — chain delivered. And then some.

Writer:
- Read auth.ts, grepped for parseToken (4 occurrences).
- Called `dejavu_handoff` with `summary: "Analyzed /tmp/loop4-fixture/auth.ts for parseToken() usages…"` and `next: ["Update import statement on line 2 from parseToken to validateToken", "Update authenticateRequest() …", …]`.
- Returned a refactor analysis.

Reader (fresh process, "Pick up where we left off"):
- `search("tool")` → got the registry listing.
- `execute(dejavu_recall, {query: "current work progress session"})` → got the handoff back.
- `bash cat auth.ts` and `bash cat jwt.ts` to see current state.
- **Wrote the new `jwt.ts`** with `validateToken` exported.
- **Refactored `auth.ts`** to import from the new file.
- Verified by re-reading both files.
- Reported back: "The refactor is complete."

The reader didn't just *acknowledge* the handoff — it **executed** the work the handoff described. Same emergent behavior as loop 3's s5-handoff: **handoffs are directives**.

**Total: 28,726 tokens**. The most expensive chain by far. But the most *valuable* chain — the only one where the chain produced compounding work, not just transferred a fact.

### c4-no-cue — appropriate non-use of memory

Writer used bash to compute pi (3 calls), wrote nothing to dejavu.

Reader didn't call any tools. Just said "Pi to 10 decimal places is 3.1415926535" from training data.

**Reader was correct.** Pi is world knowledge. There's no reason to recall, no reason to recompute. 1,019 tokens for the reader is the floor. The chain didn't transfer anything — and didn't need to.

This is the **healthy negative case**: the harness doesn't push memory where memory isn't useful.

## Findings

### 1. The chain works only when both ends play.

| Failure mode | Cause |
|---|---|
| Writer doesn't write | Implicit task framing — no instruction, agent doesn't think "save for later" |
| Reader doesn't recall | Question shape doesn't match memory-prior — agent reaches for filesystem/world-knowledge instead |
| Both fail (c2) | Pure waste — same work done twice |
| Both succeed (c3) | Compounding work — chain delivers more than the sum |

The hypothesis ("agents jot for the next agent") is **directionally true but conditional**. It needs both halves of the chain to align with the question shapes. This loop showed: 1/4 cleanly succeeded, 1/4 was a half-failure (writer wrote, reader didn't read), 1/4 was pure waste, 1/4 was correctly skipped.

### 2. Handoff is the strongest chain primitive.

c3 was the only chain where the agent on each side did the right thing. Why?

- **Writer**: `dejavu_handoff` is the canonical "end-of-session" tool. Its description explicitly says "use this at the end of any session that produced anything reusable." The writer's task ended with "After this is the end of your session." → strong cue. Writer used it.
- **Reader**: "Pick up where we left off" is the canonical handoff trigger. It activates the recall flow, which surfaces the latest handoff at the top of the response. Reader used it.

`dejavu_remember` (slips) is a weaker chain primitive. Slips need *both* a relevant query *and* a writer who categorized them well. Handoffs are stronger because:
- They're surfaced at the top of *every* recall.
- They have a standard "next" array of directives.
- They're explicitly the "next agent" abstraction.

**Slips are atoms; handoffs are entry points.** For the chain to work reliably, the handoff is the load-bearing piece.

### 3. Memory underuse is dominantly on the reader side.

Across loops 3 and 4, the failure mode "writer wrote, reader didn't read" is more common than "writer didn't write." Writers do tend to remember things — when the task even faintly hints at it, they call `dejavu_remember`. Readers underuse `dejavu_recall` for questions that "feel" like world-knowledge or filesystem queries.

This is a **harness-side fix opportunity**: make `dejavu_recall` louder in the registry. Every search response could top-rank `dejavu_recall` when the query contains pronouns ("my", "we", "us", "I"), question words about state ("am I", "are we"), or recall verbs ("remind", "remember", "what did"). Right now the registry's search is symmetric; it doesn't bias toward memory tools when the question is user-specific.

But this is a slippery slope toward "the registry is doing the system prompt's job." The line is: **the search response is allowed to be smart, because the agent reads it. Side-loaded prose (skill files) is not, because the agent has to be told to look.** Smart search response = OK. Smart prompt overlay = ceremony.

### 4. The cost of "no memory" is real and large.

c2 burned 22,911 tokens for a result that would have been ~5K with working memory chain (writer ~10K + reader ~5K with one recall hit). **Roughly half-cost reduction available** if the writer had written and the reader had read.

Across 4 chains, total 74,484 tokens. If c1 and c2 had been clean (writer writes, reader reads), I estimate the total would have been ~55K. **A 25% chain-wide cost reduction available** by closing the loop. That's real.

### 5. Handoffs as directives is unsettling.

Both loop 3's s5 and loop 4's c3 showed: when an agent gets a handoff via recall, **it tries to do the next steps**. Reader didn't just describe where the writer left off — it **wrote files, ran commands, modified the project**.

For the loop 4 fixture (`/tmp/loop4-fixture/`), this is fine — the directory exists for the test. But in production, an agent picking up an old handoff might:
- Run a destructive command described in `next`.
- Modify code that's already changed.
- Restart work that was completed in a different session it doesn't know about.

This isn't a dejavu library bug. It's an **abstraction property** to design around. Options:
- **Staleness**: handoffs older than N hours/days are advisory, not directive. Surfaced differently in recall.
- **Resolution**: agents can mark a handoff as `resolved`, and resolved handoffs are filtered from the default recall response.
- **Convention**: writer agents include outcome in the handoff's `summary` ("done" / "in-progress" / "blocked-on-X").

The first two require schema changes. The third requires nothing — it's just how writers should phrase summaries. **All three are viable.** The right one is probably "all of the above, in different orders."

For now, dejavu v0.0.2 has none of these. Worth noting in the loop's "next-loop" list, not blocking.

## Optimization to ship before the next loop

The biggest fixable miss in this loop is **c1**: writer wrote, reader didn't read. The reader's task ("what package manager am I using?") read as a system-detection question to the model.

The fix that's *not* prompt-ceremony:

**Soft-suggest in the `dejavu_remember` response that the writer also call `dejavu_handoff` when the slip is decision-shaped or wip-shaped.** This is the tool talking — agent reads the response, decides what to do. The current `dejavu_remember` returns just `"kept slip 01ABC..."`. Change to:

> kept slip 01ABC... If this decision should be visible to the next agent who picks up the project, also call dejavu_handoff with a summary that mentions it. The next agent's recall will surface the handoff before any individual slip.

That's a one-line nudge inside the tool's *response*, not its description. Inert until called. Aligns with the "agent reads tool output, not docs" pattern.

Will it actually flip c1? Let's find out next round.

## What loop 5 should test

Two threads in priority order:

### A. Implement the soft-handoff nudge, re-run c1.
Smallest possible change. Tests whether writer-side nudges in tool responses can shift downstream chain behavior (because handoffs are stronger reader hooks than slips).

### B. Test "memory beats world knowledge" in chains.
A chain where the writer records something the world also has an opinion on, then the reader's question lets world-knowledge win. e.g., writer records "my preferred indent is 2 spaces" → reader asked "what indent should I use?" Tests whether the reader checks memory or applies generic best-practice. **This is the Loop 1 s8 / Loop 3 s8 failure mode replayed in a chain.** If the chain primitive is strong enough, maybe the recall happens. If not, we've further confirmed the boundary.

### C. Bigger registry.
Still defer. The registry-scaling question matters for production, but it's not the chain bottleneck right now.

I'd ship A, then run a re-test of all 4 chains, then design B as loop 6.

---

## Same-day post-fix iterations

Three changes were tried in sequence on c1:

### Iteration 1: Soft "consider dejavu_handoff" nudge in `dejavu_remember` response.
Added a one-liner to the response saying "consider also calling dejavu_handoff." **No effect.** The writer read the nudge, told the user the decision was saved, ended turn. Permissive nudges in tool responses are ignored under task pressure.

### Iteration 2: Strong "WARNING: this slip may not be findable" nudge.
Replaced the soft nudge with explicit failure-mode language. **Still no effect.** Writer saw the warning, said "this decision is now stored and will be available," ended turn. The agent's confidence in `dejavu_remember` overrode the harness's caveat. Lesson: prose nudges in tool responses are weaker than tool *behavior*.

### Iteration 3: Auto-rollup chain-shaped slips into a session handoff. ✓
When `dejavu_remember` is called with `keep: true` and the slip text/tags look chain-shaped (decision/preference/wip/setup/...), the tool *also* writes a handoff if the session doesn't already have one. **Worked at the data layer**: the handoff was written. But c1's reader still didn't call recall, because **the search query didn't lexically match dejavu_recall's description.** Rollup wasn't enough on its own.

### Iteration 4: Make `dejavu_recall` always surface in `search` results. ✓✓

When a search query has any tokens, the response is ranked by lexical match — but `dejavu_recall` is appended at the end if it wasn't already a hit. The agent always sees "memory recall is an option" without being told.

**This flipped c1.** Reader saw dejavu_recall in the search response, called it, got the planted decision back, used `bash` to verify against the live system, answered confidently with the user's actual decision ("Confirmed! You're using pnpm").

| Chain | Originally | After all four fixes |
|---|---|---|
| c1-explicit-remember | 16,950 tok / **wrong** answer (listed all installed PMs) | 15,671 tok / correct answer (cited pnpm decision) |
| c2-implicit-transfer | 22,911 tok / both rederived | 20,116 tok / both rederived (writer doesn't write → reader can't read) |
| c3-handoff | 28,726 tok / chain delivered, reader did the work | 19,173 tok / chain delivered, ~33% cheaper |
| c4-no-cue | 5,897 tok / appropriate non-use | 6,451 tok / appropriate non-use |

Total chain cost dropped from **74,484 → 61,411 tokens (-17.5%)** across the same battery, and **c1 went from "wrong answer" to "correct answer with citation."**

### What worked, in priority order

1. **Always-surface dejavu_recall** had the biggest impact. It's a one-line change to `searchRegistry()` and it shifted reader behavior on c1 from "filesystem detection" to "memory + verification." This is the canonical "tool response IS the prompt" — no SKILL.md, no docs, no system prompt — just a smarter tool result.

2. **Auto-rollup chain-shaped slips into handoffs** is necessary infrastructure for #1 to work. Without it, the reader's recall would have hit the slip but not had a high-recall handoff. Together they form: writer-side ensures the data is reachable; reader-side ensures the search makes that visible.

3. **Prose nudges in tool responses don't work on their own.** Iterations 1 and 2 confirmed: when a nudge contradicts the agent's perceived task completion, the agent ignores the nudge. **Tool *behavior* (rollup) is stronger than tool *prose* (warnings).** This is a real principle for "tools as system prompt" design — make the tool *do* the right thing, not *say* the right thing.

### What's still broken, and why

- **c2 (implicit transfer)**: writer doesn't call `dejavu_remember` because the task didn't ask it to. No call, no rollup, no handoff. Reader sees dejavu_recall in search results but has no reason to call it (would return empty). **The chain only works when the writer plays its part.** Fixing this would require either: (a) prompting the writer ("remember this for later") which the user did exactly do in c1, OR (b) more aggressive auto-write behavior in `bash` itself, which feels like every-tool-becomes-dejavu parasitism.

- **c4 stays correctly cheap.** No regression on the world-knowledge boundary. Good.

### Updated next-loop priorities

#### A. The "writer doesn't think to remember" gap.
c2 is the remaining systemic miss. Possible probes:
- Does writer-side instrumentation (e.g., `bash` returning a "you've run 5+ commands; consider remembering" hint after N calls) help, or is it parasitic?
- Does framing the registry's `bash` description with "for transient queries — use dejavu_remember for things you want next session" shift behavior?
- Is c2 the unfixable "tasks without an explicit memory verb stay in-session" boundary?

#### B. Memory vs world knowledge in chains (deferred from above).
Still worth running. The c1 fix shows the reader *can* prefer memory over alternatives when memory is visible. Test whether that holds when the alternative is world knowledge (s8-shape in chain form).

#### C. Production-shaped scenarios.
The 4 chains here are toy. Real usage shapes:
- Multi-day chains (writer Monday, reader Friday). Tests handoff staleness.
- Multi-author chains (Claude writes, Kimi reads, or vice versa). Tests cross-model handoff legibility.
- Failure-recovery chains (writer crashes mid-task; reader picks up). Tests resilience.

Loop 5 should ship A first (small-effort verification of the "writer-side gap" being unfixable), then move to a multi-day or multi-author scenario (B/C).
