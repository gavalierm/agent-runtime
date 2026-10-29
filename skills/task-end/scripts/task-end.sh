#!/usr/bin/env bash
# Runs bin/check.sh and prints the end-of-task checklist from RULES.md with the result.
set -u

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BRAIN=$(cd "$SELF_DIR/../../.." && pwd)
RULES="$BRAIN/RULES.md"

bash "$BRAIN/bin/check.sh"
RC=$?

echo
echo "End-of-task checklist:"
if [ ! -f "$RULES" ]; then
  echo "  $RULES is missing" >&2
  exit 1
fi
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
