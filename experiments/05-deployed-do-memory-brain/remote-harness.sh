#!/usr/bin/env bash
# Experiment 05 — remote harness runner.
#
# This script DOES NOT DEPLOY ANYTHING. It only points the harness at a
# workers.dev URL that *you* must deploy ahead of time (see README.md).
#
# Required:
#   REMOTE_URL    full https URL of the deployed exp 05 worker, e.g.
#                 https://dejavu-exp05-deployed-do-memory-brain.<sub>.workers.dev
#
# Optional:
#   LABEL         free-form label for the RESULT (e.g. "deployed-iad")
#   RESET         set to 1 to POST /reset before the run (requires the worker
#                 to have been deployed with DEJAVU_EXP_ALLOW_RESET=1)
#   CONCURRENT    concurrent writers in test 3 (default 64)
#   SEQUENTIAL    sequential ops in test 4 (default 50)
#   WARM          warm-up requests before timing (default 5 for remote)
#   OUT           output path (default RESULT-remote.md)
#
# Safety: this script refuses to run if REMOTE_URL points to 127.0.0.1 or
# localhost — use run-local.sh for that. It also refuses non-https URLs to
# keep accidental "I deployed to a preview hostname over http" runs from
# being mistaken for a real remote measurement.

set -euo pipefail
cd "$(dirname "$0")"

if [ -z "${REMOTE_URL:-}" ]; then
  echo "[remote-harness.sh] REMOTE_URL is required. Example:"
  echo "  REMOTE_URL=https://dejavu-exp05-deployed-do-memory-brain.<sub>.workers.dev \\"
  echo "    bash ./remote-harness.sh"
  exit 2
fi

case "$REMOTE_URL" in
  http://127.0.0.1*|http://localhost*|https://127.0.0.1*|https://localhost*)
    echo "[remote-harness.sh] REMOTE_URL points at loopback — use run-local.sh instead."
    exit 2
    ;;
esac

case "$REMOTE_URL" in
  https://*) : ;;
  *)
    echo "[remote-harness.sh] REMOTE_URL must be https — got: $REMOTE_URL"
    exit 2
    ;;
esac

LABEL="${LABEL:-deployed}"
OUT="${OUT:-RESULT-remote.md}"
CONCURRENT="${CONCURRENT:-64}"
SEQUENTIAL="${SEQUENTIAL:-50}"
WARM="${WARM:-5}"

RESET_FLAG=()
if [ "${RESET:-0}" = "1" ]; then
  RESET_FLAG=(--reset)
  echo "[remote-harness.sh] /reset enabled. Worker must be deployed with DEJAVU_EXP_ALLOW_RESET=1."
fi

echo "[remote-harness.sh] preflight GET ${REMOTE_URL}/health ..."
if ! curl -fsS "${REMOTE_URL}/health" >/dev/null; then
  echo "[remote-harness.sh] preflight failed. Is the worker deployed and reachable?"
  exit 1
fi

echo "[remote-harness.sh] running harness against ${REMOTE_URL} ..."
HARNESS_ARGS=(
  --base "$REMOTE_URL"
  --out "$OUT"
  --mode remote
  --label "$LABEL"
  --concurrent "$CONCURRENT"
  --sequential "$SEQUENTIAL"
  --warm "$WARM"
)
if [ "${RESET:-0}" = "1" ]; then
  HARNESS_ARGS+=(--reset)
fi
node ./harness.mjs "${HARNESS_ARGS[@]}"

echo "---"
cat "$OUT"
