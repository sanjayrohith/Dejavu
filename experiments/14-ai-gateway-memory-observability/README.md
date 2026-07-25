# Experiment 14: AI Gateway memory observability

## Question

Can a memory service send a **bring-your-own-model/provider-key** extraction request through Cloudflare AI Gateway while retaining the tenant, purpose, model, cost and trace evidence needed to operate the service safely?

This experiment is intentionally a client-only harness. It deploys no Worker and creates no public endpoint. Live mode performs exactly one small inference request, only after explicit consent and a spend-limit attestation.

## Run

Requirements: Bun 1.1+.

```bash
./run.sh                       # tests, redacted preflight, zero-call dry run
bun run harness.ts preflight   # exits 2 when live prerequisites are missing
bun run harness.ts dry-run     # prints the complete redacted request
```

For a deliberately enabled live BYOK request:

```bash
export CLOUDFLARE_ACCOUNT_ID=...
export AI_GATEWAY_ID=default       # or an existing gateway ID
export OPENAI_API_KEY=...          # sent only as Authorization to the provider route
export MEMORY_TENANT=...           # hashed before it leaves the process
export AIG_SPEND_LIMIT_VERIFIED=1  # attest a blocking Gateway spend-limit rule exists
export ALLOW_LIVE_INFERENCE=1
bun run harness.ts live --out artifacts/live-$(date +%s).json
```

Do not commit `.env` or `artifacts/live-*.json`. The harness never prints credentials and redacts the account ID. `default` is a documented Gateway ID that is created on first use; use an existing named gateway if creation is undesirable.

## Controls

`policy.json` is executable policy, not prose:

- one allowed model (`openai/gpt-4o-mini`);
- at most 48 output tokens;
- one attempt, no retry, and a 10 second timeout;
- mandatory opaque `tenant`, fixed `purpose=memory-extraction`, and unique `trace` metadata;
- `cf-aig-collect-log-payload: false`, so prompts and extracted memory are not retained in Gateway logs;
- live execution blocked unless the operator attests that a **blocking AI Gateway spend-limit rule** is configured.

The token cap bounds one request but does not bound cumulative or input-token spend. Gateway spend limits are the enforcement seam for cumulative cost. The attestation exists because merely adding custom metadata does not create a spend policy.

## What is observable?

| Need of a memory provider | Sent/observed by Gateway | Gap / interpretation |
|---|---|---|
| tenant isolation/accounting | opaque `tenant` in `cf-aig-metadata` | Gateway cannot prove the hash maps to the authenticated tenant; the memory service must derive it after tenant authorization. |
| purpose/consent | fixed `purpose=memory-extraction` metadata | Descriptive, not authorization. The service must authorize this purpose before inference. |
| actual model/provider | request model plus Gateway log model/provider | Log is preferable because routing/fallback can differ from intent. This harness disables retries but does not infer the final model itself. |
| bounded cost | `max_tokens=48`; Gateway token counts and estimated cost; required spend-limit attestation | Provider/Gateway cost is an estimate for known pricing. A configured blocking spend limit, not the client cap alone, is the cumulative policy boundary. |
| trace/correlation | generated `trace` metadata; `cf-aig-log-id` captured when returned | The application trace and Gateway log ID are complementary. Preserve both in the provider's audit record. |
| memory text / source evidence | deliberately **not logged** (`collect-log-payload=false`) | Gateway metadata is insufficient to audit extraction quality. The memory provider needs a separate access-controlled provenance record. |

Gateway logs document model, provider, status, duration, token counts and cost even when payload collection is disabled. Custom metadata enables analytics and spend-limit dimensions. Live output captures provider usage and the Gateway log ID, but dashboard/API log inspection is still needed to prove persisted metadata and cost.

## Authentication and policy seams

Two credentials have different jobs:

1. `OPENAI_API_KEY` is the BYOK data-plane credential for the compatibility endpoint.
2. `CLOUDFLARE_API_TOKEN` is needed by a standalone process to automate control-plane/log verification. A local Wrangler OAuth login is not an environment binding the harness can safely consume. Preflight reports this independently as `controlPlaneMissing`.

This distinction prevents a successful inference from being mistaken for machine-verified observability. With no Cloudflare API token, inspect the matching `trace`/`cf-aig-log-id` in the dashboard; do not claim end-to-end log proof.

## References

- [OpenAI-compatible endpoint](https://developers.cloudflare.com/ai-gateway/usage/chat-completion/)
- [Custom metadata](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/)
- [Logging without payloads](https://developers.cloudflare.com/ai-gateway/observability/logging/#collect-log-payload-cf-aig-collect-log-payload)
- [Spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/)
- [BYOK stored keys](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/)
