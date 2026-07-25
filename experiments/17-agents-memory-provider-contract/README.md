# Experiment 17 — companion memory-provider contract on Agents

## Question

> What can a fast-moving companion library provide on top of Cloudflare Agents for pluggable memory providers?

This experiment targets the public npm package **`agents@0.15.0`** (the package
is named `agents`, although the product is commonly called Cloudflare Agents;
there is no `@cloudflare/agents` package involved here).

## Short answer / product recommendation

Ship a small, storage-neutral **durable memory contract** as an independent
library/plugin next to Agents—not inside the SDK and not gated on an upstream
proposal:

```ts
interface MemoryProvider {
  readonly name: string;
  write(input: MemoryWrite): Promise<WriteReceipt>;
  recall(input: RecallRequest): Promise<RecallResult>;
  freshness(scope: MemoryScope): Promise<Freshness>;
  delete(id: string, scope: MemoryScope): Promise<MutationReceipt>;
  resolve(id, scope, { replacedBy, reason? }): Promise<MutationReceipt>;
}
```

The full proposed types are in [`src/contract.ts`](src/contract.ts). The
observable contract carries:

- a write receipt with durable acceptance and a stable memory id;
- explicit `fresh | pending | stale` retrieval state and pending work receipts;
- scope on every write, result, and mutation (not an implicit global bucket);
- a caller-supplied context budget plus actual use and truncation;
- provenance on each hit;
- deletion and supersession resolution receipts;
- provider-defined optional ranking scores, with **no vector or embedding
  requirement**.

The companion library should own these semantics and lifecycle shapes while
using only public Agents/SQL/Workflow seams. Providers should own storage,
indexing, ranking, and asynchronous processing. In particular,
"the source row committed" and "the retrieval index is fresh" must be separate
facts: a durable write may correctly return `durability: "committed"` and
`freshness.state: "pending"`.

### Why this is the smallest useful boundary

`write + recall` alone makes incompatible providers look interchangeable while
hiding their most important differences. A local SQL provider and a remote
semantic service differ in lag, scope enforcement, prompt cost, source
traceability, and erasure behavior. If those are not typed, every Agent app has
to invent side channels or silently over-promise.

The contract deliberately does **not** prescribe:

- vectors, embeddings, cosine distance, FTS, or any search representation;
- a specific database or Cloudflare binding;
- how providers estimate relevance;
- queue, Workflow, alarm, or `waitUntil` mechanics;
- one universal scope hierarchy.

## What `agents@0.15.0` actually provides (observed, not proposed)

These statements come from the installed public declarations and the runnable
local proof:

1. `Agent` is a Durable Object abstraction and exposes a synchronous SQL tagged
   template, `agent.sql<T>\`...\``. This experiment subclasses the real
   `Agent`, binds it as a SQLite Durable Object, and passes the Agent itself to
   adapters via the public structural `SqlProvider` type.
2. `agents/experimental/memory/session` has useful pluggable APIs, but they are
   narrower/different:
   - `SessionProvider` persists tree-structured conversation messages and
     compactions;
   - `ContextProvider`, `WritableContextProvider`, `SkillProvider`, and
     `SearchProvider` back system-prompt/context blocks;
   - `Session.create()` accepts `SqlProvider | SessionProvider`;
   - built-ins include Agent SQL and Postgres providers, `AgentSearchProvider`
     (FTS5), and `R2SkillProvider`.
3. `ContextConfig.maxTokens` constrains a configured context block, and Session
   has token-count/compaction APIs. That is not a per-recall budget/result
   contract.
4. The public `SearchProvider` shape is `get()`, `search(query)`, and optional
   `set(key, content)`. It does not expose durable write receipts, retrieval
   freshness/pending work, memory scope, per-hit provenance, deletion,
   supersession resolution, or budget consumption.
5. No general `MemoryProvider` with the proposed lifecycle semantics is exported
   by `agents@0.15.0`.

Declaration sources inspected after installing the exact version:

- `node_modules/agents/dist/index.d.ts` (`Agent`, `Agent.sql`)
- `node_modules/agents/dist/experimental/memory/session/index.d.ts`
- `node_modules/agents/dist/compaction-helpers-*.d.ts` (provider shapes)
- `node_modules/agents/package.json` (exports and exact version)

These are API observations, not claims that the experimental APIs are defective.
Session history and prompt context solve different jobs and should remain. The
recommendation is an external common boundary for durable cross-session memory:
a thin plugin/library that composes public primitives and can evolve on its own cadence.

## Real local example

[`src/worker.ts`](src/worker.ts) exports `MemoryAgent extends Agent<Env>` and
routes requests through a real local Durable Object namespace. It instantiates
two implementations of the proposed contract:

1. **`OperationalSqlMemory`** — source rows are committed to the Agent's SQLite
   and immediately queryable. Its write receipt is `committed + fresh`.
2. **`AsyncSemanticMemory`** — source rows and pending work are committed to the
   same Agent SQL, then a separate `drain()` step builds a lexical facet index.
   Before processing, recall returns no indexed hit and honestly says `pending`;
   afterward it says `fresh`. The facet implementation proves the contract does
   not need vectors to support an asynchronous "semantic" tier.

Both adapters enforce exact scope keys, return provenance, apply prompt budgets,
and support deletion/supersession. The SQL and simplistic ranking are experiment
fixtures, not recommended production retrieval algorithms.

## Run

Requires Node/npm and a local Workers runtime (installed as a dev dependency):

```bash
cd experiments/17-agents-memory-provider-contract
npm install
npm run typecheck
npm test
```

`npm test` starts `wrangler dev --local`, invokes [`test.mjs`](test.mjs) over
HTTP, and tears the runtime down. It tests:

- actual `agents.Agent` + SQLite Durable Object construction/routing;
- immediate write receipt → recall;
- scope isolation;
- provenance and context-budget accounting/truncation;
- supersession and deletion;
- async `pending → fresh` transition tied to a receipt id;
- retrieval without vector assumptions.

Local state and logs are under `.tmp/` and ignored by the repository-wide
experiment artifact rule.

## Limits

- Local workerd proves API compatibility and DO behavior in the local runtime,
  not deployed latency or global durability.
- The explicit `drain()` endpoint models a queue consumer deterministically; it
  does not choose between Queues, Workflows, alarms, or another scheduler.
- The test proves the proposed interface can span the two materially different
  adapters. It does not prove these exact names should stabilize unchanged.
- Authentication, provider discovery/configuration, encryption, ACLs, quotas,
  and cross-provider transactions are outside this smallest contract.
