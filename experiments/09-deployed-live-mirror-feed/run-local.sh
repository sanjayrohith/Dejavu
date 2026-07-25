#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
rm -rf .tmp .wrangler/state
mkdir -p .tmp
PORT="${PORT:-8899}"; BASE="http://127.0.0.1:$PORT"
wrangler dev --local --ip 127.0.0.1 --port "$PORT" --log-level warn > .tmp/wrangler.log 2>&1 & pid=$!
cleanup(){ kill "$pid" 2>/dev/null||true; sleep .3; ps="$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null||true)"; [ -n "$ps" ] && echo "$ps"|xargs kill 2>/dev/null||true; }
trap cleanup EXIT
for _ in $(seq 1 200); do curl -fsS "$BASE/health" >/dev/null 2>&1 && break; sleep .1; done
curl -fsS "$BASE/health" >/dev/null
node ./harness.mjs --base "$BASE" --out RESULT-local.md
cat RESULT-local.md
