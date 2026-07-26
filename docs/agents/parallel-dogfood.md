# Parallel dogfood loop

Use this when multiple headless agents are working on dejavu at once. The point is
not just throughput; it is a product experiment: does dejavu make parallel agents
more coherent than stateless agents?

## Orchestrator contract

The orchestrator owns integration and the scientific bar.

1. Split work into one hypothesis per worker.
2. Create an isolated git worktree per worker.
3. Require each worker to recall context at start and write a handoff at end.
4. Merge only changes with a passing experiment or a clear negative result.
5. Update the claim -> evidence map when a claim becomes stronger or weaker.

## Worker contract

Each worker receives one bounded mission and must produce:

- hypothesis
- code/doc change, if needed
- experiment or fixture
- test output
- handoff with changed/evidence/risks/next

Required checks before handoff:

```bash
bun test
bun run typecheck
bun run bench:behavior
```

## Suggested first wave

```bash
git worktree add ../dejavu-behavior-report -b exp/behavior-report
git worktree add ../dejavu-recall-trigger -b exp/recall-trigger
git worktree add ../dejavu-stale-memory -b exp/stale-memory
git worktree add ../dejavu-handoff-ab -b exp/handoff-ab
git worktree add ../dejavu-evidence-map -b exp/evidence-map
```

Example worker launch shape (adapt flags to the local pi version):

```bash
pi --headless --cwd ../dejavu-recall-trigger < prompts/recall-trigger.md
```

## dejavu usage

At start, worker:

```text
dejavu_recall("dejavu current roadmap worker contract open experiments")
```

For durable decisions:

```text
dejavu_remember(text="Decision: ...", keep=true, tags=["decision", "dejavu"])
```

At end:

```text
dejavu_handoff(summary="...", next=["..."])
```

## Dogfood experiment

Baseline: run parallel workers without dejavu recall/handoff.

Variant: run parallel workers with dejavu recall/handoff.

Measure:

- duplicate work
- conflicting decisions
- missed dependencies
- integration time
- test pass rate
- quality of final handoffs

If the variant wins, the project can honestly claim dejavu improved the parallel
agent loop that built dejavu.
