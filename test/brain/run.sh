#!/usr/bin/env bash
# Runs all tests of the template. Exits with code 1 at the first failure.
set -u
HERE=$(cd "$(dirname "$0")" && pwd -P)

for t in check.test.sh install.test.sh adopt.test.sh; do
  echo "== $t"
  bash "$HERE/$t" || { echo "FAILED: $t" >&2; exit 1; }
done

echo "== repeat_guard.test.mjs"
node --test "$HERE/repeat_guard.test.mjs" || { echo "FAILED: repeat_guard.test.mjs" >&2; exit 1; }

echo
echo "All tests passed."
