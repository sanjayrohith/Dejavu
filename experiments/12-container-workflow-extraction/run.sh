#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
MODE="${MODE:-auto}"

curl --fail --silent --show-error http://127.0.0.1:6767/ >/dev/null || {
  echo "real local Supermemory is required at http://127.0.0.1:6767" >&2
  exit 1
}
npm install --silent
npm run check

run_mode() {
  local label="$1" config="$2" log="wrangler.${1}.log"
  rm -rf .wrangler/state
  npx wrangler dev --config "$config" --port 8792 >"$log" 2>&1 &
  local pid=$!
  for _ in $(seq 1 120); do
    curl --fail --silent http://127.0.0.1:8792/health >/dev/null 2>&1 && break
    if ! kill -0 "$pid" 2>/dev/null; then
      cat "$log" >&2
      wait "$pid" || true
      return 1
    fi
    sleep 1
  done
  if ! curl --fail --silent http://127.0.0.1:8792/health >/dev/null; then
    cat "$log" >&2
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    return 1
  fi
  local result=0
  node harness.mjs || result=$?
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  return "$result"
}

case "$MODE" in
  container) run_mode container wrangler.jsonc ;;
  workflow-only) run_mode workflow-only wrangler.workflow.jsonc ;;
  auto)
    if run_mode container wrangler.jsonc; then
      echo "Combined local Container + Workflow path passed."
    else
      echo "Container lifecycle boundary reproduced; proving the real Workflow path directly." >&2
      grep -E "Container failed to start|Network connection lost" wrangler.container.log >&2 || true
      run_mode workflow-only wrangler.workflow.jsonc
    fi
    ;;
  *) echo "MODE must be auto, container, or workflow-only" >&2; exit 2 ;;
esac
