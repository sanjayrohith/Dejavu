# Experiment 11 — Supermemory native state on Cloudflare Workspace

## Question

Can a native memory binary put its state on a real Cloudflare Workspace filesystem, survive runtime restart, and execute through Workspace's Container backend?

## Two independent gates

1. **Filesystem durability:** a filesystem-only `Workspace` backed by Durable Object SQLite writes synthetic bytes, fully stops local Wrangler, restarts against the same persisted state, and reads the exact bytes.
2. **Native execution:** a matching Linux x64 image combines `workspace-wsd-linux-x64:0.0.0-alpha.7` with Supermemory `server-v0.0.2` Linux x64. The image verifies Supermemory's published SHA-256, starts it with `SUPERMEMORY_DATA_DIR=/workspace/supermemory-data`, and pulls resulting files back through Workspace sync.

These gates stay separate. Container failure cannot erase a valid VFS persistence result, and VFS persistence cannot be presented as proof that a native process executed.

## Run

Requires Docker/Colima, Bun/npm, Wrangler, and host Ollama for the optional native startup:

```bash
NPM_CONFIG_USERCONFIG=/tmp/dejavu-experiments-npmrc npm install
npm run check
npm run run
```

`run.sh` records only a digest of the synthetic marker. It downloads no binary to the repository. The Docker build obtains the public x64 release and fails if this checksum does not match:

```text
8bf394690807b37786d22a61d3ee64212b7ae82374894e754856134ca60761b4
```

## Why x64

The first preflight incorrectly treated Workspace's x64 `wsd` and Supermemory's ARM64 artifact as the only available pairing. Supermemory also publishes Linux x64. This corrected experiment uses matching Linux x64 artifacts, so any remaining blocker belongs to the Workspace/Container runtime path rather than architecture selection.

## Expected interpretation

- `Workspace restart persistence: PASS` proves the preview VFS itself survives local Wrangler restart.
- `Container native execution: PASS` proves the binary can start against the Workspace mount locally.
- `BLOCKED at workspace-container-connect` isolates the current local Container supervisor/connect seam. It does not imply deployed Cloudflare Containers fail.

The preview package is unstable and unsuitable for production. This experiment exists to generate product feedback, not bless an API.
