#!/usr/bin/env bash
# Experiment 06 — run script.
#
# Boots the authority server (src/authority.mjs), waits for /health, runs the
# harness against it, and tears the authority back down. All deterministic,
# all local. No remote deploy.
#
# Usage:
#   ./run.sh                # uses :memory: db, port 8876, writes RESULT.md
#   AUTHORITY_PORT=9001 ./run.sh
#   AUTHORITY_DB=./.tmp/auth.sqlite ./run.sh   # persistent authority db
#   ./run.sh --label loopback-mba
set -euo pipefail

cd "$(dirname "$0")"

PORT="${AUTHORITY_PORT:-8876}"
DB="${AUTHORITY_DB:-:memory:}"

mkdir -p .tmp

# Start authority in background.
AUTHORITY_PORT="$PORT" AUTHORITY_DB="$DB" \
  node src/authority.mjs > .tmp/authority.log 2>&1 &
AUTH_PID=$!

cleanup() {
  if kill -0 "$AUTH_PID" 2>/dev/null; then
    kill "$AUTH_PID" 2>/dev/null || true
    # Give it a beat to release the port, then SIGKILL if still around.
    for _ in 1 2 3 4 5; do
      kill -0 "$AUTH_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$AUTH_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# Wait for /health.
for i in $(seq 1 50); do
  if curl -fsS "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
  if [ "$i" -eq 50 ]; then
    echo "[run.sh] authority did not become healthy on port $PORT" >&2
    echo "[run.sh] --- authority log ---" >&2
    cat .tmp/authority.log >&2 || true
    exit 1
  fi
done

echo "[run.sh] authority up on http://127.0.0.1:${PORT} (db=${DB})"
echo "[run.sh] running harness…"

node --no-warnings harness.mjs --base "http://127.0.0.1:${PORT}" "$@"

echo "[run.sh] done"
