#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
: "${REMOTE_URL:?REMOTE_URL=https://... required}"
case "$REMOTE_URL" in https://*) ;; *) echo "REMOTE_URL must be https"; exit 2;; esac
curl -fsS "$REMOTE_URL/health" >/dev/null
node ./harness.mjs --base "${REMOTE_URL%/}" --out RESULT-remote.md
cat RESULT-remote.md
