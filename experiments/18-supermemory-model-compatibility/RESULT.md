# Experiment 18 — RESULT

Generated: 2026-06-12T13:59:40.531Z

## Verdict

Compatibility-specific, not model-specific: both models completed the first OpenAI Responses call, then Ollama rejected Supermemory's follow-up input containing item_reference with the same HTTP 400 protocol error.

A full pass requires processing done, at least one extracted memory, and exact-token retrieval from profile or memory-only search. Document chunks alone are reported as partial, never pass.

| Model | Processing | Memories | Profile exact | Memory-only exact | Chunk exact | Verdict |
| --- | --- | ---: | --- | --- | --- | --- |
| gpt-oss:20b | not done | 0 | no | no | yes | PARTIAL |
| qwen3-coder:30b | not done | 0 | no | no | yes | PARTIAL |

## Protocol failure

| Model | Initial /v1/responses | Follow-up | Follow-up input types | Sanitized error |
| --- | ---: | ---: | --- | --- |
| gpt-oss:20b | 200 | 400 | message, item_reference, function_call_output | input[2]: unknown input item type: "[REDACTED_QUOTED_VALUE]" |
| qwen3-coder:30b | 200 | 400 | message, item_reference, function_call_output | input[2]: unknown input item type: "[REDACTED_QUOTED_VALUE]" |

The first model turn succeeds and returns tool calls. Supermemory executes them, then its next Responses API request sends prior outputs as `item_reference` entries plus `function_call_output`. Ollama 0.21.0 rejects the first `item_reference` before another model turn, identically for both model names. This local evidence isolates the failure at Responses API continuation compatibility rather than generation quality.

## Reproducibility and safety

- Supermemory v0.0.2 Darwin ARM64 SHA-256 was verified before execution: `89884e8d9c431d4bc3ae3947143aa13cd56af58736740aba4b53dc1faf77dc54`.
- Each model used a deleted/recreated data directory and distinct Supermemory/proxy ports.
- Inputs are synthetic. Recording artifacts contain feature shapes, hashes, lengths, statuses, timing, and JSON shapes—not prompt/response text, authorization values, or the generated local API key.
- Processing timeout: 420000 ms per model; request timeout: 120000 ms.

See `artifacts/result.json` and the per-model JSONL recordings for machine-readable evidence. Raw server logs and encrypted databases remain ignored under `.tmp/`.
