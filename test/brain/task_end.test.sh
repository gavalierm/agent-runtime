#!/usr/bin/env bash
# Test of skills/task-end/scripts/task-end.sh: it checks the repo of the current folder
# with check.sh of this repo and exits 1 when the repo has no brain.
set -u

HERE=$(cd "$(dirname "$0")" && pwd -P)
. "$HERE/template.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export HOME="$TMP/home"; mkdir -p "$HOME"
export GIT_CONFIG_NOSYSTEM=1
unset AGENTIC_BRAIN_GLOBAL

FAILS=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; FAILS=$((FAILS + 1)); }
check() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
has() { printf '%s' "$1" | grep -q -- "$2"; }

TASK_END="$REPO/skills/task-end/scripts/task-end.sh"

R1="$TMP/r1"; mkdir -p "$R1"; git -C "$R1" init -q
bash "$REPO/brain/bin/adopt.sh" "$R1" > /dev/null 2>&1
mkdir -p "$R1/sub"
OUT=$(cd "$R1/sub" && bash "$TASK_END" 2>&1); RC=$?
check "task-end: a repo with a brain passes from a subfolder" test "$RC" -eq 0
check "task-end: the check item is marked OK" has "$OUT" "\[OK\]"
check "task-end: the other items stay open" has "$OUT" "\[ \] .*scratch"

touch "$R1/agentic-brain/scratch/junk"
OUT=$(cd "$R1" && bash "$TASK_END" 2>&1); RC=$?
check "task-end: an error of the check gives exit code 1" test "$RC" -eq 1
check "task-end: the check item is marked ERROR" has "$OUT" "\[ERROR\]"
rm "$R1/agentic-brain/scratch/junk"

R2="$TMP/r2"; mkdir -p "$R2"; git -C "$R2" init -q
OUT=$(cd "$R2" && bash "$TASK_END" 2>&1); RC=$?
check "task-end: a repo without a brain gives exit code 1" test "$RC" -eq 1
check "task-end: the message says there is no brain" has "$OUT" "has no brain"

R3="$TMP/r3"; mkdir -p "$R3"; git -C "$R3" init -q
bash "$REPO/brain/bin/adopt.sh" --root "$R3" > /dev/null 2>&1
OUT=$(cd "$R3" && bash "$TASK_END" 2>&1); RC=$?
check "task-end: a brain at the root of the repo passes" test "$RC" -eq 0

R4="$TMP/r4"; mkdir -p "$R4"; git -C "$R4" init -q
bash "$REPO/brain/bin/adopt.sh" --standalone "$R4" > /dev/null 2>&1
OUT=$(cd "$R4" && bash agentic-brain/skills/task-end/scripts/task-end.sh 2>&1); RC=$?
check "task-end: the standalone copy uses its own check.sh" test "$RC" -eq 0

echo
if [ "$FAILS" -gt 0 ]; then echo "task_end.test.sh: $FAILS failures"; exit 1; fi
echo "task_end.test.sh: all passed"
