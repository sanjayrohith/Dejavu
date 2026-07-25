#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="${PORT:-8913}"
export DO_BASE="http://127.0.0.1:${PORT}"
export SUPERMEMORY_BASE="${SUPERMEMORY_BASE:-http://127.0.0.1:6767}"
LOG="$HERE/wrangler.log"

if ! curl -fsS "$SUPERMEMORY_BASE/" >/dev/null; then
  echo "Supermemory is required at $SUPERMEMORY_BASE" >&2
  exit 1
fi

cleanup() {
  if [[ -n "${WRANGLER_PID:-}" ]]; then kill "$WRANGLER_PID" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM

cd "$HERE"
wrangler dev --local --port "$PORT" >"$LOG" 2>&1 &
WRANGLER_PID=$!
for _ in $(seq 1 100); do
  if curl -fsS "$DO_BASE/health" >/dev/null 2>&1; then break; fi
  if ! kill -0 "$WRANGLER_PID" 2>/dev/null; then
    echo "wrangler exited; see $LOG" >&2
    tail -80 "$LOG" >&2
    exit 1
  fi
  sleep 0.1
done
curl -fsS "$DO_BASE/health" >/dev/null

node --test test.mjs
node harness.mjs

echo "wrote $HERE/RESULT.md"
