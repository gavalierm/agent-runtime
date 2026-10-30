#!/usr/bin/env bash
# Creates the next decision file decisions/D0001-<slug>.md.
# Usage: decide.sh [<brain folder>] "<title>"
# Without a folder the decision goes to the brain this script lies in (a standalone
# copy made by adopt.sh --standalone). With a folder (the root of a repo whose
# content is the brain, or a code repo with agentic-brain/) the file goes to
# its decisions/, so one copy of this script serves every repo.
set -u

usage() { echo "Usage: decide.sh [<brain folder>] \"<title>\"" >&2; exit 2; }

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
if [ "$#" -eq 2 ]; then
  [ -d "$1" ] || { echo "decide.sh: $1 is not a folder" >&2; exit 2; }
  BRAIN=$(cd "$1" && pwd)
  if [ -d "$BRAIN/agentic-brain" ] && [ ! -d "$BRAIN/decisions" ]; then BRAIN="$BRAIN/agentic-brain"; fi
  shift
elif [ "$#" -eq 1 ]; then
  BRAIN=$(cd "$SELF_DIR/.." && pwd)
else
  usage
fi
[ -n "${1// /}" ] || usage
DIR="$BRAIN/decisions"
mkdir -p "$DIR"

NAME=$(printf '%s' "$1" | tr '\r\n\t' '   ' | sed 's/^ *//; s/ *$//')

# slug: transliterate accents to ASCII (when iconv is available), lowercase, dashes
SLUG=$(printf '%s' "$NAME" \
  | { LC_ALL=C.UTF-8 iconv -c -f UTF-8 -t ASCII//TRANSLIT 2>/dev/null || cat; } \
  | tr 'A-Z' 'a-z' \
  | sed 's/[^a-z0-9]\{1,\}/-/g; s/^-//; s/-$//' \
  | cut -c1-50 | sed 's/-$//')
[ -n "$SLUG" ] || SLUG=decision

LAST=$(find "$DIR" -maxdepth 1 -name 'D[0-9][0-9][0-9][0-9]-*.md' -exec basename {} \; \
  | sed 's/^D\([0-9]\{4\}\)-.*/\1/' | sort -n | tail -n 1)
NEXT=$(printf '%04d' $((10#${LAST:-0} + 1)))
FILE="$DIR/D$NEXT-$SLUG.md"

cat > "$FILE" <<EOT
---
id: D$NEXT
date: $(date +%F)
status: proposed
decided-by:
---

# $NAME

## Decision

## Reason
EOT
echo "Created: $FILE"
