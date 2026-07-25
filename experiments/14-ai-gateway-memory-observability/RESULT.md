# Result

**Outcome: conditional yes; this environment did not satisfy the policy/verification seam, so no inference was made.**

Run date: 2026-06-11.

The harness proves that a BYOK extraction can be represented as one bounded AI Gateway request carrying privacy-preserving `tenant`, fixed `purpose`, requested `model`, and application `trace`. Gateway's payload-off logging mode is a strong fit: model/provider, token counts, estimated cost, status and duration remain observable without persisting sensitive source text or extracted memory.

It also exposes an important limit: request metadata is not memory-provider authorization or provenance. Gateway can account by an opaque tenant dimension, but the provider must authenticate the tenant, authorize extraction purpose, and retain source/evidence links separately. Gateway cost is best-effort and client `max_tokens` only bounds output for one call; a blocking Gateway spend-limit rule supplies the cumulative enforcement boundary.

## Machine-verified preflight

`./run.sh` writes `artifacts/preflight.json` using presence-only checks. On this machine it found:

- Cloudflare account ID: set;
- OpenAI BYOK environment binding: set;
- AI Gateway ID: absent, safely selectable as documented `default`;
- Wrangler OAuth session: available from the CLI, but not exposed as a bearer binding to this standalone harness;
- `CLOUDFLARE_API_TOKEN`: absent, so automated control-plane/log verification is unavailable;
- explicit live consent: absent;
- blocking spend-limit attestation: absent.

Therefore live mode was blocked before network I/O. This is a policy result rather than an inference failure. The exact missing seams are emitted in `missingForLive` and `controlPlaneMissing`; credential values are never emitted.

## Decision

AI Gateway is suitable as the model egress/accounting layer for memory extraction **if** the production integration adds:

1. tenant authorization before constructing opaque metadata;
2. a known-pricing model allowlist and blocking spend limits scoped by gateway/model and, where useful, tenant metadata;
3. a Cloudflare API token or Worker binding that can verify/query Gateway policy and logs;
4. provider-side provenance and consent records, because payload-off Gateway logs intentionally cannot explain why a memory was extracted.

Do not treat custom metadata alone as a security boundary, and do not enable live inference from this experiment until preflight is green.
