# Experiment 06 — DO-style shared authority + laptop-local hot mirror

## Where this sits in the series

- **01** — DO-shaped memory brain (in-process simulation)
- **02** — event log + local materializer (no shared authority)
- **03** — real DO memory brain under `wrangler dev`
- **04** — Terrarium / Dejavu inheritance
- **05** — deployed real DO memory brain, measured at the edge
- **06** — *this experiment*: keep DO-style shared authority as truth,
  add a laptop-local SQLite hot mirror per client and see whether the
  combination is worth the extra moving parts.

## Hypothesis / product question

Experiment 05 established that a single Cloudflare DO is a clean shared
authority for memory: receipt-then-recall is unconditional, cross-client
visibility is free, the contract is simple. The cost is that *every read
is a network round trip*. On a deployed worker that's tens of ms; for an
agent that wants to recall hundreds of items inside one tool-use cycle,
that adds up and stops feeling "local".

A natural follow-on is the hybrid:

> Authority owns the truth (like experiment 05's DO). Every client also
> keeps a *laptop-local* SQLite mirror that gets every committed event
> applied to it, so warm recalls on that client never pay the network.
> Writes still go to the authority and only return after they commit
> there. The local mirror is a read cache, not a source of truth.

The **product question** is *not* "is this faster?" — of course a local
SQLite read is faster than a remote DO read. The product question is:

> Does this design make recall feel local **without silently lying about
> freshness**, and does the protocol that keeps the mirror honest
> (`mirror_revision`, catch-up, freshness probe) reintroduce so much
> sync / product complexity that we'd be better off just paying the
> round-trip in experiment 05 and keeping the contract simple?

This experiment builds the smallest end-to-end prototype that can answer
that, runs it, and writes down what we actually saw.

## What the prototype is

Two pieces, both on this laptop, no remote deploy:

1. **Authority** (`src/authority.mjs`): a Node HTTP server backed by
   SQLite. Stands in for the experiment 05 DO. It owns:
   - the `memory` table (rows of `id, ulid, revision, client, text, ts`),
   - a strictly-increasing `revision` per committed write,
   - FTS5 index for content search,
   - endpoints: `POST /remember`, `GET /recall`, `GET /events?since=`,
     `GET /head`, `GET /health`, `POST /reset`.
   It is the *only* place where a write is considered committed.

2. **Client** (`src/client.mjs`): a per-client SQLite-backed mirror that
   speaks to the authority over plain HTTP. Each client has:
   - its own `memory.sqlite` (in `./.tmp/<name>-<ts>.sqlite`),
   - its own FTS5 index,
   - a `meta.mirror_revision` counter,
   - `remember(text)` — calls authority, applies the acked event locally
     *before* returning the receipt,
   - `recallLocal(q)` — local SQLite only, no network,
   - `recallAuth(q)` — direct authority read,
   - `catchUp()` — pulls `/events?since=mirror_revision` until caught up,
   - `freshness()` — probes `/head` and reports `behind` / `fresh`.

The mirror freshness protocol is the bit that earns its keep:

- `recallLocal()` never silently calls `/head` or pretends the mirror is
  current. It returns whatever the mirror has, plus `mirror_revision`.
  The caller decides whether to trust it.
- `freshness()` is the explicit "am I stale?" probe. It's the only thing
  in the API that *can* claim freshness, and it does so by direct
  comparison to authority head.
- This is deliberate. A read cache that lies about freshness is worse
  than no cache.

There is one subtlety worth flagging up front, because the first
implementation of this experiment got it wrong:

> `mirror_revision` is the **contiguous applied watermark** — the
> largest `R` such that the mirror has applied every event in `[1..R]`.

When the client writes its own `remember`, the authority may assign that
write revision 85 even though the mirror's watermark is at 22 (because
other clients committed 23..84 in between). The client inserts row 85
into its mirror immediately (so the writer's own `recallLocal` finds
it — that's the T1 win), but it does **not** advance the watermark past
22. A subsequent `catchUp` correctly pulls `/events?since=22` and gets
the missed peer events; the idempotent apply path dedupes the row we
already have at 85. Treating the watermark as a high-water-mark
(largest-ever-seen) instead breaks T5 by causing the client's own
catchUp to skip peer writes whose revisions fall in the gap. This is
exactly the kind of cache-consistency footgun the experiment was
designed to surface.

## What the harness measures

Six scenarios, each producing PASS/FAIL plus numbers in `RESULT.md`:

1. **T1** — same-client receipt → warm local recall. The "feels local"
   core claim. After `remember()` returns, the same client must be able
   to `recallLocal()` and find the row, with no extra round trip.
2. **T2** — cross-client authoritative recall + honest stale detection.
   Alice writes; Bob (no catch-up) must see it via `recallAuth`,
   *not* via `recallLocal`, and `freshness()` must report `behind > 0`.
3. **T3** — catch-up convergence. After `catchUp()`, Bob's mirror is
   fresh and his local recall sees Alice's write.
4. **T4** — wide stale window. Alice writes 20 events; Bob's freshness
   reports `behind == 20` and his local recall finds zero of them.
   After catch-up, his local recall finds all 20.
5. **T5** — concurrent writes from two clients. N writes per client in
   parallel. Authority must hand out unique strictly-increasing
   contiguous revisions; after both clients catch up, each mirror sees
   all 2N rows.
6. **T6** — latency distribution. `remember.authority_remember`,
   `remember.local_apply`, `remember.total`, `recallLocal` (warm),
   `recallAuth` (round trip). M=50 sequential each. The point isn't to
   declare a winner; the point is to put the *cost of being honest*
   (local apply on every write) on the same scale as the *win*
   (no-round-trip warm recall).

## Running it

Requires Node 22 (uses `node:sqlite`, which is the built-in SQLite
binding, and `fetch` from globalThis). No npm install, no wrangler, no
network, no deploy.

```bash
cd experiments/06-do-authority-local-hot-mirror
./run.sh
# writes RESULT.md in this directory
```

Optional env / flags:

```bash
AUTHORITY_PORT=9001 ./run.sh
AUTHORITY_DB=./.tmp/auth.sqlite ./run.sh          # persistent authority db
./run.sh --label loopback-mba --concurrent 64 --sequential 100
```

`run.sh` boots the authority in the background, waits for `/health`,
runs the harness, and tears the authority back down on exit. The
authority log lives at `.tmp/authority.log`. Per-client SQLite files
live at `.tmp/<name>-<ts>.sqlite` — they are not cleaned up between
runs on purpose (so you can inspect them); `./.tmp/` is the only thing
this experiment writes outside its own directory tree, and it stays
inside the experiment directory.

`RESULT.md` is overwritten on each run. Don't hand-edit it.

## What this experiment does **not** prove

- It does not measure remote authority latency. That is experiment 05's
  job. Putting the authority on loopback is deliberate: we want to
  isolate the hybrid's *added* complexity and *added* local cost, not
  re-litigate the network number.
- It does not test a background catch-up loop. The harness drives
  `catchUp()` explicitly. A production version of this design would
  need a streaming feed (SSE / WebSocket / DO alarm push) so peers
  converge without polling; that's a meaningful product decision and
  it's flagged in the RESULT interpretation rather than hidden.
- It does not test crash recovery on the client mirror. Idempotent
  apply makes that survivable in principle; an actual fault-injection
  pass would be a sibling experiment.
- No auth, no quotas, no eviction, no embeddings. Same scope as the
  rest of the series.

## What "good" looks like for this experiment

A successful run of `run.sh` writes a `RESULT.md` where:

- T1–T5 all report `PASS: true`,
- T6 shows `recallLocal` measurably faster than `recallAuth`,
- the Interpretation section honestly describes whether the hybrid is
  worth its complexity vs experiment 05, including the cases where it
  is *not*.

The Interpretation in `RESULT.md` is written by the harness from the
real numbers of that run. It is allowed to (and should) say "this
hybrid reintroduces sync complexity" if that is what the numbers
show.
