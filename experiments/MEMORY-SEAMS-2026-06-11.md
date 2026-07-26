# Cloudflare-native memory seams — experiment synthesis

**Date:** 2026-06-11

**Program:** experiments 11–17

**Execution:** seven isolated Terrarium worktrees, Pi one-shot children (`pi -p --no-session`), model pinned to `kindle-alpha`

**Data:** synthetic only

## Why this program exists

Supermemory makes semantic extraction, profiles, graph evolution, and hybrid search increasingly commodity. Jordan's differentiated opportunity is to dogfood how a memory engine composes with the rest of a Cloudflare-native agent system:

- immediate operational state;
- durable asynchronous work;
- local/cloud continuity;
- identity without static agent credentials;
- model observability and policy;
- pluggable provider contracts;
- files and native processes inside an agent Workspace.

The experiments ask where Cloudflare primitives already compose cleanly, where local parity is incomplete, and what a fast-moving companion layer can supply without waiting on SDK changes.

## Results at a glance

| # | Seam | Result | What is actually supported |
|---|---|---|---|
| 11 | Native memory binary + Workspace persistence | **VFS pass / native blocked** | Real Workspace SQLite VFS bytes survived a full Wrangler restart. Matching x64 wsd+Supermemory image built and verified, but local Workspace Container connect failed with `Network connection lost` before binary execution. |
| 12 | Containers + Workflows for extraction | **Partial / blocked** | Workflows reliably submit, retry, poll, and receipt the lifecycle. Local Container supervisor failed on arm64 Colima; Supermemory extraction itself reached terminal failure. |
| 13 | DO immediate truth + semantic later | **Pass, narrow** | DO SQLite returned exact read-after-write in ~4 ms. Supermemory's searchable document chunk appeared in ~810 ms. This proves indexing visibility, not successful extracted graph memories. |
| 14 | AI Gateway for BYO-model memory | **Conditional / preflight** | Gateway metadata, payload-off logs, retry bounds, and spend policies fit memory extraction. No paid call was made because spend-limit and control-plane verification were absent. |
| 15 | Access identity across agents | **Partial pass** | A real cached laptop Access assertion validated against live JWKS and derived stable pseudonymous identity with no static API key. Independent remote identity/continuity and revocation remain unproved. |
| 16 | One local/cloud continuity model | **Operational pass; semantic fail** | Exact revisioned continuity, honest stale state, reconnect/catch-up, and resolution passed across independent processes. Supermemory memory extraction failed and never masqueraded as fresh. |
| 17 | Companion memory-provider contract on Agents | **Pass** | A real `agents@0.15.0` Agent/SQLite DO hosted immediate and asynchronous provider adapters behind one storage-neutral lifecycle contract, implemented entirely outside the SDK. |
| 18 | Supermemory local-model compatibility | **Protocol failure isolated** | Both local models completed direct structured/tool baselines and Supermemory's first Responses call. Ollama rejected the identical follow-up `item_reference` continuation with HTTP 400; chunks indexed, zero memories extracted. |

## The strongest conclusion

The correct architecture is not “one memory database does everything.” It is a two-speed contract:

```text
agent action
    │
    ├─ immediate operational authority
    │    Agent / Durable Object SQL
    │    committed receipt, scope, active state, exact recall
    │
    └─ asynchronous knowledge provider
         Workflow-controlled extraction/indexing
         pending → fresh | failed, never implied
```

Operational continuity must not wait for semantic extraction. Semantic providers must not be allowed to translate “accepted” or “queued” into “fresh.”

## Primitive-by-primitive answer

### Durable Objects / SQLite

**Best fit:** immediate continuity authority.

Proven locally:

- exact committed receipt;
- millisecond read-after-write;
- repository/tenant scope;
- monotonic revision transport;
- explicit active/resolved state;
- local mirrors with contiguous watermarks;
- honest `behind` and `fresh=false` state.

DO SQL should own active work, handoffs, provider job receipts, and the current lifecycle—not embeddings.

### Workflows

**Best fit:** semantic ingestion controller.

Proven locally:

- idempotent submission using provider `customId`;
- bounded durable steps;
- polling separated by durable sleeps;
- retry and terminal failure receipts;
- inspection after the request process is gone.

Workflows improve control-plane reliability. They cannot make a broken model/extractor succeed, and should report provider failure exactly.

### Containers

**Potential fit:** host opaque/native memory engines and local models.

Current result:

- image and bridge worked directly in Docker;
- Wrangler built the Container image;
- local Container supervisor failed to start it on this arm64 Colima environment.

This is a local-parity/product-feedback seam, not evidence that deployed Containers fail. A deployed protected proof or fixed local supervisor is still required.

### Workspace

**Potential fit:** durable provider files, model cache, and binary-visible filesystem.

The first run selected the wrong Supermemory architecture and was rejected. The corrected proof used matching Linux x64 artifacts. Real Workspace SQLite VFS bytes survived a full local Wrangler restart. The Docker image built, verified Supermemory's published checksum, and bundled matching x64 `wsd`; local Workspace Container connect then failed with `Network connection lost` before shell execution. Persistence is proved independently; native execution remains blocked at local Container lifecycle/connect, not CPU architecture.

