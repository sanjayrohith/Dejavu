# Experiment 09 — remote run notes

Final clean remote run was executed on the **personal** Cloudflare account:

- account id override: `bfcb6ac5b3ceaf42a09607f6f7925823`
- URL: `https://dejavu-exp09-deployed-live-mirror-feed.coy.workers.dev`
- final deployed version: `b0f1fe5c-21a3-4bae-8f3f-67b30503ffd7`
- canonical result: `RESULT-remote.md` verdict `PASS`

The disposable Worker was deleted after measurement:

```text
Successfully deleted dejavu-exp09-deployed-live-mirror-feed
Worker does not exist [10007]
```

## Final measured functionality

- writer receipt → own local recall: pass;
- authority write start → peer mirror locally searchable over live feed:
  **484.84 ms** in the final run;
- warm peer local FTS recall: **~0.01 ms p50**;
- disconnect reports `fresh=false behind=5`, reconnect/catch-up restores local
  gap hits and freshness;
- 48 concurrent writes had contiguous revisions and both mirrors converged fresh.

## Bugs surfaced during deployed testing

1. **Fanout must not block write receipts.** The first deployed SSE version
   awaited `writer.write()` during broadcast; stale/backpressured subscribers
   wedged `POST /remember` and caused Cloudflare 502/timeouts. The experiment
   worker was changed to non-blocking, best-effort fanout relative to commit
   acknowledgements.
2. **Dirty remote state invalidates disconnect assertions.** Earlier failed
   attempts left matching rows in the same DO. The final harness includes a
   unique `runId` token in every query/write, making assertions isolated without
   needing a destructive reset endpoint.
3. The final result file shows `max=NaNms` for warm local recall due to a result
   formatting typo (`Math.max(array)` instead of spread). The code is fixed after
   the run; p50/p95 and all behavioral assertions remain valid.

The disposable Worker endpoint was intentionally unauthenticated experiment
code and was removed immediately. Product Dejavu must be authenticated.
