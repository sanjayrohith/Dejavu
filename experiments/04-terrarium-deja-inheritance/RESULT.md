# Experiment 04 — Result

**Question:** Can Dejavu be passed into a Terrarium child?

**Verdict:** ✅ **PROVEN** for the transport layer.
Terrarium children inherit parent env vars (including `DEJAVU_DB`,
`DEJAVU_AUTHOR`) and, if the child command runs the Dejavu CLI, the child reads
and writes the same isolated SQLite DB the parent is using.

Out of scope (and explicitly **not proven**): whether an LLM-driven child
(e.g., `opencode run`) *autonomously chooses* to invoke the Dejavu MCP server.
That is a model-behavior question and would require a separate experiment.

## Evidence runs

- `evidence/run-20260517-071007/` — first run; one assertion failed due to a
  too-narrow grep pattern in my assertion (not a behavioral failure — the
  underlying evidence files showed the child write *did* land). Fixed and
  re-ran.
- `evidence/run-20260517-071026/` — final clean run. All 6 assertions PASS.
  `RESULT=PROVEN`. **This is the canonical evidence run.**

## What the canonical run shows

`run-20260517-071026/assertions.txt`:
```
PASS: child-env file written
PASS: child saw DEJAVU_DB=…/evidence/run-20260517-071026/dejavu.db
PASS: child saw DEJAVU_AUTHOR=parent-04 (inherited)
PASS: parent inbox contains a message from child-04
PASS: child saw parent-04's earlier message in inherited DB
PASS: isolated DB file exists at $DEJAVU_DB
```

### Env inheritance (proves H1)

`run-20260517-071026/child-env.txt`:
```
DEJAVU_DB=<repo>/experiments/04-terrarium-dejavu-inheritance/evidence/run-20260517-071026/dejavu.db
DEJAVU_AUTHOR=parent-04
DEJAVU_SESSION=<unset>
EXPERIMENT_EVIDENCE_DIR=<repo>/experiments/04-terrarium-dejavu-inheritance/evidence/run-20260517-071026
TERRARIUM_RUN_ID=ter_20260517111026828_li7iev
TERRARIUM_DEPTH=2
```

Note `TERRARIUM_DEPTH=2` (parent was `ter_…fw0jy3` at depth 1; child run is
its direct descendant). The Dejavu vars exported by `run.sh` are visible
verbatim inside the child process. Terrarium did nothing special — it
`spawn`s the child agent and the child inherits the calling shell's env.

### Shared-DB read/write (proves H2)

Parent first wrote a message in step 2:
```
parent-04 -> child-04  thread 01KRTT2NV744PJKPJ6X9A6KX72
  ping from parent-04, run=20260517-071026
```

Child, running entirely inside Terrarium, saw it via `dejavu inbox --all`
(`child-inbox.txt`):
```
01KRTT2NV744PJKPJ6X9A6KX72  pending  2026-05-17T11:10:26  parent-04 -> child-04
  ping from parent-04, run=20260517-071026
```

Child then wrote its own message authored as `child-04`
(`child-send.txt`):
```
01KRTT2PB68ZZHAT8V2HFXVM17  pending  2026-05-17T11:10:27  child-04 -> parent-04
  hello from terrarium child, run=ter_20260517111026828_li7iev
```

Parent, after Terrarium returned, saw it via `dejavu inbox parent-04 --all`
(`parent-inbox-after.txt`):
```
01KRTT2PB68ZZHAT8V2HFXVM17  pending  2026-05-17T11:10:27  child-04 -> parent-04
  hello from terrarium child, run=ter_20260517111026828_li7iev
```

`child-stats.txt` reports the child saw the same DB path the parent
exported, and counted `messages: 2 pending:2` — both rows, written from
two different processes (parent shell + Terrarium child), via the Dejavu CLI
hitting the same SQLite file.

### Isolation

`home-dejavu-listing.txt` shows `~/.dejavu/dejavu.db` mtime of **May 14**, well
before this experiment ran (May 17). The experiment wrote only to its
`evidence/run-…/dejavu.db`. No user-global Dejavu state was touched.

No Terrarium global config (`~/.terrarium/…`) was edited. No opencode
config was edited. The agent passed to Terrarium was a script *inside the
experiment directory*; pointing at it required only the `--agent` flag.

## Interpretation

What this proves (transport):
1. **Terrarium children inherit the parent process env.** This is the
   standard POSIX subprocess behavior, and Terrarium does not strip
   `DEJAVU_*` (or anything else) on its way down.
2. **A child agent command can be any executable**, not just an LLM driver.
   When the agent is the Dejavu CLI (directly or via a shell wrapper), the
   child *is* a Dejavu user against whatever `DEJAVU_DB` points to.
3. **Therefore "passing Dejavu to a Terrarium child" is just**
   `export DEJAVU_DB=…; export DEJAVU_AUTHOR=…; terrarium --agent <cmd> …`.
   No code changes needed in either Dejavu or Terrarium.

What this does **not** prove:
- That an LLM-driven child (e.g., `opencode run` configured with the Dejavu
  MCP) will choose to call `dejavu_recall`/`dejavu_remember` on its own. The
  MCP wiring there lives in the child agent's own config, not in Terrarium.
  Terrarium's contribution is strictly env + arg transport. Verifying LLM
  behavior is a separate, model-dependent experiment (and would belong in
  `eval/` or `bench/`, not here).
- That `~/.dejavu` is *guaranteed* untouched by all concurrent processes —
  only that this experiment's writes were directed into the isolated DB.

## Repro

```bash
cd <dejavu-repository>
./experiments/04-terrarium-dejavu-inheritance/run.sh
# expect: "RESULT=PROVEN" and exit 0
```

Each run produces a fresh `evidence/run-<timestamp>/` so prior runs are
preserved.

## Follow-ups (not done here)

- A sibling experiment in `experiments/0X-…/` that uses `--agent "opencode
  run"` with a dejavu-MCP-configured opencode and measures: across N runs,
  what fraction of LLM children actually call `dejavu_recall` and
  `dejavu_remember`? That's the *behavioral* counterpart to this
  *transport* experiment.
- A variant where the parent passes a *task* that explicitly tells the
  child "first call `dejavu_recall` for prior context" — to distinguish
  "child can't" from "child won't".
- Wire `DEJAVU_SESSION` deliberately so parent+child share a session id and
  their slips group together in `dejavu ls --session`.
