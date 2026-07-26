# Loop 1 — Agent-to-agent handoff

**Date**: 2026-04-25
**Hypothesis**: Agent A leaves a useful slip/handoff. Agent B (fresh process, no shared context) picks it up and acts on it correctly, in fewer tokens than figuring it out from scratch.
**Method**: 5 scenarios × 2 modes (with dejavu / without dejavu), `pi -p --no-session --mode json`, parallel execution via `/tmp/dejavu-loop/run.ts`.

## Results

| Scenario          | With dejavu | No dejavu  | Save% | With✓ | No✓ | Recall calls | Δ explore |
|-------------------|-----------|----------|-------|-------|-----|--------------|-----------|
| s1-decision       | 7,763     | 7,278    | -7%   | yes   | yes | **0**        | 0         |
| s2-gotcha         | 7,188     | 8,370    | +14%  | yes   | yes | 1            | -2        |
| s3-preference     | 7,130     | 6,681    | -7%   | NO    | NO  | **0**        | 0         |
| s4-handoff        | 12,547    | 21,743   | **+42%** | yes | NO  | 2            | **-11**   |
| s5-decoy          | 6,203     | 6,264    | +1%   | yes   | yes | 0            | 0         |

Wall-clock: 95.5 seconds (parallel). Cost: ~$0.40 total across 10 pi invocations.

## Findings

### 1. Memory-cued questions win big (s2, s4)

**S2 ("any gotchas?")** explicitly invites memory. Agent recalled, surfaced the planted gotcha verbatim ("never use newUniqueId for user-keyed state"), saved 1,182 tokens vs the no-dejavu baseline that had to reason from general knowledge. **+14% savings, correct.**

**S4 ("pick up where we left off")** is the headline result. The fallback handoff lookup (added in the prior round) fired correctly. Agent surfaced the prior session's handoff — file name, line number, next steps — without a single bash/read/grep call. The no-dejavu control burned **15 explore calls and 21,743 tokens** trying to reverse-engineer "where we left off" from filesystem state, and **failed** (got confused, never found auth.ts because it doesn't exist in the test directory). **+42% savings, dejavu-only correct.**

### 2. "This project" overrides memory cues (s1, s3)

**This is the most important finding.**

S1 (*"Should I use better-sqlite3 or bun:sqlite for **this project**?"*) and S3 (*"Add react-query to **this project**"*) had the answer in the DB. The agent had dejavu available. The agent **did not call recall — zero times**. It went straight to `bash` to inspect the working directory.

The phrase "this project" reads to the agent as "look at the filesystem", not "look at memory". The agent's prior is **project context = directory**, not **project context = remembered facts about the user/codebase**. Adding more bullets to SKILL.md will not fix this — it's a strong prior fighting a weak suggestion.

**Both modes produced *correct-ish* answers** (the agent guessed bun:sqlite from the shebang line of `run.ts` in the harness directory — accidentally right) but neither used the planted decision-with-reasoning. The system *could* have answered with confidence and citation; instead both modes answered with plausible inference.

### 3. Explore-call substitution is real

S2: dejavu saves 2 explore calls. S4: dejavu saves 11 explore calls. When recall hits, the agent **substitutes** memory for filesystem exploration. That's the killer mechanism — not "fewer tokens because shorter answer" but "fewer tokens because no exploration needed."

When recall doesn't hit (or isn't tried), explore deltas are 0 — agents don't change their behavior. So the saving comes entirely from **eliminating exploration**, which means the upside scales with how bad the alternative exploration would have been.

### 4. Overhead of having dejavu loaded is small (~7%)

S1, S3, S5 show roughly +0% to +7% token overhead just from having dejavu's tools advertised in the context window (their schemas eat tokens whether or not they're called). That's the cost of admission. **It's amortized away by even one s4-style hit.**

### 5. The decoy is healthy

S5 made zero recall calls and produced an identical-quality answer in both modes (1% delta is noise). Agents do *not* over-reach for memory when there's no memory cue. The earlier worry about false positives is unfounded at this scale.

## What's broken

### A. Recall is invisible to "this project" framing

**Symptom**: questions framed as "this project" / "this codebase" / "in this repo" cause the agent to go to filesystem first, memory never.

**Root cause**: the agent treats "this" as a deictic pointing at the working directory. Memory tools advertise themselves as cross-session — they don't claim to know about *this* project specifically. The advertising is wrong.

**Fix to try**: change the dejavu_recall description to explicitly include "use this for project-specific decisions, conventions, and preferences — facts the user expects you to know about *this* codebase across sessions, not just generic best practices."

### B. Recall doesn't return anything when query is generic and corpus has 1 row

S1 wouldn't have hit anyway: query "better-sqlite3 vs bun:sqlite" matches the slip, but the agent never called it. *If* it had called recall, would it have found the decision? Let me check the bench harness — yes, the recall benchmark uses `corpus has 1 target + N decoys` and gets 100% recall@1. So the *retrieval* is working fine. The problem is **the agent doesn't ask**.

### C. Token savings only when recall fires AND exploration is expensive

S2 saved 14% (+1 recall, -2 explore). S4 saved 42% (+2 recall, -11 explore). The savings come from the *avoided* exploration, not the recall itself. So memory only "pays" when:
1. The agent decides to call recall, AND
2. The alternative is expensive exploration.

For pure-knowledge questions (s1's "which library should I use") the alternative is *cheap* — just answer. Memory still gives a *better* answer there (cited decision vs guess) but doesn't save tokens.

## Optimizations to ship before next loop

1. **Rewrite `dejavu_recall`'s tool description** to break the "memory ≠ this project" prior. Explicitly say it covers project-specific knowledge.
2. **Make recall responses more directive when trust is high.** Currently the response is `**high** <id>: <text>`. For a high-trust hit, prepend `Use this — the user previously decided/recorded:` so the agent treats it as authoritative, not optional.
3. **Add a fallback "broaden query" hint** in the recall response when there are zero hits. Right now it just says `(no hits)`. Tell the agent "try a broader query before falling back to general knowledge."

These are SKILL.md/tool-description changes, no code changes to the storage layer. The recall benchmark still has to pass after.
