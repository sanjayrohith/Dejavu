# Experiment 11 — RESULT

Generated: 2026-06-11T10:28:33.195Z

## Verdict

- **Workspace SQLite VFS persistence: PASS.** Bytes written through the real `@cloudflare/workspace@0.0.0-alpha.7` API survived a full local Wrangler stop/restart using the same persisted Durable Object state.
- **Matching native Supermemory x64 execution: BLOCKED.** The matching image reached `workspace-container-connect` and returned: `Network connection lost.`.

## Evidence

| Assertion | Result |
| --- | --- |
| Workspace package | `0.0.0-alpha.7` preview |
| Persisted marker digest | `ab595ba1b2c5` |
| Read before restart | exact match |
| Read after Wrangler restart | exact match |
| Supermemory artifact | `linux-x64` v0.0.2 |
| Published SHA-256 | `8bf394690807b37786d22a61d3ee64212b7ae82374894e754856134ca60761b4` |
| Workspace container/native result | `blocked` |

The filesystem result is independent of Container startup. No claim is made that the native binary executed or that Supermemory can currently use the persisted VFS through local Wrangler. The remaining blocker is the actual Workspace Container lifecycle/connect path, not CPU architecture: both wsd and Supermemory were Linux x64.

## Boundaries

This is local workerd/Container evidence, not deployed durability. The content is synthetic. The binary was downloaded in the Docker build from the public v0.0.2 release and verified against its published checksum. No cloud model credential was supplied; successful startup uses host Ollama and skips embedding prewarm.
