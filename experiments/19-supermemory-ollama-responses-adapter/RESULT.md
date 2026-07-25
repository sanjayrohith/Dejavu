# Experiment 19 — RESULT

Generated: 2026-06-12T14:13:35.613Z

## Verdict

PASS: qwen3-coder:30b completed extraction through the exact adapter and returned the exact synthetic token from an allowed memory surface.

| Model | Variant | Baseline passthrough | Processing | Memories | Profile exact | Memory-only exact | Chunk exact | Verdict |
| --- | --- | --- | --- | ---: | --- | --- | --- | --- |
| qwen3-coder:30b | exact | yes | done | 4 | yes | yes | yes | PASS |

## Adapter evidence

The adapter cached successful Responses output by response and item IDs, expanded references in place, and preserved function-call outputs. Exact expansion was always attempted first. The metadata-stripping variant was run only if Ollama rejected a follow-up after expansion. Unknown, expired/evicted, and colliding IDs fail closed. See the redacted JSONL and `artifacts/result.json` for statuses, expansion counts, forwarded type order, cache bounds, and fail-closed counters.

Chunk-only retrieval is PARTIAL, never PASS. Raw prompts, model output, credentials, generated API keys, databases, and server logs are excluded. Supermemory checksum verified before execution: `89884e8d9c431d4bc3ae3947143aa13cd56af58736740aba4b53dc1faf77dc54`.
