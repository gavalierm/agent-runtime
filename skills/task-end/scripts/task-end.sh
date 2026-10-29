#!/usr/bin/env bash
# Runs check.sh for the repo of the current folder and prints the end-of-task checklist
# from RULES.md of the brain with the result.
# check.sh is the one of the agent-runtime repo (brain/bin/check.sh above this skill) or,
# in a copy made by adopt.sh --standalone, the one in agentic-brain/bin/.
set -u

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

CHECK=""
for c in "$SELF_DIR/../../../brain/bin/check.sh" "$SELF_DIR/../../../bin/check.sh"; do
  [ -f "$c" ] && { CHECK=$(cd "$(dirname "$c")" && pwd)/check.sh; break; }
done
if [ -z "$CHECK" ]; then
  echo "task-end: check.sh was not found next to this skill" >&2
  exit 1
fi

TARGET=$(git rev-parse --show-toplevel 2>/dev/null) || TARGET=$PWD

if [ -f "$TARGET/agentic-brain/RULES.md" ] && [ -f "$TARGET/agentic-brain/errors/REGISTER.md" ]; then
  RULES="$TARGET/agentic-brain/RULES.md"
elif [ -f "$TARGET/RULES.md" ] && [ -f "$TARGET/errors/REGISTER.md" ]; then
  RULES="$TARGET/RULES.md"
else
  echo "task-end: $TARGET has no brain (agentic-brain/RULES.md with errors/REGISTER.md, or RULES.md with errors/REGISTER.md at the root)" >&2
  exit 1
fi

bash "$CHECK" "$TARGET"
RC=$?

echo
echo "End-of-task checklist:"
awk -v rc="$RC" '
  /^## / { in_sec = ($0 ~ /^## End of task[[:space:]]*$/); next }
  in_sec && /^[-*] / {
    item = substr($0, 3)
    if (item ~ /check\.sh/) {
      printf "  [%s] %s\n", (rc == 0 ? "OK" : "ERROR"), item
    } else {
      printf "  [ ] %s\n", item
    }
  }' "$RULES"
echo
if [ "$RC" -eq 0 ]; then
  echo "The check passed. Confirm the items marked [ ] yourself."
else
  echo "The check failed. Fix the errors above and run the script again."
fi
exit "$RC"
