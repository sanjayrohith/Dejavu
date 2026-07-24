#!/usr/bin/env bash
# Experiment 04: Can Dejavu be passed into a Terrarium child?
#
# This script:
#   1. Creates an isolated DEJAVU_DB under ./evidence/<timestamp>/
#   2. Exports DEJAVU_DB and DEJAVU_AUTHOR=parent-04
#   3. Seeds a mailbox message in the isolated DB as the parent
#   4. Spawns Terrarium with --agent pointing at our deterministic bash
#      script (NOT an LLM). The child writes & reads through the same
#      isolated DB.
#   5. After Terrarium returns, asserts on the DB contents.
#
# Intentionally avoids global config changes. Does not edit ~/.dejavu,
# ~/.terrarium config, or any opencode config.
set -u
cd "$(dirname "$0")"

TS="$(date +%Y%m%d-%H%M%S)"
EVIDENCE_DIR="$(pwd)/evidence/run-$TS"
mkdir -p "$EVIDENCE_DIR"
echo "evidence-dir=$EVIDENCE_DIR"

# Isolated DB lives inside the experiment dir — never touches ~/.dejavu.
export DEJAVU_DB="$EVIDENCE_DIR/dejavu.db"
export DEJAVU_AUTHOR="parent-04"
export EXPERIMENT_EVIDENCE_DIR="$EVIDENCE_DIR"

REPO_ROOT="$(cd ../.. && pwd)"
export DEJAVU_REPO_ROOT="$REPO_ROOT"
DEJAVU_CLI=(bun run "$REPO_ROOT/src/cli.ts")

echo
echo "=== STEP 1: confirm isolated DB does not exist yet ==="
ls -l "$DEJAVU_DB" 2>&1 || echo "(expected: no such file)"

echo
echo "=== STEP 2: seed parent message into isolated DEJAVU_DB ==="
"${DEJAVU_CLI[@]}" send child-04 "ping from parent-04, run=$TS" \
  2>&1 | tee "$EVIDENCE_DIR/parent-send.txt"
PARENT_SEND_EXIT=${PIPESTATUS[0]}
echo "parent-send-exit=$PARENT_SEND_EXIT"

echo
echo "=== STEP 3: confirm isolated DB now exists & is NOT ~/.dejavu ==="
ls -l "$DEJAVU_DB"
"${DEJAVU_CLI[@]}" stats 2>&1 | tee "$EVIDENCE_DIR/parent-stats.txt"

echo
echo "=== STEP 4: spawn Terrarium child with deterministic agent ==="
AGENT="$(pwd)/agent/deterministic-agent.sh"
echo "agent=$AGENT"
echo "DEJAVU_DB=$DEJAVU_DB"
echo "DEJAVU_AUTHOR=$DEJAVU_AUTHOR"

# One Terrarium call only (depth budget intact).
# We pipe terra output to a file AND through tee so we can inspect.
terrarium \
  --agent "$AGENT" \
  --log "$EVIDENCE_DIR/terra-transcript.log" \
  "exp04 deterministic child run $TS" \
  > "$EVIDENCE_DIR/terra-stdout.log" 2>&1
TERRA_EXIT=$?
echo "terra-exit=$TERRA_EXIT"
echo "--- terra stdout tail ---"
tail -40 "$EVIDENCE_DIR/terra-stdout.log" || true

# Try to capture the child's terrarium run log too.
CHILD_LOG_LINE=$(grep -m1 'log:' "$EVIDENCE_DIR/terra-stdout.log" || true)
echo "child-log-line=$CHILD_LOG_LINE"

echo
echo "=== STEP 5: assertions ==="

# 5a. env-inheritance: child env file should exist & contain our DEJAVU_DB
ASSERT_LOG="$EVIDENCE_DIR/assertions.txt"
: > "$ASSERT_LOG"

assert() {
  local name="$1"; local cond="$2"
  if eval "$cond"; then
    echo "PASS: $name" | tee -a "$ASSERT_LOG"
    return 0
  else
    echo "FAIL: $name" | tee -a "$ASSERT_LOG"
    return 1
  fi
}

FAILS=0

assert "child-env file written" "[ -s \"$EVIDENCE_DIR/child-env.txt\" ]" || FAILS=$((FAILS+1))
assert "child saw DEJAVU_DB=$DEJAVU_DB" \
  "grep -qx \"DEJAVU_DB=$DEJAVU_DB\" \"$EVIDENCE_DIR/child-env.txt\"" \
  || FAILS=$((FAILS+1))
assert "child saw DEJAVU_AUTHOR=parent-04 (inherited)" \
  "grep -qx \"DEJAVU_AUTHOR=parent-04\" \"$EVIDENCE_DIR/child-env.txt\"" \
  || FAILS=$((FAILS+1))

# 5b. shared-DB write: query the SAME DB the parent created.
echo
echo "--- parent-04 inbox (should contain child-04's message) ---"
"${DEJAVU_CLI[@]}" inbox parent-04 --all 2>&1 | tee "$EVIDENCE_DIR/parent-inbox-after.txt"

assert "parent inbox contains a message from child-04" \
  "grep -q 'child-04 -> parent-04' \"$EVIDENCE_DIR/parent-inbox-after.txt\"" \
  || FAILS=$((FAILS+1))

echo
echo "--- child-04 inbox snapshot (child saw parent's seeded msg?) ---"
# The child already dumped its inbox view during its run.
cat "$EVIDENCE_DIR/child-inbox.txt" 2>/dev/null || true
assert "child saw parent-04's earlier message in inherited DB" \
  "grep -q 'parent-04 -> child-04' \"$EVIDENCE_DIR/child-inbox.txt\"" \
  || FAILS=$((FAILS+1))

# 5c. isolation: we did NOT touch ~/.dejavu
echo
echo "--- isolation check: ~/.dejavu mtimes ---"
ls -l "$HOME/.dejavu" 2>/dev/null | tee "$EVIDENCE_DIR/home-dejavu-listing.txt" || true
# Soft check — we can't fully prove no other process wrote to ~/.dejavu, but
# we can prove the slip we wrote went to the experiment DB by checking it
# exists in $DEJAVU_DB.
assert "isolated DB file exists at \$DEJAVU_DB" "[ -s \"$DEJAVU_DB\" ]" \
  || FAILS=$((FAILS+1))

echo
echo "=== STEP 6: summary ==="
echo "fails=$FAILS"
echo "evidence-dir=$EVIDENCE_DIR"
if [ "$FAILS" -eq 0 ]; then
  echo "RESULT=PROVEN"
  exit 0
else
  echo "RESULT=PARTIAL_OR_DISPROVEN ($FAILS failed assertions)"
  exit 1
fi
