#!/usr/bin/env bash
# Deterministic Terrarium child agent.
#
# Terrarium invokes the agent like:    <agent-cmd> "<prompt-with-task>"
# So $1 is the wrapped prompt. We don't need its content for evidence,
# but we record its length to prove the agent was invoked normally.
#
# This is intentionally NOT an LLM. The point of the experiment is to test
# the transport (env inheritance + subprocess Dejavu access), not model
# behavior. Whether a model would choose to call Dejavu MCP is out of scope.
set -u
# NOTE: deliberately not -e — we want to continue and capture failures
# as evidence rather than aborting mid-script.

EVIDENCE_DIR="${EXPERIMENT_EVIDENCE_DIR:-/tmp/exp04-evidence}"
mkdir -p "$EVIDENCE_DIR"
ENV_OUT="$EVIDENCE_DIR/child-env.txt"
SEND_OUT="$EVIDENCE_DIR/child-send.txt"
INBOX_OUT="$EVIDENCE_DIR/child-inbox.txt"
STATS_OUT="$EVIDENCE_DIR/child-stats.txt"

echo "=== terrarium child agent: deterministic ==="
echo "argv[0]=$0"
echo "argc=$#"
if [ $# -ge 1 ]; then
  echo "prompt-bytes=${#1}"
else
  echo "prompt-bytes=0"
fi
echo "pwd=$(pwd)"

echo "--- env seen by child ---"
{
  echo "DEJAVU_DB=${DEJAVU_DB:-<unset>}"
  echo "DEJAVU_AUTHOR=${DEJAVU_AUTHOR:-<unset>}"
  echo "DEJAVU_SESSION=${DEJAVU_SESSION:-<unset>}"
  echo "EXPERIMENT_EVIDENCE_DIR=${EXPERIMENT_EVIDENCE_DIR:-<unset>}"
  echo "TERRARIUM_RUN_ID=${TERRARIUM_RUN_ID:-<unset>}"
  echo "TERRARIUM_DEPTH=${TERRARIUM_DEPTH:-<unset>}"
} | tee "$ENV_OUT"

if [ -z "${DEJAVU_REPO_ROOT:-}" ]; then
  echo "DEJAVU_REPO_ROOT is required" >&2
  exit 2
fi
DEJAVU_CLI=(bun run "$DEJAVU_REPO_ROOT/src/cli.ts")

echo "--- child writes via dejavu CLI (mailbox send) into inherited DEJAVU_DB ---"
# `dejavu as child-04 send parent-04 "<body>"` writes a mailbox message
# authored as child-04 into whatever DEJAVU_DB points to. This is a
# deterministic write path that touches the same SQLite file the parent
# is using — proving the child can reach the parent's isolated DB.
"${DEJAVU_CLI[@]}" as child-04 send parent-04 \
  "hello from terrarium child, run=${TERRARIUM_RUN_ID:-unknown}" \
  2>&1 | tee "$SEND_OUT"
SEND_EXIT=${PIPESTATUS[0]}
echo "child-send-exit=$SEND_EXIT"

echo "--- child reads parent's inbox (proves read access to same DB) ---"
# Note: the parent earlier seeded a message to child-04. Child reads it.
"${DEJAVU_CLI[@]}" as child-04 inbox --all 2>&1 | tee "$INBOX_OUT"
echo "child-inbox-exit=${PIPESTATUS[0]}"

echo "--- child stats (which DB?) ---"
"${DEJAVU_CLI[@]}" stats 2>&1 | tee "$STATS_OUT"
echo "child-stats-exit=${PIPESTATUS[0]}"

echo "=== terrarium child agent: done ==="

cat <<EOF
Summary:
deterministic child observed DEJAVU_DB=${DEJAVU_DB:-<unset>} and DEJAVU_AUTHOR=${DEJAVU_AUTHOR:-<unset>}; wrote one mailbox message as child-04.

Changed files:
- $ENV_OUT
- $SEND_OUT
- $INBOX_OUT
- $STATS_OUT
- (1 row inserted into \$DEJAVU_DB)

Verification:
- env dump captured
- dejavu send exit=$SEND_EXIT

Follow-ups:
- none — parent will assert on DB contents
EOF
