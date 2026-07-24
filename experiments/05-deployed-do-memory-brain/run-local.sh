#!/usr/bin/env bash
# Experiment 05 — local proof runner.
#
# Boots `wrangler dev --local` on an explicit loopback port, waits for /health
# to return 200, runs the harness in --mode local, kills wrangler, and writes
# RESULT-local.md.
#
# Strictly local: --local forbids remote CF API calls, and we always bind to
# 127.0.0.1. NO deploy, NO account mutation. The dirty-state files live under
# .tmp/ and .wrangler/state/ inside this directory.

set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8875}"
BASE="http://127.0.0.1:${PORT}"

mkdir -p .tmp
LOG=".tmp/wrangler.log"
: > "$LOG"

export WRANGLER_LOG_PATH=".tmp/wrangler-internal.log"
WRANGLER_PIDS_FILE=".tmp/wrangler-pids.txt"
: > "$WRANGLER_PIDS_FILE"

echo "[run-local.sh] starting wrangler dev on ${BASE} ..."
wrangler dev \
  --local \
  --ip 127.0.0.1 \
  --port "$PORT" \
  --log-level warn \
  >"$LOG" 2>&1 &
WRANGLER_PID=$!
echo "$WRANGLER_PID" >> "$WRANGLER_PIDS_FILE"

cleanup() {
  echo "[run-local.sh] cleaning up experiment listeners on ${BASE} ..."
  kill "$WRANGLER_PID" 2>/dev/null || true
  sleep 1
  LISTENER_PIDS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$LISTENER_PIDS" ]; then
    echo "$LISTENER_PIDS" | xargs kill 2>/dev/null || true
    sleep 1
    echo "$LISTENER_PIDS" | xargs kill -9 2>/dev/null || true
  fi
  kill -9 "$WRANGLER_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "[run-local.sh] waiting for ${BASE}/health ..."
ready=0
for _ in $(seq 1 300); do
  if curl -fsS "${BASE}/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.1
done

if [ "$ready" -ne 1 ]; then
  echo "[run-local.sh] wrangler dev never became healthy. Last 60 log lines:"
  tail -n 60 "$LOG" || true
  exit 1
fi

echo "[run-local.sh] running harness (local mode) ..."
node ./harness.mjs --base "$BASE" --out RESULT-local.md --mode local --label "wrangler-dev"

echo "---"
cat RESULT-local.md
