# Experiment 12: Container + Workflow extraction

Can a Cloudflare Container lifecycle, coordinated by a durable Cloudflare Workflow, make asynchronous extraction by a local Supermemory server reliable?

This experiment uses **no mock API**. Every submission and status poll targets the Supermemory process already running at `http://127.0.0.1:6767`. Each run generates a fresh `exp12-...` marker and checks that marker in the terminal document.

## Contract under test

`ExtractionWorkflow`:

1. Starts and health-checks a tiny Container bridge when the Container binding exists.
2. Submits `POST /v3/documents` with the unique marker as Supermemory's `customId`.
3. Gives submit and poll steps bounded Workflow retries/timeouts.
4. Polls durable `GET /v3/documents/:id` status, sleeping durably between polls.
5. Stops only at `done`, `completed`, or `failed` and returns an inspectable receipt containing the complete poll history and terminal document.
6. Replays the submission after completion and proves that `customId` returns the same document ID rather than creating a duplicate.

The Worker exposes:

- `POST /extractions` — create a named Workflow instance (the marker is also the instance ID)
- `GET /receipts/:id` — inspect Cloudflare's durable instance status and eventual receipt
- `GET /health` — report whether the Container binding is active

The bridge is a real Node HTTP process built from `container/Dockerfile`; it proxies to `http://host.docker.internal:6767`. It does not implement or simulate Supermemory.

## Run

Requirements: Node/npm, Docker, Wrangler-compatible local runtime, and real Supermemory on port 6767.

```bash
cd experiments/12-container-workflow-extraction
./run.sh
```

The default `MODE=auto` first attempts the combined Container + Workflow path. If local Container startup fails, it prints that boundary and automatically runs `wrangler.workflow.jsonc`, which removes only the Container binding and tests the same real Workflow against `127.0.0.1:6767`.

To run either path alone:

```bash
MODE=container ./run.sh       # must fail if the reproduced local Container boundary remains
MODE=workflow-only ./run.sh   # real local Workflow + real local Supermemory
```

A successful lifecycle test writes ignored `receipt.latest.json`. Wrangler logs and local state are also ignored. Static/unit checks are:

```bash
npm install
npm run check
```

## What counts as success?

Orchestration success means the Workflow reaches `complete`, preserves the marker and poll history in its output, observes a genuine terminal Supermemory state, and proves retry idempotency. A terminal Supermemory `failed` state is intentionally retained as a valid *receipt* but is not extraction success; this distinction prevents durable orchestration from disguising an extractor failure.

See [RESULT.md](./RESULT.md) for the observed outcome and exact boundary.