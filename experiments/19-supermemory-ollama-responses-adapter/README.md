# Experiment 19 — Supermemory/Ollama Responses adapter

## Question

Can a thin local adapter close the `item_reference` seam observed in Experiment 18, without modifying Supermemory v0.0.2 or Ollama 0.21.0?

The adapter proxies OpenAI-compatible traffic. For successful `/v1/responses` JSON responses it caches the ordered `output` array under the response ID and each output item under its item ID. On a follow-up it replaces every `item_reference` in place with a cloned prior output item (or ordered response output list), leaving `function_call_output` and all surrounding input order unchanged. All non-Responses traffic and Responses requests without references pass through.

## Safety and cache policy

- Cache defaults: 256 response/item IDs, 10-minute TTL, in-process only, LRU eviction.
- Unknown, malformed, expired/evicted, and colliding references fail closed; they are never forwarded unresolved.
- Cache writes are validated atomically. Only successful JSON Responses outputs are cached.
- Exact prior output expansion is tested first. Only when Ollama rejects an expanded follow-up does the runner retry once in a fresh data directory with the smallest normalization: remove output-only `id` and `status`, preserving type, call ID, arguments, content, and order.
- Fixture content is synthetic. Checked-in artifacts contain hashes, lengths, type/order metadata, statuses and counters—not prompt/response text, credentials, IDs, API keys, or the exact token. Raw logs and data stores remain in ignored `.tmp/`.

This is experiment-local code. It does not fork or patch either product and does not deploy or globally install anything.

## Strict result criteria

**PASS** requires all three:

1. processing reaches terminal success;
2. at least one extracted memory exists; and
3. profile or `searchMode: "memories"` returns the exact synthetic token.

Exact document/chunk search alone is **PARTIAL**.

## One-command run

Prerequisites: Node 20+, `curl`, and local Ollama listening on `127.0.0.1:11434` with `qwen3-coder:30b` already installed.

```bash
cd experiments/19-supermemory-ollama-responses-adapter
npm run run
```

The script runs unit tests, downloads Supermemory only into ignored `.tmp/bin/` if absent, verifies the pinned release SHA-256 before chmod/execution, runs baseline passthrough, then uses a deleted/recreated Supermemory data directory. It never pulls a model. `qwen3-coder:30b` always runs first. Optional follow-up after its outcome:

```bash
RUN_GPT_OSS=1 npm run run
```

Bounds can be deliberately overridden:

```bash
PROCESSING_TIMEOUT_MS=600000 REQUEST_TIMEOUT_MS=180000 npm run run
```

The verified Darwin ARM64 v0.0.2 checksum is:

```text
89884e8d9c431d4bc3ae3947143aa13cd56af58736740aba4b53dc1faf77dc54
```

Other supported platform checksums are pinned in `run.sh`. Outputs are `RESULT.md`, `artifacts/result.json`, and redacted per-attempt JSONL.

## Unit tests

```bash
npm test
```

Tests cover passthrough identity, item and response-ID expansion, exact ordering, `function_call_output` preservation, collision rejection, TTL expiry, LRU bounds, and the single explicit normalization variant.
