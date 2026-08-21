# Changelog

All notable changes to Dejavu are documented here.

## Unreleased

### Added

- `dejavu doctor [--json]`: a redacted diagnostic bundle, built to be pasted into a bug report. A superset of `dejavu verify` — database health, file size, and runtime info, plus a per-scope breakdown across every repository this database has ever seen memory from (not just the caller's current one), current-scope anchor drift tally, and session-pointer state. Structurally redacted: only counts, enums, ids, and scope strings are ever read into the report, so there is no memory text to strip out.
- `Storage.scopeCounts()`: per-scope slip/handoff/anchored-slip counts across the whole database. `counts()` stays deliberately unscoped.
- `src/doctor.ts` and the `DoctorReport` type.

- Write-time duplicate detection: `remember()`, `dejavu remember`, and the MCP `remember` tool now check new text against already-kept memory and name it when the text looks like a near-duplicate or strongly overlaps an existing kept slip, suggesting a `supersedes` link instead of leaving two unlinked copies. Advisory only — the write happens either way, and nothing is linked automatically.
- `Dejavu.findDuplicate(text)` and the `DuplicateSuggestion` type.
- `src/duplicates.ts`: token-Jaccard overlap scoring against a small local stopword list, pure and DB-free.

- `dejavu eval --replay`: re-runs every recorded retrieval through the real pipeline, as of the instant it was served, and diffs the ids against what came back then. Needs nothing from any agent. `--json` for scripting, `--limit=N` to cap.
- Point-in-time reconstruction: an optional `asOf` on the scoped storage queries and on `recall`, `touching`, and `orientation`. Append-only slips, handoffs, and links make state at a past instant derivable without a journal.
- `src/replay.ts` and the `ReplayReport` type.

- Working-tree orientation: the session-start packet is composed from the checkout — memory anchored to the files already changed (most suspect first), then open work, then standing decisions and preferences — instead of the most recently kept slips.
- `Dejavu.orientation()` and the `OrientationPacket` type.
- `dejavu orient [--tokens=N] [--limit=N]`, showing the packet a new session would open with.
- `src/worktree.ts`: current branch read from `.git/HEAD` without a subprocess, and changed paths read from git under a timeout and a path cap.
- `Storage.listKeptByTrust()`: kept memory ordered by evidence rather than by `kept_at`.
- `dejavu session start --no-worktree`, for anyone who does not want a git subprocess on the session-start path.
- `bench/session.ts` now plants a real checkout with a dirty tree and anchored memory, carries a `--no-worktree` control arm, and fails if the fixture stops exercising the path it measures.

- Harness session lifecycle: `dejavu session start|checkpoint|end`, driven by hook payloads on stdin.
- `dejavu install claude-code` wires SessionStart, PreCompact, and SessionEnd into Claude Code settings, with `--global`, `--print`, and `--uninstall`.
- Session identity shared across processes: a harness claims one session id per repository scope so hooks, the MCP server, and the CLI agree on which session they are writing to.
- `DejavuOptions.sessionId` and the resolved `Dejavu.sessionId`.
- Claimed session shown in `dejavu stats` and `dejavu verify`.
- `bench/session.ts`, wired into `bun run check`, bounding cold-process hook latency against the harness exit budget.

- Code anchors: `remember(text, { anchors: ["src/auth.ts:42#fn"] })` pins a memory to the code it describes, recording the file's git blob id at write time.
- Anchor drift in recall: anchored hits report `verified`, `drifted`, `orphaned`, or `unknown` against the current working tree, so staleness is measured against the code rather than the clock.
- `Dejavu.touching(paths)` and the `touching` MCP tool: reverse lookup that answers "what is known about the code I am about to change" without needing a query.
- `dejavu touching <path...>`, `dejavu touching --diff`, and `dejavu anchors [--drifted]`.
- `dejavu remember --anchor=<path[:line][#symbol]>`, repeatable.
- Anchor status, location, and capture commit in `dejavu show`.
- `bench/anchors.ts`, wired into `bun run check`, bounding drift-check overhead.

### Changed

- An empty `recall` query now orients instead of returning a flat recency list, over MCP and through the session hook alike. Passing `kinds` with an empty query still returns the flat view.
- The `recall` tool description says what an empty query returns.
- The active handoff is charged against the same output budget as the memories beside it, rather than arriving free.
- The `recall` and `remember` MCP tool descriptions explain anchoring and the drift markers.

### Safety

- `dejavu doctor` is redacted by construction, not by filtering: it only ever reads counts, enums, ids, and scope strings out of storage, so no slip, handoff, or anchor text or tags can appear in its output — asserted directly by a test that plants distinctive text and checks it never survives serialization.
- Duplicate suggestions are advisory only: finding one never blocks or alters the write it was computed for, and nothing is linked automatically — the caller decides.
- A replayed retrieval records no receipt, so replay cannot grow the corpus it is measuring.
- A replayed retrieval does not check anchor drift, because the working tree at a past instant is not recoverable, and orientation does not read today's tree when composing as of a past instant.
- Replay is scoped exactly the way retrieval is: it never touches another repository's receipts.
- Replay reports stability and coverage, and says so where the number is printed. A difference is not automatically a regression.
- Reading the working tree never throws: no checkout, no commits, no git on `PATH`, and a git that hangs all degrade to "no worktree signal" rather than failing a session.
- Orientation still never calls a model and never reads a transcript. The diff is bounded by a 250 ms timeout and a 200-path cap.
- Untyped memory is carried in a trailing section rather than dropped, so a packet cannot silently lose everything an agent wrote without setting `kind`.
- A working-tree header is printed only for a tree that was actually read; a directory that is not a checkout is never reported as clean.
- Session hooks never read `transcript_path`; transcript archiving as memory stays a non-goal.
- Session hooks never call a model, so nothing is invented and nothing slow lands on the session exit path.
- Session hook failures degrade to a stderr note and a zero exit, so a memory problem cannot break a session.
- `dejavu install` refuses to overwrite unparseable settings and preserves hooks it did not write.
- Anchors that resolve outside the repository root are rejected at write time, so memory cannot point a future reader at arbitrary files.
- A failed anchor capture aborts the whole write rather than storing a memory that looks precise and is not.
- Drift is a label only. It does not affect BM25 relevance, evidence trust, or hit order — that would be a retrieval change, and retrieval changes require an eval.

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
