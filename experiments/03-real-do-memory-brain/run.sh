#!/usr/bin/env bash
# Experiment 03 runner.
#
# Boots `wrangler dev --local` on an explicit loopback port, waits for /health
# to return 200, runs the harness, kills wrangler, and writes RESULT.md.
#
# Strictly local: --local forbids remote CF API calls, and we always bind to
# 127.0.0.1. No deploy, no account mutation.

set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-8874}"
BASE="http://127.0.0.1:${PORT}"

mkdir -p .tmp
LOG=".tmp/wrangler.log"
: > "$LOG"

# Wrangler dev needs *its own* state dir so this experiment can't accidentally
# share DO storage with anything else in the repo.
export WRANGLER_LOG_PATH=".tmp/wrangler-internal.log"
WRANGLER_PIDS_FILE=".tmp/wrangler-pids.txt"
: > "$WRANGLER_PIDS_FILE"

echo "[run.sh] starting wrangler dev on ${BASE} ..."
# `--local` is the default in recent wrangler but we pass it explicitly so the
# intent is loud. `--var` is unused; no secrets needed.
wrangler dev \
  --local \
  --ip 127.0.0.1 \
  --port "$PORT" \
  --log-level warn \
  >"$LOG" 2>&1 &
WRANGLER_PID=$!
echo "$WRANGLER_PID" >> "$WRANGLER_PIDS_FILE"

cleanup() {
  echo "[run.sh] cleaning up experiment listeners on ${BASE} ..."
  # Signal the wrapper first.
  kill "$WRANGLER_PID" 2>/dev/null || true
  sleep 1
  # Wrangler can daemonize node/workerd children under a different parent.
  # Kill only processes bound to this experiment port, never broad wrangler PIDs.
  LISTENER_PIDS="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$LISTENER_PIDS" ]; then
    echo "$LISTENER_PIDS" | xargs kill 2>/dev/null || true
    sleep 1
    echo "$LISTENER_PIDS" | xargs kill -9 2>/dev/null || true
  fi
  kill -9 "$WRANGLER_PID" 2>/dev/null || true
}
trap cleanup EXIT

# Wait up to ~30s for /health. wrangler dev on a cold node_modules can take a
# couple of seconds to compile the worker the first time.
echo "[run.sh] waiting for ${BASE}/health ..."
ready=0
for _ in $(seq 1 300); do
  if curl -fsS "${BASE}/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.1
done

if [ "$ready" -ne 1 ]; then
  echo "[run.sh] wrangler dev never became healthy. Last 60 log lines:"
  tail -n 60 "$LOG" || true
  exit 1
fi

echo "[run.sh] running harness ..."
node ./harness.mjs --base "$BASE" --out RESULT.md

echo "---"
cat RESULT.md
