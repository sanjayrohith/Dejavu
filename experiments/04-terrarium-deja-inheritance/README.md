# Experiment 04 — Can Dejavu be passed into a Terrarium child?

## Question

Can a Terrarium-spawned child agent inherit Dejavu such that it reads and writes
to the same isolated Dejavu DB the parent is using?

## Hypothesis

H1. Terrarium spawns its child as a normal subprocess, so the child inherits
the parent shell environment. Therefore `DEJAVU_DB` and `DEJAVU_AUTHOR` exported
in the parent shell should be visible to the child.

H2. If the child agent command is `bun run src/cli.ts` (the Dejavu CLI itself,
not an LLM), the child can write a slip into the parent's isolated Dejavu DB.
This proves the *transport* — that Dejavu state can ride down through Terrarium
— without depending on whether an LLM-driven child decides to call the MCP.

H3. Terrarium does not magically inject MCP config; it just spawns a command.
So "Dejavu reaches the child" is purely a function of (a) env inheritance and
(b) what command the parent chooses to run as `--agent`. This experiment
deliberately uses deterministic, scripted agents — not `opencode run` — so
we are not measuring model behavior.

## Scope / non-goals

- We do NOT test whether an LLM child would voluntarily call dejavu MCP.
- We do NOT mutate any user-global config (no `~/.terrarium/config.*` edits,
  no opencode config edits, no `~/.dejavu` writes — we point `DEJAVU_DB` at a
  temp file scoped to this experiment).
- We do NOT fan out further Terrarium runs beyond the one this experiment
  itself spawns. (At most one `terra` call inside `run.sh`.)

## Method

1. `run.sh` creates a temp dir under `experiments/04-.../evidence/` for this
   run. It exports `DEJAVU_DB=<temp>/dejavu.db` and `DEJAVU_AUTHOR=parent-04`.
2. Parent seeds a slip in that isolated DB with `bun run src/cli.ts` to prove
   the DB exists and the parent identity works.
3. Parent invokes `terrarium --agent ./agent/deterministic-agent.sh "<task>"`.
4. The deterministic agent script is a plain bash script that:
   - Prints all `DEJAVU_*` env vars it sees (env-inheritance proof).
   - Re-invokes `bun run src/cli.ts` with a different `DEJAVU_AUTHOR` and writes
     a slip into the same `DEJAVU_DB`, proving the child can write Dejavu state
     into the parent-scoped DB.
   - Runs `dejavu ls` so the child can see the parent's earlier slip too
     (read-back proof).
   - Writes its evidence to a known file path AND stdout (which Terrarium
     captures into its run log).
5. Back in the parent, after `terra` returns, we re-query the same DB and
   assert: it contains exactly one parent slip AND one child slip, authored
   by `parent-04` and `child-04` respectively.

## What "proven" means

- ✅ **Env inheritance proven** iff the Terrarium log for the child run
  contains `DEJAVU_DB=` and `DEJAVU_AUTHOR=` lines with the values the parent
  exported.
- ✅ **Shared-DB read/write proven** iff after the run, the isolated
  `dejavu.db` contains slips authored by both `parent-04` and `child-04`.
- ❌ **Disproven** otherwise. We record exactly which leg failed.

## What this does NOT prove

- That an LLM child agent (e.g., `opencode run`) would *autonomously* choose
  to call the dejavu MCP. That is a behavior/policy question and a different
  experiment.
- That Terrarium injects MCP config into the child. It does not. Whether the
  child agent has a Dejavu MCP wired in is a property of the child agent's own
  config (e.g., its opencode/claude config), not of Terrarium. Terrarium's
  only contribution is env + arg passing.

## Files

- `README.md` — this file (hypothesis)
- `run.sh` — end-to-end runner
- `agent/deterministic-agent.sh` — the deterministic "child agent" command
- `evidence/` — per-run artifacts (env dump, db, parsed assertions)
- `RESULT.md` — final findings after running
