#!/usr/bin/env bash
# Local product dogfood: two clients use the real shared server endpoints and local copies.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf shared-server/.tmp shared-server/.wrangler/state
mkdir -p shared-server/.tmp
cat > shared-server/.dev.vars <<'VARS'
DEJAVU_SHARED_TOKENS=dev-token:demo
VARS
PORT="${PORT:-8790}"
BASE="http://127.0.0.1:$PORT"
(cd shared-server && wrangler dev --local --ip 127.0.0.1 --port "$PORT" >.tmp/server.log 2>&1) &
pid=$!
cleanup() {
  kill "$pid" 2>/dev/null || true
  for _ in 1 2 3; do
    pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    [ -z "$pids" ] && break
    echo "$pids" | xargs kill 2>/dev/null || true
    sleep 0.3
  done
  pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"; [ -n "$pids" ] && echo "$pids" | xargs kill -9 2>/dev/null || true
  rm -f shared-server/.dev.vars shared-server/.tmp/a.sqlite* shared-server/.tmp/b.sqlite*
}
trap cleanup EXIT
for _ in $(seq 1 100); do curl -fsS -H 'Authorization: Bearer dev-token' "$BASE/v1/shared/status" >/dev/null 2>&1 && break; sleep .1; done
export DEJAVU_SHARED_GATEWAY="$BASE" DEJAVU_SHARED_TOKEN="dev-token"
export DEJAVU_SHARED_MIRROR_DB="$PWD/shared-server/.tmp/a.sqlite"
A_OUT="$(bun run src/cli.ts shared remember 'Decision: live shared CLI dogfood works')"
echo "$A_OUT"
ID="$(echo "$A_OUT" | awk '{print $4}')"
bun run src/cli.ts shared handoff 'Client A finished; client B should continue'
export DEJAVU_SHARED_MIRROR_DB="$PWD/shared-server/.tmp/b.sqlite"
B_RECALL="$(bun run src/cli.ts shared recall 'live shared CLI')"
echo "$B_RECALL"
echo "$B_RECALL" | grep -q 'live shared CLI dogfood works'
echo "$B_RECALL" | grep -q 'Client A finished'
bun run src/cli.ts shared signal "$ID" used
bun run src/cli.ts shared delete "$ID"
B_AFTER="$(bun run src/cli.ts shared recall 'live shared CLI')"
echo "$B_AFTER"
! echo "$B_AFTER" | grep -q 'live shared CLI dogfood works'
COUNT="$(bun -e 'import { Database } from "bun:sqlite"; const db = new Database(process.argv[1]); console.log(db.query("SELECT COUNT(*) AS n FROM mirror_slips WHERE slip_id = ?").get(process.argv[2]).n); db.close()' "$DEJAVU_SHARED_MIRROR_DB" "$ID")"
[ "$COUNT" = "0" ] || { echo "FAIL: deleted memory remains in local copy"; exit 1; }
HISTORY="$(curl -fsS -H 'Authorization: Bearer dev-token' "$BASE/v1/shared/events?since=0")"
echo "$HISTORY" | grep -q '"purged":true' || { echo "FAIL: server history did not redact deleted memory"; exit 1; }
! echo "$HISTORY" | grep -q 'live shared CLI dogfood works' || { echo "FAIL: server history retains deleted content"; exit 1; }
echo 'PASS: shared CLI remember → handoff → other local copy recall → delete removes local and server-held memory content'
