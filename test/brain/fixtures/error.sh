#!/usr/bin/env bash
# Adds a row to errors/REGISTER.md and prints which occurrence of the class it is.
# Usage: error.sh "<class>" "<description>"
set -u

if [ "$#" -ne 2 ] || [ -z "${1// /}" ] || [ -z "${2// /}" ]; then
  echo "Usage: error.sh \"<class>\" \"<description>\"" >&2
  exit 2
fi

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BRAIN=$(cd "$SELF_DIR/../../.." && pwd)
REG="$BRAIN/errors/REGISTER.md"

clean() { printf '%s' "$1" | tr '\r\n\t' '   ' | tr '|' '/' | sed 's/^ *//; s/ *$//'; }
CLASS=$(clean "$1")
DESC=$(clean "$2")

if [ ! -f "$REG" ]; then
  echo "Register $REG is missing" >&2
  exit 1
fi

# the file must end with a newline
if [ -s "$REG" ] && [ -n "$(tail -c1 "$REG")" ]; then
  printf '\n' >> "$REG"
fi
printf '| %s | %s | %s |  |  |\n' "$(date +%F)" "$CLASS" "$DESC" >> "$REG"

awk -F'|' -v t="$CLASS" '
  function trim(s) { gsub(/^[ \t\r]+|[ \t\r]+$/, "", s); return s }
  /^\|/ {
    if (trim($2) !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/) next
    if (tolower(trim($3)) != tolower(t)) next
    all++
    if (trim($5) == "") open++
  }
  END {
    printf "Occurrences of class \"%s\": %d\n", t, all
    printf "Of those without a fix: %d\n", open
    if (open >= 2) print "Two occurrences without a fix fail in bin/check.sh. Fix the cause and fill in the fix and test columns."
  }' "$REG"
