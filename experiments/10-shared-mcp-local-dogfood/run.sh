#!/usr/bin/env bash
# Experiment 10 — shared-MCP local dogfood.
#
# Boots the real shared-server locally on a free port with a freshly generated
# bearer token, then runs harness.mjs which spawns two `bun run src/shared-mcp.ts`
# MCP stdio servers (each with its own local mirror sqlite) and drives the full
# remember → handoff → cross-client recall → signal forget → recall flow through
# actual MCP JSON-RPC tool calls.
#
# All state is in this experiment's .tmp directory and is removed on exit.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
TMP="$HERE/.tmp"
SERVER_LOG="$TMP/server.log"
HARNESS_LOG="$TMP/harness.log"
RESULT="$HERE/RESULT.md"
MIRROR_A="$TMP/a.sqlite"
MIRROR_B="$TMP/b.sqlite"
# Pick a free port. Default 8791, but search forward if it's taken so this
# experiment never collides with neighbours (e.g. a stale workerd from a
# previous run or another local dev server).
DEFAULT_PORT="${EXP10_PORT:-8791}"
PORT="$DEFAULT_PORT"
for try in $(seq 0 20); do
  candidate=$((DEFAULT_PORT + try))
  if ! lsof -nP -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; then
    PORT="$candidate"
    break
  fi
done
BASE="http://127.0.0.1:$PORT"

# Generated single-use bearer token. Never persisted outside .tmp/.dev.vars and
# the server's in-memory env; both go away in cleanup.
# Note: we feed /dev/urandom into `head -c 24` *first* so head closes the pipe
# explicitly, and `tr` reads from that bounded stream — avoids a pipefail
# SIGPIPE 141 when head reaches its byte limit before tr has drained urandom.
TOKEN="exp10-$(head -c 1024 </dev/urandom | LC_ALL=C tr -dc 'a-zA-Z0-9' | head -c 24 || true)"
if [ -z "${TOKEN#exp10-}" ]; then
  TOKEN="exp10-$$-$(date +%s)"
fi

set +e
rm -rf "$TMP"
rm -rf "$REPO_ROOT/shared-server/.tmp" 2>/dev/null
# Best-effort: try to clear stale wrangler state, but tolerate parallel wrangler
# dev processes holding files open (they're a different server on a different
# port and don't affect this experiment's state anyway).
rm -rf "$REPO_ROOT/shared-server/.wrangler/state" 2>/dev/null
set -e
mkdir -p "$TMP" "$REPO_ROOT/shared-server/.tmp"
cat > "$REPO_ROOT/shared-server/.dev.vars" <<VARS
DEJAVU_SHARED_TOKEN=$TOKEN
VARS

SERVER_PID=""
cleanup() {
  set +e
  if [ -n "$SERVER_PID" ]; then kill "$SERVER_PID" 2>/dev/null; fi
  # `wrangler dev` spawns workerd as a child; killing the parent doesn't always
  # take down workerd. Take everything still bound to the port explicitly.
  for _ in 1 2 3; do
    pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    if [ -z "$pids" ]; then break; fi
    echo "$pids" | xargs kill 2>/dev/null
    sleep 0.3
  done
  pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  if [ -n "$pids" ]; then echo "$pids" | xargs kill -9 2>/dev/null; fi
  rm -f "$REPO_ROOT/shared-server/.dev.vars"
  rm -rf "$REPO_ROOT/shared-server/.tmp"
  # Mirror sqlite files contain real data; remove them.
  rm -f "$MIRROR_A"* "$MIRROR_B"*
  # Keep RESULT.md and the run logs in $TMP for inspection.
}
trap cleanup EXIT

echo "[exp10] booting shared-server on $BASE with token $TOKEN"
(
  cd "$REPO_ROOT/shared-server" \
    && wrangler dev --local --ip 127.0.0.1 --port "$PORT" >"$SERVER_LOG" 2>&1
) &
SERVER_PID=$!

# Wait for /v1/shared/status to answer with the token.
for _ in $(seq 1 200); do
  if curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/v1/shared/status" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
if ! curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/v1/shared/status" >/dev/null 2>&1; then
  echo "[exp10] shared-server did not come up; see $SERVER_LOG" >&2
  exit 1
fi
echo "[exp10] shared-server ready"

export DEJAVU_SHARED_GATEWAY="$BASE"
export DEJAVU_SHARED_TOKEN="$TOKEN"
export EXP10_MIRROR_A="$MIRROR_A"
export EXP10_MIRROR_B="$MIRROR_B"
export EXP10_RESULT="$RESULT"

echo "[exp10] driving MCP harness (output in $HARNESS_LOG)"
set +e
( cd "$REPO_ROOT" && node "$HERE/harness.mjs" ) >"$HARNESS_LOG" 2>&1
rc=$?
set -e

# Echo the harness log so callers running this in a captured shell still see it.
echo "----- harness.log -----"
cat "$HARNESS_LOG" || true
echo "----- end harness.log -----"

if [ "$rc" -ne 0 ]; then
  echo "[exp10] harness failed with exit $rc" >&2
  echo "----- server.log tail -----" >&2
  tail -50 "$SERVER_LOG" >&2 || true
  exit "$rc"
fi
echo "[exp10] PASS — see $RESULT"
