#!/usr/bin/env bash
# Test of bin/decide.sh: the next number, the slug, and the optional target folder
# (a repo whose root is the brain, or a code repo with agentic-brain/). Temporary folders only.
set -u

HERE=$(cd "$(dirname "$0")" && pwd -P)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
DECIDE="$HERE/../../brain/bin/decide.sh"
FAILS=0
fail() { echo "FAIL: $*" >&2; FAILS=$((FAILS + 1)); }

# 1. standalone copy: the decision goes next to the script
mkdir -p "$TMP/copy/bin" "$TMP/copy/decisions"
cp "$DECIDE" "$TMP/copy/bin/decide.sh"
touch "$TMP/copy/decisions/D0002-old.md"
out=$(bash "$TMP/copy/bin/decide.sh" "Zadanie webu") || fail "standalone run rc $?"
[ -f "$TMP/copy/decisions/D0003-zadanie-webu.md" ] || fail "standalone: D0003-zadanie-webu.md missing ($out)"

# 2. target folder: a repo whose root is the brain
mkdir -p "$TMP/repo/decisions"
out=$(bash "$DECIDE" "$TMP/repo" "Prvé rozhodnutie") || fail "root target rc $?"
[ -f "$TMP/repo/decisions/D0001-prve-rozhodnutie.md" ] || fail "root target: D0001-prve-rozhodnutie.md missing ($out)"
grep -q '^id: D0001$' "$TMP/repo/decisions/D0001-prve-rozhodnutie.md" || fail "root target: header id"
[ ! -e "$HERE/../../brain/decisions/D0001-prve-rozhodnutie.md" ] || fail "root target: wrote into the template"

# 3. target folder: a code repo with agentic-brain/
mkdir -p "$TMP/code/agentic-brain/decisions"
bash "$DECIDE" "$TMP/code" "Druhé" >/dev/null || fail "code target rc $?"
[ -f "$TMP/code/agentic-brain/decisions/D0001-druhe.md" ] || fail "code target: file missing"

# 4. wrong use
bash "$DECIDE" >/dev/null 2>&1; [ $? -eq 2 ] || fail "no args should exit 2"
bash "$DECIDE" "$TMP/none" "X" >/dev/null 2>&1; [ $? -eq 2 ] || fail "missing folder should exit 2"

[ "$FAILS" -eq 0 ] && echo "decide.test.sh: ok" || exit 1