### AI Gateway

**Best fit:** model egress and accounting, not memory authorization.

Useful dimensions:

- model/provider;
- token counts and estimated cost;
- request status and latency;
- opaque tenant;
- fixed purpose (`memory-extraction`);
- application trace id;
- payload-off logging;
- timeout/retry controls;
- model allowlists and blocking spend limits.

Still provider-owned:

- tenant authentication and authorization;
- source/evidence provenance;
- consent;
- why a memory was accepted;
- deletion and retention semantics.

### Access

**Best fit:** human identity at the memory boundary.

A cached user session can make local acquisition invisible after initial SSO/WARP ceremony. The application must pin issuer and application AUD, validate expiry, derive namespace from verified `(issuer, sub)`, and reauthorize streams before token expiry.

Access removes static API-key distribution; it does not remove bearer replay, host trust, or the irreducible first ceremony on an independent remote machine.

### Companion library on `@cloudflare/agents`

The strongest adjacent seam is a provider-neutral lifecycle contract shipped as independent glue on top of Agents—not a change request for the Agents SDK and not a vector-store interface:

```ts
interface MemoryProvider {
  write(input): Promise<WriteReceipt>
  recall({ query, scope, budget }): Promise<RecallResult>
  freshness(scope): Promise<Freshness>
  delete(id, scope): Promise<MutationReceipt>
  resolve(id, scope, replacement): Promise<MutationReceipt>
}
```

Required concepts:

- hierarchical scope: tenant/workspace/agent/session;
- durability: `committed | accepted`;
- freshness: `fresh | pending | stale`;
- receipt-linked pending work;
- context token budget and truncation;
- provenance;
- deletion and supersession/resolution;
- provider-defined scores without assuming vectors.

The current experimental session/context-provider APIs solve different problems. Keep this lifecycle additive in an external package/plugin that consumes public `Agent`, `Agent.sql`, scheduling, and Workflow APIs. Do not block iteration on upstream SDK design, review, compatibility, or release cadence.

## Supermemory-specific finding

Experiment 18 placed a redacting OpenAI-compatible recorder between Supermemory and Ollama and ran fresh isolated data directories for `gpt-oss:20b` and `qwen3-coder:30b`.

For both models:

- direct plain, JSON-schema, and required-tool baselines returned HTTP 200;
- Supermemory's initial `POST /v1/responses` returned HTTP 200 with function calls;
- Supermemory executed those calls and sent a continuation containing `item_reference` plus `function_call_output` entries;
- Ollama 0.21.0 rejected the first `item_reference` with HTTP 400 `invalid_request_error`;
- chunks were embedded and became searchable;
- zero memories were extracted and profiles remained empty.

The failure is therefore **protocol-specific, not model-specific** in this matrix. The next thin-glue opportunity is a compatibility adapter that resolves/replays prior response items into a continuation form Ollama accepts, or an Ollama Responses implementation that supports `item_reference`. Until that is proved, Supermemory is only a semantic document index in this local path.

## Portfolio leverage

This architecture connects existing work rather than creating another isolated product:

- **Dejavu:** continuity semantics, handoffs, trust, receipts, stale-state honesty.
- **Terrarium / Swarm / Loop:** generate parallel and adversarial continuity workloads.
- **Workspace / cloudbox / filepath:** filesystem and computer substrate.
- **Containers / machinectl:** native provider tier and real-machine escape hatch.
- **Capa / Lab / Worker Loaders:** capability-scoped provider execution.
- **AI Gateway / ai-connect:** governed model egress.
- **Access / UserDO:** personal identity and namespace authority.
- **Gateproof / cloudeval / MemoryBench:** executable quality, latency, and token evidence.
- **my-ax / glance / desk:** integrated human, ambient, and physical dogfood surfaces.

## Recommended next actions

1. Report the Workspace VFS pass and matching-x64 local Container connect failure to the Workspace/Containers teams; rerun the native half in a protected deployed Container when approved.
2. Build Experiment 19 as a narrow Responses compatibility adapter: cache initial response output items and normalize Supermemory's `item_reference` continuation into an Ollama-supported form; rerun the exact Experiment 18 acceptance gate.
3. Extract experiment 17 into a tiny independent companion library/plugin on top of `agents`, backed by experiments 12, 13, and 16. Ship and dogfood it without requiring upstream SDK changes.
4. Run one protected deployed Container proof only after Access is configured; compare with the local supervisor failure.
5. Complete experiment 15's independent remote SSO/WARP proof and stream revocation test.
6. Configure one bounded AI Gateway with a blocking spend limit, then make exactly one payload-off extraction call and inspect its log dimensions.
7. Add these seams to a real my-ax/agent workflow; measure continuation correctness, latency, and context tokens rather than building a demo dashboard.

## Stop decisions

- Do not build a Dejavu vector engine.
- Do not treat queued provider writes as memory.
- Do not hide semantic failures behind exact operational recall.
- Do not use static shared API keys when human Access identity is available.
- Do not add a provider wrapper unless it deletes custom substrate or produces stronger E2E evidence.
