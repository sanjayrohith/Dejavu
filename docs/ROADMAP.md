# Dejavu roadmap

This is the complete product roadmap and release ledger. The priority order is determined by agent benefit: recall correctness, avoided work, token cost, and operational honesty.

## North star

> Useful work avoided minus memory overhead.

Dejavu succeeds when a fresh agent continues correctly with less re-reading, fewer repeated commands, fewer stale instructions, and fewer tokens than an equivalent session without memory.

## Non-negotiable release gates

Every release must satisfy all of these:

- [x] Repository scope prevents unrelated-project recall.
- [x] Existing databases migrate additively without rewriting memory text.
- [x] Relevance and evidence trust are separate concepts.
- [x] Recall output is bounded and carries provenance.
- [x] Completed handoffs stop directing agents.
- [x] Corrections preserve history through explicit links.
- [x] Retrieval behavior can be measured with recall receipts.
- [x] Local destructive operations are explicit and scoped.
- [x] Unit/integration tests, strict TypeScript, and smoke benchmarks pass.
- [x] Public documentation distinguishes proven behavior from hypotheses.
- [ ] Baseline-vs-Dejavu real-session evaluation has enough samples for product claims.
- [ ] Shared deployment security review is complete before any public deployment.

## v0.1.0 — production local memory

Status: **release candidate implemented**.

### Retrieval correctness

- [x] Stable scope derived from normalized Git origin.
- [x] Same remote maps multiple checkouts to the same scope.
- [x] Different repositories never share handoffs or ordinary slips.
- [x] Deliberate global slips can match repository queries.
- [x] Legacy rows require an explicit migration opt-in.
- [x] Porter-stemmed FTS5 local retrieval.
- [x] Optional memory-kind filters.
- [x] Approximate token budget.
- [x] Explicit supersession resolves old lexical matches to current memory.
- [x] Duplicate successor hits collapse.
- [x] Contradictions remain visible rather than being silently chosen.

### Memory quality

- [x] Typed kinds: decision, preference, procedure, pitfall, fact, wip, note.
- [x] Conservative deterministic kind inference.
- [x] Draft-to-kept lifecycle with draft GC.
- [x] Evidence trust based on state and observed usefulness, not BM25 magnitude.
- [x] Used/wrong feedback counters.
- [x] Immutable text and append-only corrections.
- [x] Explicit supersedes, contradicts, and related links.
- [x] Scoped bulk session expiry with confirmation in the CLI.

### Continuity

- [x] Structured handoff summary plus next steps.
- [x] One handoff per session.
- [x] Active/completed/abandoned lifecycle.
- [x] Only active scoped handoffs appear in recall.
- [x] Handoff age appears in formatted recall.
- [x] Chain-shaped kept memories can roll up into a handoff.
- [x] Prior-handoff nudge protects agents that write before recalling.

### Evaluation

- [x] Every recall returns a receipt id.
- [x] Receipts record query, scope, returned IDs, handoff, author, session, time.
- [x] Receipts do not duplicate memory text or transcripts.
- [x] Assessments: useful, wrong, missed, no-memory-needed.
- [x] Scoped quality report via library and `dejavu eval`.
- [x] Rejected next-agent ranker remains opt-in experimental behavior.
- [x] Eight-case lexical smoke benchmark.
- [x] Behavioral proxy experiments retained with claim/evidence labels.
- [ ] Collect 50 assessed real recalls across at least five repositories.
- [ ] Publish precision, miss, false-recall, and token-overhead results.
- [ ] Run baseline-vs-Dejavu continuation tasks with fixed prompts and fixtures.

### Product surface

- [x] Library API.
- [x] MCP memory tools.
- [x] MCP local mailbox tools.
- [x] Human inspection and mutation CLI.
- [x] Automatic migration.
- [x] Production README.
- [x] Changelog.
- [x] One-command release check.
- [ ] Tag and publish `v0.1.0` after review.

## Cloudflare-native provider seams — completed experiment wave

Seven isolated experiments now live in [`experiments/MEMORY-SEAMS-2026-06-11.md`](../experiments/MEMORY-SEAMS-2026-06-11.md).

