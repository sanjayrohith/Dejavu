# Experiment 07 — cheap local feel without a mirror DB

## Product question

Experiment 05 proved the deployed DO memory authority is correct but not
"local-feeling" over the network. Experiment 06 proved a local hot SQLite mirror
can feel instant, but it re-introduces sync state, stale windows, replay, and a
streaming/polling product decision.

This experiment asks:

> Can we win back enough felt latency with cheap client behavior — prefetch,
> per-session memoization, and a small recent-write cache — without building a
> replicated local memory database?

## Model

A deterministic local HTTP authority simulates remote authority latency:

- `remember`: 235 ms default artificial delay (exp05 remote p50)
- `recall`: 188 ms default artificial delay (exp05 remote p50)
- `recents`: 188 ms default artificial delay

The server is truth. The client strategies are intentionally small:

1. **baseline** — every recall hits the authority.
2. **query memo TTL** — exact repeated query results cache briefly.
3. **startup recents prefetch** — fetch latest slips once and answer obvious recent queries locally.
4. **recent-write cache** — after a committed write receipt, locally answer a matching immediate read-after-write query.

No local DB. No revision replay. No catch-up feed. This is deliberately trying to
avoid becoming experiment 06.

## What counts as a win

- Large latency improvement for repeated/query-recents paths.
- Just-written memory can be read immediately after the authority receipt without
  a second recall RTT.
- Cache miss and TTL expiry remain honest: they fall back to the authority, not
  pretend completeness.
- Stale cached query behavior is visible and measured, not hand-waved.

## Run

```bash
cd experiments/07-cheap-local-feel
./run.sh
```

Override latency if needed:

```bash
REMEMBER_MS=235 RECALL_MS=188 ./run.sh
```

The runner writes `RESULT.md` from a real run and leaves throwaway logs under
`.tmp/`.
