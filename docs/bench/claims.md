# Claim → evidence map

Strong claims require runnable evidence. Unit tests establish implementation behavior; they do not by themselves prove that agents perform better.

| Claim | Status | Evidence | Next proof required |
|---|---|---|---|
| Local Dejavu isolates ordinary memory and handoffs by repository. | Supported | `test/context.test.ts`, scoped storage/API tests in `test/storage.test.ts` and `test/dejavu.test.ts` | Sample wrong-project rate from assessed real recalls. |
| Recall is local and token-bounded. | Supported | SQLite/FTS implementation; budget fixture in `test/dejavu.test.ts` | Measure p95 packet tokens and latency on real databases. |
| Supersession prevents an old lexical match from overriding current memory. | Supported | supersession recall fixture in `test/dejavu.test.ts`; link formatting tests | Multi-session agent behavior fixture. |
| Completed handoffs stop directing future agents. | Supported | handoff lifecycle API and MCP tests | Real continuation sessions with resolved work. |
| Trust does not conflate BM25 relevance with truth. | Supported | `trustForSlip` lifecycle fixtures; formatted-output tests | Calibrate useful/wrong thresholds from real outcomes. |
| Dejavu records retrieval evidence without copying memory text into traces. | Supported | recall trace schema and content-free test in `test/dejavu.test.ts` | Accumulate and publish an assessed sample. |
| Anchored memory reports whether its code changed, was deleted, or is unchanged. | Supported | `test/anchors-drift.test.ts`, `test/anchors-recall.test.ts`; blob format cross-checked against the git binary in `test/anchors.test.ts` | Sample how often drift labels coincide with a `wrong` assessment on real recalls. |
| Drift checking does not measurably slow recall. | Supported | `bench/anchors.ts` / `docs/bench/anchors-latest.txt`: 8 hits over 200-line files, +0.07 to +0.14 ms p95 over the unanchored baseline across runs | Re-measure on a real database with hundreds of anchored slips and larger files. |
| Anchor drift does not change relevance, trust, or ranking. | Supported | ordering/score/trust invariance fixture in `test/anchors-recall.test.ts` | Holds by construction; revisit only if an eval earns drift as a ranking input. |
| Anchored memory reduces acting on stale notes. | Hypothesis | none yet | Assessed real recalls where a drifted hit was marked `wrong`, versus the same memory unanchored. |
| Reverse lookup by file surfaces memory a query would have missed. | Hypothesis | none yet | Compare `touching(diff paths)` against `recall` on the same task fixtures. |
| Dejavu retrieves the eight lexical smoke memories. | Supported, narrow | `bench/recall.ts`, `docs/bench/latest.txt` | Expand to 100+ real and paraphrased cases. |
| Specific tool wording should improve appropriate recall. | Proxy-supported | `bench/behavior/run.ts`, `docs/bench/behavior-latest.md` | Baseline-vs-Dejavu agent transcripts. |
| Structured handoffs may improve continuation. | Proxy-supported hypothesis | behavioral bench plus loop 4 c3 | Controlled multi-model A/B. |
| Dejavu reduces repeated work or total tokens. | Hypothesis | loop 4 estimates and instrumentation | Fixed-task baseline-vs-Dejavu runs with token accounting. |
| Shared writes are committed before receipts and mirrors expose stale gaps. | Supported in local/deployed experiments | shared tests; experiments 05–10; implementation contract | Personal production dogfood after security review. |
| Shared Dejavu is safe to deploy publicly or for employees. | **Not supported / blocked** | `docs/shared-security-review.md` | Identity, revocation, retention, content policy, audit, and encryption decisions. |
| Semantic/vector recall is necessary. | Unproven | no current qualifying eval | Real lexical misses and paraphrase corpus first. |
