# Experiment 16 — RESULT

- outcome: **PASS**
- run: `exp16mq9c4nck`
- timestamp: 2026-06-11T10:09:13.346Z
- shared authority: `http://127.0.0.1:8796` (local Worker + SQLite Durable Object)
- Supermemory: `http://127.0.0.1:6767` (real local server)
- synthetic marker: `exp16mq9c4nck`

## Verdict

Operational continuity proved; full Supermemory extraction disproved in this run (terminal failed), while any exact document search visibility is reported separately.

The supported model is **two-speed, authority-first continuity**: repository-scoped Dejavu owns the local active handoff; revisioned shared memory transports exact operational state; Supermemory is a derived semantic index whose pending/failed state must never block or masquerade as operational freshness.

## Evidence

| phase | observation | timing |
|---|---|---:|
| independent clients | local PID 5456; cloud PID 5461; separate DBs | process boundary |
| local write + exact authority receipts | local handoff active; writer mirror at rev 2 | 19.11 ms |
| connected cloud continuity | separate process observed exact slip + handoff | 2.16 ms |
| Supermemory submit | returned `queued`; immediate status `queued`, exact doc visible=false | 51.47 ms |
| disconnected write | authority committed revision 3 | 5.89 ms |
| honest stale probe | mirror 2, head 3, behind 1, fresh=false | 3.34 ms |
| reconnect catch-up | fresh=true, behind=0 | 8.12 ms |
| cloud resolution | resolution rev 4; restarted local handoff inactive=true | 3.28 ms |
| initial semantic pipeline | status=failed; exact doc visible at not observed; timedOut=false | 31882.40 ms to terminal |
| resolution semantic pipeline | status=failed; exact doc visible at not observed; timedOut=false | 27140.20 ms to terminal |

## Anti-theater checks

- local and cloud clients are separate OS processes with separate Dejavu and mirror SQLite files;
- same-origin synthetic checkouts derived the same repository scope; an unrelated origin derived a different scope;
- the cloud client's isolated local Dejavu DB did **not** magically contain the local client's handoff; transport came from authority revisions;
- while disconnected, cloud local recall missed the new text and the status probe reported the exact revision gap;
- reconnect had to advance the contiguous watermark before freshness was asserted;
- semantic visibility only counts a Supermemory search result with the submitted document ID, preventing unrelated approximate hits from passing;
- `queued/indexing/processing`, timeout, and `failed` are reported as pending/not-fresh or failed, never as semantic completion;
- all content was synthetic and submitted Supermemory documents were deleted after observation.

## Event log

```text
2026-06-11T10:08:38.708Z spawn — starting independent local and cloud-shaped processes
2026-06-11T10:08:39.282Z scope — PIDs local=5456 cloud=5461; same scope repo:continuity-fixture:3a3958f3ed68; outsider repo:unrelated-fixture:644bf58c6918
2026-06-11T10:08:39.301Z immediate local continuity — local 1.74ms; shared revisions 1-2 in 14.44ms
2026-06-11T10:08:39.307Z immediate cloud continuity — separate PID mirror at rev 2; observed in 2.16ms
2026-06-11T10:08:41.214Z semantic pending — document xz9XNAEYSFPDzZ7m8QGsz4 status=queued; exact document searchable=false
2026-06-11T10:08:41.227Z disconnect/staleness — mirror=2 head=3 behind=1; local hit=false
2026-06-11T10:08:41.236Z reconnect/catch-up — revision 2 -> 3 in 8.12ms
2026-06-11T10:08:41.393Z resolution — authority resolution revision 4; local handoff inactive; peer saw in 0.50ms
2026-06-11T10:09:13.321Z semantic observation — initial=failed visible=false; resolution=failed visible=false
```
