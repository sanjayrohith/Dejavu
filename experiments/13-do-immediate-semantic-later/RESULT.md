# Experiment 13 — RESULT

Generated at 2026-06-11T10:13:09.178Z from synthetic data against:

- Durable Object: `http://127.0.0.1:8913` (local `wrangler dev`, SQLite storage)
- Supermemory: `http://127.0.0.1:6767` (real local server)
- continuity id: `exp13-ee611a91-63eb-4958-9e0f-0f8de24300d1`
- synthetic marker: `semcatch-caf6cb86b294405c9f60bb1d3362b22b`

## Observations

| event | elapsed / latency | observed state |
| --- | ---: | --- |
| DO write returned committed receipt | 13.31 ms | exact=available; semantic=`pending`, stale=true, fresh=false |
| immediate DO read-after-write | 7.86 ms (23.57 ms after start) | exact byte-for-byte match=true; semantic=`pending` |
| Supermemory accepted document | 30.89 ms (54.61 ms after start) | queued document `gBPiRjLKGxoaoVLsxDVzTA`; semantic=`submitted`, stale=true, fresh=false |
| first search result containing that document id | 934.18 ms after start | **observed**; semantic=`visible`, stale=false, fresh=true |

Search attempts: 2; poll interval: 500 ms; timeout: 60000 ms.

## Verdict

**Supported in this local run.** The exact continuity path completed and passed read-after-write before semantic submission began. Semantic freshness was not asserted when Supermemory returned `queued`; it became fresh only after search returned document id `gBPiRjLKGxoaoVLsxDVzTA`, 934.18 ms after the write began.

This proves a two-speed *interface observation*, not production Cloudflare durability or a bound on semantic lag. Local workerd, localhost networking, one record, model warmness, and machine load all affect these numbers.