- [x] Workspace SQLite VFS persistence survives local Wrangler restart.
- [x] Matching x64 Workspace/Supermemory image builds and verifies; local Container connect blocker is isolated.
- [x] Workflows provide idempotent submit/poll/retry/failure receipts.
- [x] DO SQL proves immediate operational authority while semantic indexing remains explicitly pending.
- [x] AI Gateway memory-extraction metadata/policy preflight is executable and payload-off.
- [x] Real cached Access identity validates against live JWKS without a static API key.
- [x] Independent local/cloud-shaped clients prove stale gaps, catch-up, and resolution without theater.
- [x] A real `agents@0.15.0` Agent hosts a provider-neutral memory lifecycle contract.
- [ ] Deployed protected Container proof after Workspace/Container local-connect feedback.
- [ ] Independent remote Access ceremony, continuity, expiry, and revocation proof.
- [ ] One bounded AI Gateway live call after a blocking spend limit is verified.
- [x] Diagnose local Supermemory + Ollama memory-agent failure: both tested models fail on the same unsupported Responses API `item_reference` continuation while chunk indexing succeeds.
- [ ] Prove a thin Responses compatibility adapter can normalize/replay referenced output items and make extracted memory/profile acceptance pass.

Architectural decision: immediate operational continuity belongs in Agent/DO SQL; richer providers are asynchronous and must expose `pending | fresh | stale | failed` independently from durability. Do not build a Dejavu-owned vector engine.

## v0.2 — stronger recall, earned by eval

No item in this batch ships merely because it sounds intelligent.

### Query quality

- [ ] Build a minimum 100-case corpus from anonymized real recall receipts.
- [ ] Add phrase, prefix, and acronym query expansion where fixtures prove value.
- [ ] Add query decomposition only if multi-concept cases improve without false positives.
- [ ] Evaluate recency as a tie-breaker, never as truth.
- [ ] Evaluate anchor drift as a ranking input, only if an eval shows drifted memory is genuinely less useful. It is a label until then.
- [ ] Evaluate kind-specific ranking.
- [x] Add current branch/task context only after repository scope remains stable.

### Context packet quality

- [x] Anchor memory to code and report drift against the working tree.
- [x] Reverse lookup: memory anchored to a given set of files.
- [x] Account for handoff tokens inside the same output budget.
- [x] Add `mustKnow`, `activeWork`, and `hazard` packet sections, composed from the working tree.
- [ ] Measure actual tokenizer variance against the four-character estimate.
- [ ] Add deterministic compact summaries only for memories with preserved source links.
- [ ] Prove default session-start packet stays below 800 tokens.

### Write quality

- [ ] Surface likely conflicts at write time without blocking the write.
- [ ] Suggest supersession only when topic overlap is strong and scoped.
- [ ] Detect near-duplicate memories and return the existing id.
- [ ] Consolidate repeated episodic findings into a proposed procedure.
- [ ] Propose supersession when a memory's anchored code has drifted, without writing it automatically.
- [ ] Require explicit acceptance before synthesized memory becomes kept.

### Agent integration

- [x] Harness-agnostic session lifecycle: orientation, checkpoint, and end.
- [x] Claude Code adapter: SessionStart, PreCompact, SessionEnd, installed by command.
- [x] Session identity shared across hook, MCP, and CLI processes.
- [x] Session-start orientation composed from the working tree rather than recency.
- [ ] Show that working-tree orientation beats the recency packet in real sessions.
- [ ] Pi extension over the same lifecycle commands.
- [ ] OpenCode adapter over the same lifecycle commands.
- [ ] Re-run the loop 4 chain battery with hooks installed to test the writer-side gap.
- [ ] Retry-safe write idempotency keys.
- [ ] Prove integrations reduce repeated work rather than merely increasing calls.

## v0.3 — personal shared memory on Cloudflare

Shared mode remains preview until every security gate below is closed.

### Existing protocol proof

- [x] Cloudflare Worker gateway.
- [x] One Durable Object SQL authority per memory space.
- [x] Monotonic committed revisions.
- [x] Write receipt includes the canonical event.
- [x] Writer applies its receipt locally for read-after-write.
- [x] SSE peer delivery never blocks a write.
- [x] Rebuildable local SQLite/FTS mirror.
- [x] Contiguous watermark and explicit gap state.
- [x] Offline catch-up.
- [x] Bounded stream lifetime and reconnect.
- [x] Hard-delete event and replay-payload redaction.
- [x] Two-client MCP dogfood.

### Blocking security work

- [ ] Choose personal-first deployed identity.
- [ ] Authenticate verified owner identity at the Worker boundary.
- [ ] Issue short-lived, revocable device sessions.
- [ ] Remove or hard-gate bearer-token mode outside local development.
- [ ] Threat-model Worker endpoints, live streams, local mirrors, and lost devices.
- [ ] Define allowed/prohibited memory content.
- [ ] Define local and Durable Object encryption requirements.
- [ ] Define audit events without logging memory content.
- [ ] Define Workers Logs, backup, and deletion retention.
- [ ] Prove cross-owner isolation.
- [ ] Prove session revocation at reconnect boundaries.
- [ ] Review account, route, Access policy, and deployment configuration.

