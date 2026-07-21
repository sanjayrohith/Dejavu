#!/usr/bin/env bash
# End-to-end shared-server test.
#
# Boots `wrangler dev` with a throwaway bearer token, then exercises the
# /v1/shared/* API directly using curl and the live SSE stream using
# `curl -N`. No external repo state is touched. The test cleans itself up
# on exit.
#
# Run from anywhere; this script `cd`s into the shared-server directory.
#
# Coverage:
#   - unauthorized requests (missing token, wrong token) return 401
#   - authorized GET /v1/shared/status returns ok + headRevision
#   - POST /v1/shared/remember, /handoff, /signal, /delete record changes
#     and bump headRevision in revision order
#   - GET /v1/shared/events?since=N returns the right window
#   - GET /v1/shared/stream?since=0 replays prior events, then delivers a
#     fresh remember in near real time (live broadcast)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$SERVER_DIR"

PORT="${PORT:-8791}"
TOKEN="test-token-$$"
OTHER_TOKEN="other-token-$$"
BASE="http://127.0.0.1:$PORT"

mkdir -p .tmp
rm -rf .wrangler/state
cat > .dev.vars <<VARS
DEJAVU_SHARED_TOKENS=$TOKEN:alice,$OTHER_TOKEN:bob
VARS

# Free the port if anything is lingering from a prior run.
existing="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
[ -n "$existing" ] && echo "$existing" | xargs kill 2>/dev/null || true

# Boot wrangler in the background.
wrangler dev --local --ip 127.0.0.1 --port "$PORT" >.tmp/server.log 2>&1 &
server_pid=$!

cleanup() {
  kill "$server_pid" 2>/dev/null || true
  for _ in 1 2 3; do
    pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
    [ -z "$pids" ] && break
    echo "$pids" | xargs kill 2>/dev/null || true
    sleep 0.3
  done
  pids="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "$pids" ] && echo "$pids" | xargs kill -9 2>/dev/null || true
  wait "$server_pid" 2>/dev/null || true
  rm -f .dev.vars
  rm -rf .tmp/server.log .tmp/stream.out
}
trap cleanup EXIT

# Wait for the server to start.
ready=0
for _ in $(seq 1 120); do
  if curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/v1/shared/status" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.1
done
if [ "$ready" -ne 1 ]; then
  echo "FAIL: server did not become ready on $BASE"
  cat .tmp/server.log || true
  exit 1
fi

fail() {
  echo "FAIL: $1"
  exit 1
}

pass() {
  echo "PASS: $1"
}

# ---------------------------------------------------------------------------
# auth
# ---------------------------------------------------------------------------

code="$(curl -s -o /dev/null -w '%{http_code}' "$BASE/v1/shared/status")"
[ "$code" = "401" ] || fail "missing token should be 401, got $code"
pass "missing token -> 401"

code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer wrong" "$BASE/v1/shared/status")"
[ "$code" = "401" ] || fail "wrong token should be 401, got $code"
pass "wrong token -> 401"

status_body="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/v1/shared/status")"
echo "$status_body" | grep -q '"ok":true' || fail "status not ok: $status_body"
echo "$status_body" | grep -q '"authority":"alice"' || fail "status missing mapped space: $status_body"
echo "$status_body" | grep -q '"headRevision":0' || fail "expected headRevision=0 at start, got: $status_body"
pass "authorized status returns named space and headRevision=0"

other_status="$(curl -fsS -H "Authorization: Bearer $OTHER_TOKEN" "$BASE/v1/shared/status")"
echo "$other_status" | grep -q '"authority":"bob"' || fail "second token missing bob space: $other_status"
echo "$other_status" | grep -q '"headRevision":0' || fail "second space should begin empty: $other_status"
pass "a second token reaches a separate empty memory space"

# ---------------------------------------------------------------------------
# remember / handoff / signal record changes, revisions advance in order
# ---------------------------------------------------------------------------

post_event() {
  local path="$1" body="$2"
  curl -fsS -X POST -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
    -d "$body" "$BASE$path"
}

r1="$(post_event /v1/shared/remember '{"slipId":"slip-1","text":"first decision"}')"
echo "$r1" | grep -q '"ok":true' || fail "remember not ok: $r1"
echo "$r1" | grep -q '"revision":1' || fail "expected revision=1, got: $r1"
pass "remember -> revision 1"

r2="$(post_event /v1/shared/handoff '{"handoffId":"hand-1","summary":"client A done"}')"
echo "$r2" | grep -q '"revision":2' || fail "expected revision=2, got: $r2"
pass "handoff -> revision 2"

r3="$(post_event /v1/shared/signal '{"signalId":"sig-1","action":"used"}')"
echo "$r3" | grep -q '"revision":3' || fail "expected revision=3, got: $r3"
pass "signal -> revision 3"

