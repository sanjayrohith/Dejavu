# dejavu

[![CI](https://github.com/sanjayrohith/Dejavu/actions/workflows/ci.yml/badge.svg)](https://github.com/sanjayrohith/Dejavu/actions/workflows/ci.yml)

**Memory that lets coding agents continue instead of start over.**

Dejavu gives an agent a fast, repository-scoped memory between sessions. It stores decisions, preferences, procedures, pitfalls, facts, and work in progress in one inspectable SQLite file. Recall is local, bounded, cited, and honest about uncertainty.

```text
finish a session                         start the next one
       │                                        │
       ▼                                        ▼
 remember decisions ──► SQLite + FTS ──► recall relevant context
 leave a handoff         per-repo scope    continue the work
       ▲                                        │
       └──────── useful / wrong feedback ◄──────┘
```

No account. No daemon. No embeddings required. No transcript dump into the prompt.

> **Release status:** local Dejavu is the production surface in `v0.1.0`. Shared mode is a tested preview and intentionally remains local-only until its security review is complete.

## Why Dejavu

Coding agents repeatedly lose the expensive parts of prior work:

- the decision and why it was made;
- the command that finally worked;
- the failure mode that should not be repeated;
- the exact next step after context compaction;
- the user's project-specific preference.

A notes database is not enough. Memory must appear in the right repository, fit inside a context budget, distinguish relevance from trust, stop surfacing completed work, and expose evidence when it fails. Those constraints shape Dejavu.

## Install

Dejavu currently requires [Bun](https://bun.sh).

```bash
bun add github:sanjayrohith/Dejavu
bunx github:sanjayrohith/Dejavu init
```

Or clone it:

```bash
git clone https://github.com/sanjayrohith/Dejavu
cd dejavu
bun install
bun run src/cli.ts init
```

`dejavu init` creates `~/.dejavu/dejavu.db` and prints MCP configuration for Claude Code, OpenCode, and Pi.

## The 60-second agent setup

```jsonc
{
  "mcpServers": {
    "dejavu": {
      "command": "bunx",
      "args": ["github:sanjayrohith/Dejavu", "mcp"]
    }
  }
}
```

The tool descriptions are the operating contract. Dejavu does not require a `SKILL.md`, `AGENTS.md`, or a memory paragraph copied into every system prompt.

At the beginning of work, an agent calls:

```text
recall("")
```

At the end, it calls:

```text
handoff({ summary: "Implemented scoped auth", next: ["run the remote smoke test"] })
```

## What ships in v0.1.0

### Repository isolation by default

Dejavu derives a stable scope from the nearest Git repository and its normalized `origin`. Two checkouts of the same repository share a scope; unrelated repositories do not leak slips or handoffs into each other.

Use `DEJAVU_SCOPE=global` deliberately for a cross-project preference. Global slips may match any repository query, but global handoffs never direct repository work.

Databases created before scoping migrate safely to `legacy:global`. Those rows are excluded unless `DEJAVU_INCLUDE_LEGACY=1` is explicitly set during migration.

### Typed memory without filing work

Every slip has one kind:

| Kind | Use it for |
|---|---|
| `decision` | A choice that constrains future work |
| `preference` | A user or project preference |
| `procedure` | A reusable, verified sequence |
| `pitfall` | A failure, sharp edge, or thing not to repeat |
| `fact` | A verified project-specific finding |
| `wip` | Current work, blockers, and next steps |
| `note` | Safe fallback for everything else |

Agents may set the kind. If they do not, Dejavu uses a conservative deterministic heuristic—never a hidden model call.

### Bounded context packets

Recall accepts an approximate token budget and optional kind filters:

```ts
const result = d.recall("deploy staging", {
  limit: 8,
  maxTokens: 700,
  kinds: ["decision", "procedure", "pitfall"],
});
```

Dejavu retrieves locally, follows explicit supersession to current memory, deduplicates, and stops before the packet grows beyond the budget. Each hit carries its kind, provenance, evidence trust, and links.

### Trust is not relevance

BM25 answers **“does this text match?”** It does not answer **“is this true?”**

Dejavu keeps those concepts separate:

| Trust | Meaning |
|---|---|
| `low` | Draft or disputed; verify before relying on it |
| `medium` | Kept, but not yet confirmed through use |
| `high` | Kept and materially useful at least twice |

Mutable facts should still be checked against live code and systems. Dejavu never labels a lexical match “authoritative.”

### Current truth without rewriting history

Slips are immutable. A correction creates a new slip and links it:

```ts
const old = d.remember("Use Jest", { kind: "decision" });
const current = d.remember("Use Vitest", {
  kind: "decision",
  links: [{ toId: old.id, kind: "supersedes" }],
});
```

Recall follows `supersedes` to the current slip. `contradicts` keeps both claims visible. The history remains inspectable.

### Handoffs that stop when work stops

A handoff is an active continuation packet, not a permanent instruction. Keeping an obvious decision/preference/WIP memory can create an automatic safety-net handoff; the session's explicit final handoff replaces that automatic packet rather than failing:

```ts
const h = d.handoff({
  summary: "Auth refactor is implemented but not deployed.",
  next: ["run integration tests", "deploy canary"],
});

// Later:
d.resolveHandoff(h.id, "completed");
```

Only active, repository-scoped handoffs appear in normal recall. Resolved or abandoned work no longer directs the next agent. An unresolved handoff older than three days is labeled stale and advisory so an agent verifies it before acting.

### A measurable feedback loop

By default, each recall returns a content-free receipt id. Library callers handling sensitive queries may disable trace storage with `recordRecallTraces: false`; those calls return `traceId: null`. After acting, an agent can assess a stored retrieval:

```ts
const result = d.recall("test runner");
d.assessRecall(result.traceId, "useful");
```

Assessments are:

- `useful` — the packet helped;
- `wrong` — surfaced context was misleading;
- `missed` — needed memory existed or should have existed but was absent;
- `no_memory_needed` — not a memory-shaped task.

The trace stores query, scope, returned IDs, handoff ID, session, author, and timestamp. It does **not** duplicate memory text or transcripts. `dejavu eval` reports scoped evidence so retrieval changes can be evaluated against real use.

## Agent API

```ts
import { Dejavu } from "dejavu";

const d = new Dejavu();

const slip = d.remember("Decision: use Bun for repository scripts", {
  kind: "decision",
  tags: ["tooling"],
});

d.keep([slip.id]);

const recalled = d.recall("repository runtime", {
  maxTokens: 600,
  kinds: ["decision", "pitfall"],
});

if (recalled.hits[0]) d.used(recalled.hits[0].slip.id);
d.assessRecall(recalled.traceId, "useful", "avoided rechecking package scripts");

d.handoff({
  summary: "Converted scripts to Bun; tests pass.",
  next: ["update the release workflow"],
});
```

### Core lifecycle

```ts
d.remember(text, options?)
d.keep(ids)
d.recall(query, { limit?, maxTokens?, kinds? })
d.handoff({ summary, next? })
d.resolveHandoff(id, "completed" | "abandoned")
```

### Evidence and correction

```ts
d.used(slipId)
d.wrong(slipId)
d.forget(slipId)
d.link(fromId, toId, "supersedes" | "contradicts" | "related")
d.assessRecall(traceId, assessment, note?)
d.recallReport()
```

### Deliberate bulk cleanup

```ts
d.forgetSession(sessionId) // current repository scope only
```

## MCP tools

The local MCP server exposes two small groups.

**Memory**

| Tool | Purpose |
|---|---|
| `recall` | Scoped, budgeted retrieval plus the active handoff |
| `remember` | Draft or keep a typed memory; optionally supersede/contradict old slips |
| `handoff` | Leave one active continuation packet for the next session |
| `resolve_handoff` | Complete or abandon a handoff |
| `signal` | Mark one slip used, wrong, or forgotten |
| `link` | Relate two existing slips |
| `assess` | Evaluate a recall receipt |

**Local coordination**

| Tool | Purpose |
|---|---|
| `send` | Send an asynchronous local message |
| `inbox` | Read messages for an agent identity |
| `read` | Mark a message read |
| `reply` | Continue the message thread |

The mailbox is intentionally not memory truth. It is a small local coordination channel.

## CLI

```bash
dejavu init
dejavu verify
dejavu stats

dejavu recall                         # scoped recents + active handoff
dejavu recall "deployment decision" --tokens=700 --kind=decision,pitfall
dejavu remember "Decision: deploy with Wrangler" --kind=decision --keep
dejavu handoff "Canary is live; verify logs next"
dejavu resolve <handoff-id> completed

dejavu link <new-id> supersedes <old-id>
dejavu assess <trace-id> useful "saved a repository scan"
dejavu eval

dejavu ls
dejavu show <slip-id>
dejavu handoffs
dejavu forget-session <session-id> --yes
```

Destructive session cleanup requires `--yes` and is restricted to the current repository scope.

## Storage and migration

The default database is `~/.dejavu/dejavu.db`.

| Table | Purpose |
|---|---|
| `slips` | Immutable memory text, kind, scope, lifecycle, evidence counts |
| `slips_fts` | Porter-stemmed FTS5 index over text and tags |
| `links` | Supersession, contradiction, and related-memory edges |
| `handoffs` | Active/resolved continuation packets |
| `recall_traces` | Retrieval receipts and assessments, without duplicated memory text |
| `messages` | Local asynchronous agent mailbox |

Schema changes are additive and run automatically when Dejavu opens the database. Existing text is never rewritten during migration.

Useful environment variables:

```bash
DEJAVU_DB=~/.dejavu/dejavu.db       # database path
DEJAVU_AUTHOR=pi                # provenance identity
DEJAVU_SESSION=<conversation>   # stable session supplied by the harness
DEJAVU_SCOPE=global             # deliberate override; normally automatic
DEJAVU_INCLUDE_LEGACY=1         # temporary pre-v0.1 migration aid
```

Local SQLite is plaintext. Do not store credentials, customer data, or secrets. See [`SECURITY.md`](SECURITY.md) for the supported boundary and vulnerability-reporting guidance.

## Shared mode — preview

Shared Dejavu uses Cloudflare infrastructure only:

```text
Worker + one Durable Object SQL database per memory space
                        │
          numbered committed changes + SSE
                        │
          rebuildable local SQLite/FTS mirrors
```

It already proves:

- server commit before write receipt;
- immediate read-after-write in the writer's local mirror;
- live peer updates that never block writes;
- contiguous revision watermarks and explicit stale state;
- offline catch-up;
- replayable hard deletion with remembered payload redaction;
- bounded stream lifetimes and reauthentication points;
- token-to-space isolation in local dogfood.

Run the full two-client proof locally:

```bash
./shared-server/test-local.sh
```

**Do not deploy it yet.** Bearer-token dogfood is not a production identity system. Employee or multi-user use still requires verified identity, revocation, content policy, audit/retention decisions, and an encryption story. The blocking review is documented in [`docs/shared-security-review.md`](docs/shared-security-review.md).

See [`docs/shared-memory.md`](docs/shared-memory.md) for the protocol and [`docs/shared-memory-implementation-contract.md`](docs/shared-memory-implementation-contract.md) for invariants.

## Evidence

Run the complete local release gate:

```bash
bun run check
```

It runs:

```bash
bun test ./test
bun run typecheck
bun run bench/recall.ts
bun run bench:behavior
```

The repository also contains:

- [`docs/bench/claims.md`](docs/bench/claims.md) — claim-to-evidence map;
- [`docs/loops/`](docs/loops/) — failed and successful agent behavior experiments;
- [`experiments/`](experiments/) — Cloudflare shared-memory protocol receipts;
- [`experiments/MEMORY-SEAMS-2026-06-11.md`](experiments/MEMORY-SEAMS-2026-06-11.md) — Cloudflare-native Workspace, Containers, Workflows, DO, AI Gateway, Access, continuity, provider-contract, and model-compatibility experiments;
- [`eval/next-agent/`](eval/next-agent/) — a retained negative result that prevented an unproven ranker from becoming default behavior.

The eight-case lexical benchmark is a smoke test, not proof that memory improves agents. Recall receipts and baseline-vs-Dejavu session experiments are the path to stronger claims.

## Design boundaries

Dejavu is deliberately:

- **local-first**, not remote-only;
- **lexical and deterministic by default**, not vector-first;
- **repository-scoped**, not one global memory soup;
- **append-only and auditable**, not silently self-rewriting;
- **budgeted**, not a transcript injector;
- **honest about stale state**, not eventually-consistent theater.

Dejavu is not a secrets manager, generic RAG platform, team ACL product, or replacement for source control.

## Roadmap

The complete production/share roadmap, release gates, and next feature batch live in [`docs/ROADMAP.md`](docs/ROADMAP.md). Completed work stays checked off; hypotheses remain explicitly unshipped until an eval earns them.

## License

MIT
