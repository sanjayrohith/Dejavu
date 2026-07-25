# Experiment 07 — RESULT

- base: `http://127.0.0.1:8897`
- authority simulated delays: remember=235ms recall=188ms
- final authority count: 5


## T1 — baseline remote recall cost

- source: remote
- latency: 191.62 ms
- hits: 1
- PASS: true

## T2 — exact query memoization helps repeats, TTL expiry falls back honestly

- first recall: remote-fill, 190.42 ms
- repeated recall: memo, effectively ~0 client RTT
- after TTL: remote-fill, 191.01 ms
- PASS: true

## T3 — startup recents prefetch answers bounded recent/handoff-like query locally

- startup prefetch latency: 190.55 ms (can be hidden at session boot)
- beta local hits: 1, freshness=bounded-recents
- out-of-cache query hits: 0; client must authority-fallback for completeness
- PASS: true

## T4 — just-written read-after-write cache avoids second recall RTT, without claiming peer freshness

- authority remember receipt latency: 239.38 ms
- local recent-write read: 1 hit(s), effectively ~0 client RTT
- authoritative recall would have cost: 191.44 ms
- cache scope: own-acked-writes-only
- PASS: true

## T5 — cache staleness is real: another writer invalidates truth but memo does not know

- initial empty memo fill: remote-fill, 190.96 ms
- peer write latency: 238.79 ms
- cached repeat before TTL: source=memo, hits=0 (stale)
- authority truth: hits=1, 189.82 ms
- PASS (staleness detected by experiment): true

## Conclusion

- checks: ✅ baseline finds alpha; ✅ memo first fill remote; ✅ memo repeat local; ✅ memo expired refetches remote; ✅ prefetch fetched recent slips; ✅ prefetch hits beta; ✅ prefetch miss stays miss; ✅ write committed; ✅ recent write cache hits; ✅ authority also hits delta; ✅ stale memo remains cached empty; ✅ authority truth sees peer write
- verdict: **PASS**

Cheap local-feel tricks do help, but only in bounded places:
- repeated identical recalls become instant until TTL; startup recents can hide one remote RTT; read-after-write for this client's own committed writes can avoid a second remote recall.
- none of these caches are complete shared memory. Peer writes make memoized negatives stale until TTL/invalidation. Prefetched recents only answer within their bounded window.
- recommendation: use these as UX optimizations around a DO authority, not as a consistency substrate. If product demands fresh arbitrary cross-agent recalls at local speed, these do not replace experiment 06's mirror/stream complexity.
