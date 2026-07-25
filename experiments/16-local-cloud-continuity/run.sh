#!/usr/bin/env bash
# Experiment 16: local/cloud-shaped authority-first continuity.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TMP="$HERE/.tmp"
RESULT="$HERE/RESULT.md"
SUPERMEMORY_URL="${SUPERMEMORY_URL:-http://127.0.0.1:6767}"
DEFAULT_PORT="${EXP16_PORT:-8796}"
PORT="$DEFAULT_PORT"
for offset in $(seq 0 30); do
  candidate=$((DEFAULT_PORT + offset))
  if ! lsof -nP -iTCP:"$candidate" -sTCP:LISTEN >/dev/null 2>&1; then PORT="$candidate"; break; fi
done
BASE="http://127.0.0.1:$PORT"
TOKEN="exp16-$(head -c 1024 </dev/urandom | LC_ALL=C tr -dc 'a-zA-Z0-9' | head -c 24 || true)"
[ -n "${TOKEN#exp16-}" ] || TOKEN="exp16-$$-$(date +%s)"
SERVER_PID=""

cleanup() {
  set +e
  [ -z "$SERVER_PID" ] || kill "$SERVER_PID" 2>/dev/null
  for _ in 1 2 3; do
    pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    [ -n "$pids" ] || break
    echo "$pids" | xargs kill 2>/dev/null
    sleep 0.2
  done
  pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  [ -z "$pids" ] || echo "$pids" | xargs kill -9 2>/dev/null
  rm -f "$TMP"/*-mirror.sqlite* "$TMP"/*-dejavu.sqlite*
}
trap cleanup EXIT

rm -rf "$TMP"
mkdir -p "$TMP" "$TMP/repo-local" "$TMP/repo-cloud" "$TMP/repo-outsider" "$TMP/wrangler"
# Two independent checkouts with one normalized origin, plus an unrelated repo.
for repo in repo-local repo-cloud; do
  git -C "$TMP/$repo" init -q
  git -C "$TMP/$repo" remote add origin git@example.invalid:synthetic/continuity-fixture.git
  printf 'synthetic fixture\n' > "$TMP/$repo/README.md"
done
git -C "$TMP/repo-outsider" init -q
git -C "$TMP/repo-outsider" remote add origin https://example.invalid/synthetic/unrelated-fixture.git
printf 'unrelated synthetic fixture\n' > "$TMP/repo-outsider/README.md"

if ! curl -fsS "$SUPERMEMORY_URL/" >/dev/null; then
  echo "[exp16] real local Supermemory is required at $SUPERMEMORY_URL" >&2
  exit 2
fi
if ! curl -fsS "$SUPERMEMORY_URL/v4/openapi" >/dev/null; then
  echo "[exp16] $SUPERMEMORY_URL does not expose the expected real Supermemory API" >&2
  exit 2
fi

echo "[exp16] booting local Worker + SQLite Durable Object at $BASE"
(
  cd "$ROOT/shared-server"
  wrangler dev --local --ip 127.0.0.1 --port "$PORT" \
    --persist-to "$TMP/wrangler" --var "DEJAVU_SHARED_TOKEN:$TOKEN"
) >"$TMP/shared-server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 1 300); do
  curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/v1/shared/status" >/dev/null 2>&1 && break
  sleep 0.1
done
if ! curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/v1/shared/status" >/dev/null; then
  echo "[exp16] shared server failed; log follows" >&2
  tail -100 "$TMP/shared-server.log" >&2 || true
  exit 1
fi

export DEJAVU_SHARED_GATEWAY="$BASE"
export DEJAVU_SHARED_TOKEN="$TOKEN"
export SUPERMEMORY_URL
export EXP16_TMP="$TMP"
export EXP16_RESULT="$RESULT"

echo "[exp16] running continuity harness"
set +e
node "$HERE/harness.mjs" 2>&1 | tee "$TMP/harness.log"
rc=${PIPESTATUS[0]}
set -e
if [ "$rc" -ne 0 ]; then
  echo "[exp16] FAIL (exit $rc); see $RESULT and $TMP/*.log" >&2
  exit "$rc"
fi
echo "[exp16] PASS — $RESULT"
