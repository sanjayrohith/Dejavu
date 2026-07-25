# Experiment 06 — RESULT (DO-authority + local hot mirror)

- run timestamp: 2026-05-18T19:56:35.869Z
- label: `final-run`
- authority endpoint: `http://127.0.0.1:8876`
- authority head_revision at start: 0
- authority head_revision at end:   136
- authority FTS mode: **fts5**
- alice mirror FTS: **fts5**
- bob   mirror FTS: **fts5**

## T1 — same-client receipt -> warm local recall

- receipt: id=1 ulid=`mem_502a246fda29d151f52ca8f04cc048c6` revision=1
- timings_ms: authority_remember=2.84 local_apply=0.41 total=3.25
- recallLocal hits: 1  mirror_revision after: 1
- **PASS: true**

## T2 — cross-client: authority sees instantly, stale mirror is honest about it

- bob.recallAuth saw alice's write: **true**
- bob.recallLocal hits (no catchUp): 0
- bob.freshness: mirror_revision=0 head_revision=2 behind=2 fresh=false head_probe_ms=0.55
- stale_detected_honestly: **true**
- **PASS: true**

## T3 — catch-up: bob becomes fresh and local recall works

- bob.catchUp: applied=2 pages=1 timing_ms=1.07 mirror_revision=2 head_revision=2
- bob.recallLocal hits after catchUp: 1
- bob.freshness: behind=0 fresh=true
- **PASS: true**

## T4 — stale window is *measurably* stale, then closes

- 20 writes by alice while bob does nothing
- bob.freshness (before catchUp): mirror_revision=2 head_revision=22 behind=20 fresh=false
- bob.recallLocal hits (before catchUp): 0  (expected 0 — mirror has not caught up)
- stale_claimed_honest: **true**  (mirror did *not* silently fabricate freshness)
- bob.catchUp: applied=20 pages=1 timing_ms=4.53
- bob.recallLocal hits (after catchUp): 20
- bob.freshness (after catchUp): behind=0 fresh=true
- **PASS: true**

## T5 — concurrent writes from two clients

- N writes per client (parallel): 32  (total 64)
- errors: 0
- unique revisions: true  unique ulids: true  contiguous: true
- revision range: [23, 86]
- alice.recallLocal hits (after catchUp): 64  (expected 64)
- bob.recallLocal   hits (after catchUp): 64  (expected 64)
- **PASS: true**

## T6 — latency (M=50, alice only, sequential)

| operation | mean ms | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| remember.authority_remember | 0.39 | 0.36 | 0.60 | 0.69 | 0.69 |
| remember.local_apply | 0.24 | 0.24 | 0.37 | 0.51 | 0.51 |
| remember.total | 0.63 | 0.59 | 0.92 | 1.02 | 1.02 |
| recallLocal (warm) | 0.04 | 0.04 | 0.05 | 0.09 | 0.09 |
| recallAuth (round trip) | 0.33 | 0.30 | 0.64 | 0.73 | 0.73 |

## Interpretation

The hybrid contract holds in this prototype: a writer gets a receipt
from the authority, immediately applies the acked event to its own
SQLite mirror, and a subsequent local recall on the same client returns
the row without another network round-trip (T1). Cross-client reads via
`/recall` see writes immediately because the authority is the only
truth (T2). Local recall on a peer that hasn't caught up does *not*
silently claim freshness — the freshness probe reports `behind > 0`
and `fresh = false` (T2, T4). After `catchUp()`, the mirror
converges to authority head and local recall sees the writes (T3,
T4, T5).

### Latency observation

`recallLocal` (warm SQLite FTS5 in-process) is consistently faster
than `recallAuth` (HTTP round trip to the local authority). On a
real deployment where the authority is a remote DO across the public
internet that gap widens dramatically; on loopback like this run it is
still measurable but smaller. The `remember.local_apply` slice is
the *additional* cost the hybrid pays vs experiment 05: every write
now does an authority round trip *and* a local INSERT + FTS insert.

### Does this re-introduce sync / product complexity?

Yes. Honestly:

- Every client now has a state machine: `mirror_revision`,
  catch-up, idempotent apply, stale-window awareness. Experiment 05
  had none of that.
- Two new failure modes exist: (a) the mirror is stale and the caller
  doesn't ask freshness (silent staleness — we mitigate by *never*
  having recallLocal lie, but the caller still has to choose), and
  (b) catch-up failures (network blip during `/events?since=`) leave
  the mirror behind. Idempotent apply means retry is safe, but the
  caller has to retry.
- The receipt-then-warm-local-recall property is real and pleasant
  for the writer (T1), but it does *not* compose to peers: peers must
  either pay the authoritative round-trip cost (T2) or run a catch-up
  loop in the background (which adds a polling/streaming product
  decision that experiment 05 didn't need).
- The benefit is uneven: writers and warm readers on the same client
  get fast local recall; cold peers and freshness-sensitive callers
  see no win and a real complexity tax.

So the answer to "is this strictly better than experiment 05?" is no.
It is better for *one specific shape*: a client that writes and then
immediately reads back, or a client that does many local reads against
a working set it has already caught up on, while being willing to
tolerate explicit stale windows for any data it didn't write itself.
For everything else, experiment 05's "always ask the DO" remains
simpler and the latency cost is the price of being honest.

## Honest limitations of this prototype

- Authority is a Node process on loopback, not a real DO. Numbers reflect that — they are a floor for the hybrid's overhead, not an upper bound for the remote case.
- No background catch-up loop. The caller must call `catchUp()`. A production version would need a streaming feed (SSE / WebSocket / DO alarm push) for low-latency peer convergence; the polling pattern here is fine for the experiment but would not feel "local" for peers without it.
- Single authority, single mirror file per client, no auth, no quotas, no eviction, no embeddings. Same scope as experiments 01/03/05.
- Ulid is random hex, not time-sortable. Matches the rest of the series.
- Revisions are assigned inside a `BEGIN IMMEDIATE` transaction; SQLite serializes them. Real DO would get the same property "for free" via the input gate.
