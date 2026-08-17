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
| A harness hook can orient an agent without the agent calling recall. | Supported | `test/harness.test.ts` orientation fixtures; end-to-end CLI phases | Confirm the injected packet is actually attended to in real transcripts. |
| A harness hook preserves session work the agent never got around to keeping. | Supported | `test/harness.test.ts` checkpoint/end fixtures, including the writer-never-called-handoff chain | Real sessions, not fixtures. |
| Session identity is shared across hook, MCP, and CLI processes. | Supported | `test/session-identity.test.ts`, including the pin on the bug it fixes | — |
| Session hooks stay inside the harness's exit budget. | Supported | `bench/session.ts` / `docs/bench/session-latency.txt`: ~85 ms cold worst case against a 1500 ms shared budget | Re-measure on a large real database. |
| Harness lifecycle hooks close Loop 4's writer-side gap (c2). | **Hypothesis** | none — fixtures prove the mechanism, not the behaviour change | Re-run the loop 4 chain battery with hooks installed; compare c2 tokens and whether the reader answers from memory. |
| Automatic orientation does not degrade sessions that need no memory. | **Hypothesis** | none | Loop 4's c4 world-knowledge control, with hooks installed; watch for false-recall regressions. |
| What a query could see at a past instant is exactly reconstructible for slips, handoffs, and supersession. | Supported | `test/storage-as-of.test.ts`, `test/recall-as-of.test.ts` — including the inclusive boundaries at the instant itself | — |
| Recorded receipts can be re-run against current code without agent cooperation. | Supported | `test/replay.test.ts`; demonstrated end to end by flipping FTS from OR to AND, which replay localized to one receipt and dropped exact agreement to 83.3% | Run it on a real dogfood corpus rather than a seeded one. |
| Replay measures retrieval **stability**, not retrieval **truth**. | Supported by construction | `src/replay.ts` compares returned ids only; assessments are reported separately and never folded into the agreement figure | — |
| Orientation packets replay exactly. | **Not supported — and not claimed** | evidence counters have no history and the working tree is not recoverable, so orientation is reported in a separate `approximate` tier that compares sets and not order | Record retrieval parameters in receipts to remove one of the three sources of drift. |
| Replay agreement is a quality score. | **Not supported — explicitly disclaimed** | an intentional retrieval improvement lands in the same `changed` column as a regression; the CLI says so beside the number | — |
| The session-start packet is composed from the working tree rather than from recency. | Supported | `test/orientation.test.ts`, `test/orientation-format.test.ts`, and the end-to-end checkout fixtures in `test/harness.test.ts` | — |
| Reading the working tree stays inside the harness's exit budget. | Supported | `bench/session.ts` / `docs/bench/session-latency.txt`: its own `--no-worktree` control arm puts the read at +3 ms p50 against a 600 ms share. Re-measured per machine, since cross-machine comparison proves nothing | Re-measure on a large repository with a very large diff. |
| Orientation carries memory an agent wrote without setting `kind`. | Supported | fallback-section fixtures in `test/orientation.test.ts`; the regression was caught by the pre-existing harness fixtures | — |
| Working-tree orientation makes agents continue better than a recency list did. | **Hypothesis** | none — the fixtures prove composition, not behaviour change | Baseline-vs-orientation continuation runs on fixed tasks; assessed real recalls comparing `orientation:` receipts against the previous empty-query receipts. |
| Leading with hazards is the right section order. | **Hypothesis** | none — the order is an argument, not a result | Assessed real recalls where a hazard was marked `useful` versus where must-know was. |
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
