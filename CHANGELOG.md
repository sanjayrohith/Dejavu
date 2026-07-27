# Changelog

All notable changes to Dejavu are documented here.

## 0.1.0 — release candidate

### Added

- Stable automatic Git-repository scope for slips and handoffs.
- Deliberate cross-project `global` slip scope.
- Safe `legacy:global` migration mode for existing databases.
- Typed memory kinds: decision, preference, procedure, pitfall, fact, wip, note.
- Deterministic kind inference when agents omit a kind.
- Token-budgeted recall and kind filters.
- Recall receipts and useful/wrong/missed/no-memory-needed assessments.
- Scoped recall-quality report through `Dejavu.recallReport()` and `dejavu eval`.
- Active/completed/abandoned handoff lifecycle.
- Explicit handoff resolution through library, MCP, and CLI.
- Public `link()` API and MCP/CLI link tools.
- Supersession-aware recall that follows old matches to current memory.
- Scoped, confirmation-gated session forgetting in the CLI.
- Compact provenance and handoff age in formatted recall.
- Optional shared-memory preview: Cloudflare Worker + Durable Object SQL authority, numbered changes, SSE, local searchable mirrors, catch-up, freshness, and hard deletion.

### Changed

- Trust now represents memory evidence, not BM25 magnitude.
- High trust requires a kept memory to be materially useful at least twice.
- Mutable memory is always presented with a verify-against-live-state warning.
- The experimental next-agent reasons/penalties ranker is disabled by default.
- Local MCP version is `0.1.0`.
- README now presents the production local surface first and labels shared mode preview-only.

### Safety

- Unrelated repository handoffs no longer appear as the latest global handoff.
- Resolved handoffs no longer direct future agents.
- Legacy rows are excluded unless explicitly requested.
- Bulk forgetting cannot cross the current repository scope.
- Shared deployment remains blocked pending the documented identity, revocation, retention, content-policy, and encryption review.

### Evidence

- Full unit/integration suite.
- Strict TypeScript check.
- Eight-case lexical recall smoke benchmark.
- Behavioral proxy experiments.
- Content-free recall instrumentation for the next real-session evaluation batch.

## 0.0.3

- Added recall feedback signals, recents, prior-handoff nudges, and local mailbox dogfood.

## 0.0.2

- Rebuilt Dejavu as a local-first SQLite + FTS5 agent memory with slips, handoffs, and MCP.
