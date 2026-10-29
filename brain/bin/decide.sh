#!/usr/bin/env bash
# Creates the next decision file decisions/D0001-<slug>.md.
# Usage: decide.sh "<title>"
set -u

if [ "$#" -ne 1 ] || [ -z "${1// /}" ]; then
  echo "Usage: decide.sh \"<title>\"" >&2
  exit 2
fi

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BRAIN=$(cd "$SELF_DIR/.." && pwd)
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
