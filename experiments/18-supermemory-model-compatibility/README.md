# Experiment 18 — Supermemory local-model compatibility

## Question

Supermemory server v0.0.2 can create searchable local document chunks while its memory-agent extraction fails against local Ollama. Is that failure specific to one model, or is it an OpenAI-protocol/compatibility seam shared by multiple models?

This experiment compares `gpt-oss:20b` and `qwen3-coder:30b` with the same synthetic fixture. Every model gets a deleted/recreated Supermemory data directory and separate ports. No Cloudflare account, work credential, private document, or deployment is used.

## Pass and partial criteria

A model **passes** only when all of these hold:

1. document processing reaches a terminal successful status;
2. `/v4/memories/list` returns at least one extracted memory; and
3. `/v4/profile` or `/v4/search` with `searchMode: "memories"` returns the exact synthetic fact token.

An exact hit from `searchMode: "documents"` proves only that document chunks are searchable. It is reported as **PARTIAL**, never as extraction success.

## One-command run

Prerequisites: Node 20+, `curl`, `ollama` listening on `127.0.0.1:11434`, and both local models already present. The run does not pull models or install anything globally.

```bash
cd experiments/18-supermemory-model-compatibility
npm run run
```

`run.sh` downloads the public Supermemory artifact into ignored `.tmp/bin/` only when absent, then verifies its pinned SHA-256 **before chmod or execution**. Supported release checksums are pinned in the script. On the machine used for the checked-in result:

```text
supermemory-server-darwin-arm64 v0.0.2
89884e8d9c431d4bc3ae3947143aa13cd56af58736740aba4b53dc1faf77dc54
```

The default bound is 420 seconds of processing per model and 120 seconds per HTTP request. Override only for deliberate follow-up runs:

```bash
PROCESSING_TIMEOUT_MS=600000 REQUEST_TIMEOUT_MS=180000 npm run run
```

Tests are dependency-free:

```bash
npm test
```

## Recording proxy

`scripts/recording-proxy.mjs` sits between Supermemory and host Ollama:

```text
Supermemory -> http://127.0.0.1:<proxy>/v1 -> http://127.0.0.1:11434/v1
```

For every call it records:

- endpoint and method;
- model and message roles plus content byte counts/hashes;
- `tools`, `tool_choice`, `response_format`, `stream`, and `options` feature shape;
- response HTTP status, content type, byte count/hash, JSON key/type shape, finish reason, and tool-call presence;
- elapsed milliseconds and sanitized proxy/parse failure metadata.

It deliberately does **not** record authorization values, prompt text, response text, tool names, schema names, the synthetic token, or Supermemory's generated local API key. Raw server logs and encrypted stores stay ignored under `.tmp/`. Checked-in `artifacts/*.jsonl` are machine-readable redacted recordings.

## Baselines and interpretation

Before starting each fresh Supermemory instance, the runner sends three direct OpenAI-compatible calls through the same proxy and model: plain chat, strict `json_schema` response format, and required function tools. These are diagnostics, not pass criteria.

- One model passes and the other fails under equivalent request shapes: evidence for a model-specific compatibility difference.
- Both models pass direct baselines but both fail Supermemory extraction similarly: evidence for a Supermemory agent protocol/parsing compatibility seam, not a model-specific defect.
- Baselines themselves fail or results differ in multiple dimensions: **mixed/blocked**; do not over-attribute causality.

The runner writes `RESULT.md`, `artifacts/result.json`, and one redacted JSONL trace per model. Re-running intentionally replaces these evidence files.
