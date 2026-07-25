#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
bun test
bun run harness.ts preflight --out artifacts/preflight.json || true
bun run harness.ts dry-run
