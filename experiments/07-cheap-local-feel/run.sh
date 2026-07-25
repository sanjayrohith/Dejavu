#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
rm -rf .tmp
mkdir -p .tmp
PORT="${PORT:-8897}"
BASE="http://127.0.0.1:$PORT"
REMEMBER_MS="${REMEMBER_MS:-235}"
RECALL_MS="${RECALL_MS:-188}"
node ./src/authority.mjs --port "$PORT" --remember-ms "$REMEMBER_MS" --recall-ms "$RECALL_MS" > .tmp/authority.log 2>&1 &
pid=$!
cleanup() {
  kill "$pid" 2>/dev/null || true
  sleep 0.2
  listeners="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$listeners" ]; then echo "$listeners" | xargs kill 2>/dev/null || true; fi
}
trap cleanup EXIT
for _ in $(seq 1 100); do
  if curl -fsS "$BASE/health" >/dev/null 2>&1; then break; fi
  sleep 0.05
done
curl -fsS "$BASE/health" >/dev/null
node ./harness.mjs --base "$BASE" --out RESULT.md
cat RESULT.md