### Shared product parity

- [ ] Carry repository scope through shared events and mirrors.
- [ ] Carry memory kinds through shared events and mirrors.
- [ ] Carry links and supersession through shared events and mirrors.
- [ ] Carry handoff lifecycle through shared events and mirrors.
- [ ] Carry recall receipts without uploading transcript content.
- [ ] Enforce per-space write and storage quotas.
- [ ] Add content-length and event-size limits.
- [ ] Expose actionable freshness in every shared recall result.

### Deployment gate

- [ ] Full local server test passes.
- [ ] Remote disposable deployment test passes and is deleted.
- [ ] Security review has no open blocker.
- [ ] One owner dogfoods for two weeks without data loss or stale-state confusion.
- [ ] Only then remove “preview / do not deploy” language.

## v0.4 — semantic fallback, not vector authority

This phase is conditional. Lexical scoped recall remains authoritative and local.

- [ ] Build a 50+ case paraphrase corpus from actual misses.
- [ ] Establish lexical baseline and false-positive rate.
- [ ] Evaluate Workers AI embeddings behind AI Gateway.
- [ ] Use Vectorize only as a rebuildable side index after immediate committed writes.
- [ ] Never make a just-written memory depend on eventual vector indexing.
- [ ] Deterministic scope/currentness filters run before semantic reranking.
- [ ] Local/offline behavior remains useful without the side index.
- [ ] Ship only if recall improves materially without wrong-project or stale-memory regression.

Required gate:

- paraphrase recall@1 >= 90%;
- wrong-project top-3 = 0;
- false recall <= 5%;
- write receipt remains immediately recallable;
- cost and latency are published.

## v0.5 — self-improving memory

- [ ] Join recall receipts to explicit task outcomes.
- [ ] Detect corrections, reverts, and repeated wrong signals.
- [ ] Propose procedure/pitfall memories from repeated episodes.
- [ ] Strengthen useful connections only with observable evidence.
- [ ] Decay or archive unresolved WIP without deleting history.
- [ ] Preserve source memory IDs behind every synthesis.
- [ ] Never silently rewrite memory text.
- [ ] Provide an inspectable proposal/accept/reject audit trail.

## Scale and operational backlog

These are deliberately below memory quality and security.

- [ ] Database health and FTS integrity command.
- [ ] Export/import with scope preservation.
- [ ] Redacted diagnostic bundle.
- [ ] Per-scope counts and size warnings.
- [ ] Recall latency percentiles from local traces.
- [ ] Shared Durable Object storage compaction policy.
- [ ] R2 cold history only if real space sizes require it.
- [ ] Regional placement only after measured remote latency warrants it.
- [ ] Node runtime adapter only after demand justifies a second SQLite implementation.

## Explicit non-goals

- Team ACL platform before personal shared memory is secure.
- Generic RAG ingestion.
- Secrets storage.
- Transcript archiving as “memory.”
- Autonomous destructive forgetting.
- Graph visualization before graph retrieval proves agent benefit.
- Vector-first writes or hidden eventual consistency.
- Claims based solely on unit tests or synthetic fixtures.

## Release scorecard

| Metric | Current gate | Target before stronger public claims |
|---|---:|---:|
| Unit/integration tests | all pass | all pass |
| TypeScript | clean | clean |
| Lexical smoke recall@1 | 100% on 8 cases | retain |
| Wrong-project top-3 | 0 in fixtures | 0 in real eval sample |
| Assessed real recalls | instrumentation ready | >= 50 |
| Useful precision | not enough samples | >= 85% |
| False recall on non-memory tasks | not enough samples | <= 5% |
| Default recall packet | bounded | <= 800 tokens p95 |
| Warm local recall | effectively instant | < 20 ms p95 |
| Anchor drift overhead | ~0.1 ms p95 (8 hits) | < 5 ms p95 |
| Session hook latency | ~40 ms cold worst case | < 600 ms (40% of exit budget) |
| Working-tree read at session start | +3 ms p50 vs its own control | < 100 ms p50 |
| Shared peer visibility | ~485 ms experiment | < 1 s p95 |
| Shared deployment | blocked | all security gates complete |

## How priorities change

A roadmap item moves upward only when one of these is true:

1. a real agent repeated expensive work;
2. a recall receipt shows a wrong or missed memory;
3. a security review identifies a deployment blocker;
4. measured latency or token cost crosses the release gate;
5. users repeatedly request the same integration.

Everything else stays a hypothesis.