status_body="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/v1/shared/status")"
echo "$status_body" | grep -q '"headRevision":3' || fail "expected headRevision=3, got: $status_body"
pass "status reflects headRevision=3"

other_status="$(curl -fsS -H "Authorization: Bearer $OTHER_TOKEN" "$BASE/v1/shared/status")"
echo "$other_status" | grep -q '"headRevision":0' || fail "bob could observe alice revisions: $other_status"
other_events="$(curl -fsS -H "Authorization: Bearer $OTHER_TOKEN" "$BASE/v1/shared/events?since=0")"
if echo "$other_events" | grep -q 'first decision'; then
  fail "bob could read alice memory events: $other_events"
fi
pass "different memory spaces cannot read one another's saved changes"

# ---------------------------------------------------------------------------
# events catch-up window
# ---------------------------------------------------------------------------

events_all="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/v1/shared/events?since=0")"
echo "$events_all" | grep -q '"type":"remember"' || fail "missing remember in events: $events_all"
echo "$events_all" | grep -q '"type":"handoff"' || fail "missing handoff in events: $events_all"
echo "$events_all" | grep -q '"type":"signal"' || fail "missing signal in events: $events_all"
pass "events?since=0 returns all three events"

events_tail="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/v1/shared/events?since=2")"
echo "$events_tail" | grep -q '"type":"signal"' || fail "expected signal in tail: $events_tail"
if echo "$events_tail" | grep -q '"type":"remember"'; then
  fail "events?since=2 should not include remember: $events_tail"
fi
pass "events?since=2 only returns events with revision>2"

deleted="$(post_event /v1/shared/delete '{"deleteId":"delete-1","slipId":"slip-1","authoredBy":"test","sessionId":"test"}')"
echo "$deleted" | grep -q '"type":"delete"' || fail "delete did not return deletion event: $deleted"
echo "$deleted" | grep -q '"revision":4' || fail "expected delete revision=4, got: $deleted"
delete_tail="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/v1/shared/events?since=3")"
echo "$delete_tail" | grep -q '"type":"delete"' || fail "deletion not replayable: $delete_tail"
purged_history="$(curl -fsS -H "Authorization: Bearer $TOKEN" "$BASE/v1/shared/events?since=0")"
echo "$purged_history" | grep -q '"purged":true' || fail "historical remember was not redacted: $purged_history"
if echo "$purged_history" | grep -q 'first decision'; then
  fail "deleted memory content remains in server history: $purged_history"
fi
pass "delete is replayable and purges remembered content from server history"

# Unknown path -> 404 (still requires auth, so this proves routing too).
code="$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $TOKEN" "$BASE/v1/shared/nope")"
[ "$code" = "404" ] || fail "unknown path should be 404, got $code"
pass "unknown path -> 404"

# ---------------------------------------------------------------------------
# live stream: replay + live broadcast
# ---------------------------------------------------------------------------

rm -f .tmp/stream.out
# Start a streaming consumer. -N disables curl buffering so we see frames
# as they arrive. Capped at 6 seconds to avoid runaway.
( curl -N -s --max-time 6 \
    -H "Authorization: Bearer $TOKEN" \
    "$BASE/v1/shared/stream?since=0" >.tmp/stream.out 2>/dev/null || true ) &
stream_pid=$!

# Give the consumer time to connect and replay.
sleep 1

# Fire a fresh event after the consumer is connected.
r5="$(post_event /v1/shared/remember '{"slipId":"slip-live","text":"live event after subscribe"}')"
echo "$r5" | grep -q '"revision":5' || fail "expected revision=5, got: $r5"

# Wait for the streaming consumer to finish (max-time will end it).
wait "$stream_pid" 2>/dev/null || true

stream_out="$(cat .tmp/stream.out)"
echo "$stream_out" | grep -q '^event: hello' || fail "stream missing hello frame, got: $stream_out"
echo "$stream_out" | grep -q '"type":"remember"' || fail "stream missing replayed remember: $stream_out"
echo "$stream_out" | grep -q '"type":"handoff"' || fail "stream missing replayed handoff: $stream_out"
echo "$stream_out" | grep -q '"type":"signal"' || fail "stream missing replayed signal: $stream_out"
echo "$stream_out" | grep -q '"type":"delete"' || fail "stream missing replayed delete: $stream_out"
echo "$stream_out" | grep -q 'live event after subscribe' || fail "stream missing live broadcast: $stream_out"
echo "$stream_out" | grep -q '^event: expires' || fail "stream missing bounded-lifetime expires frame: $stream_out"
echo "$stream_out" | grep -q '"reason":"stream-ttl"' || fail "stream missing TTL reason in expires frame: $stream_out"
pass "stream replays prior events, broadcasts live ones, and announces a bounded TTL"

echo "ALL PASS"
