#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
rm -rf .tmp
mkdir -p .tmp
# Throwaway benchmark DBs/logs; RESULT.md is the durable artifact.
PORT="${PORT:-8872}"
python3 sequencer.py --port "$PORT" --log .tmp/events.jsonl >.tmp/server.log 2>&1 &
pid=$!
cleanup() { kill "$pid" 2>/dev/null || true; }
trap cleanup EXIT
python3 - <<PY
import time, urllib.request
url='http://127.0.0.1:${PORT}/health'
for _ in range(100):
    try:
        with urllib.request.urlopen(url, timeout=.2) as r:
            if r.status == 200: raise SystemExit(0)
    except Exception:
        time.sleep(.03)
raise SystemExit('sequencer did not become healthy')
PY
python3 harness.py --base "http://127.0.0.1:${PORT}" --out RESULT.md
cat RESULT.md
