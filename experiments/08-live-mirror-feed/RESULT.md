# Experiment 08 — RESULT

- base: `http://127.0.0.1:8898`
- authority headRevision=55 subscribers=2

## T1 — writer receipt -> own local recall

- authority write: 4.01ms; local apply: 0.16ms; local recall: 0.44ms
- hits=1, revision=1
- PASS: true

## T2 — peer streamed visibility latency

- authority write+own ack: 2.52ms
- receipt start -> bob local visible: 5.28ms
- bob local hits=1
- PASS: true

## T3 — warm local recall latency

- bob warm local recall p50=0.01ms p95=0.01ms max=0.01ms
- PASS: true

## T4 — disconnect, stale gap, reconnect catch-up

- before disconnect stale? fresh=true
- while disconnected: connected=false behind=5 fresh=false; local hits=0
- catchUp applied=0 0.51ms; after behind=0; local gap hits=5
- PASS: true

## T5 — concurrent authority writes + ordered feed convergence

- writes=48; revision range=[8,55]; contiguous=true
- fresh: alice=true bob=true; default recall limit hits alice=8 bob=8
- PASS: true

## Conclusion

- checks: ✅ own local read hits; ✅ peer stream local hit; ✅ warm local recall stays local; ✅ disconnect freshness behind; ✅ disconnected local misses gaps; ✅ catchup sees gaps; ✅ concurrent revisions contiguous; ✅ mirrors converge fresh; ✅ both query sample hits
- verdict: **PASS**

A live ordered feed earns functionality that TTL caches cannot: peers become locally searchable after the authority commit without polling every recall, and disconnect/catch-up is explicit. It is still a real replication protocol, but unlike blind sync it has a crisp contract: authority revision order, contiguous mirror watermark, stream for happy path, /events catch-up for gaps.
This is now the strongest path toward shared memory that is both fresh and local-feeling; the next proof should put this feed in a deployed DO/SSE or WebSocket Worker and measure real peer-visible latency.
