#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8891}"
rm -rf .tmp
mkdir -p .tmp

npx wrangler dev --local --ip 127.0.0.1 --port "$PORT" --persist-to .tmp/state >.tmp/wrangler.log 2>&1 &
WRANGLER_PID=$!
trap 'kill "$WRANGLER_PID" 2>/dev/null || true; wait "$WRANGLER_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 80); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    BASE_URL="http://127.0.0.1:${PORT}" node ./test.mjs
    exit 0
  fi
  if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then
    cat .tmp/wrangler.log >&2
    exit 1
  fi
  sleep 0.25
done

cat .tmp/wrangler.log >&2
exit 1
