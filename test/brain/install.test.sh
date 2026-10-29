#!/usr/bin/env bash
# Test of bin/install.sh: --global and idempotence, project installation.
# Everything runs with HOME in a temporary folder, the real ~/.claude stays unchanged.
set -u

HERE=$(cd "$(dirname "$0")" && pwd -P)
. "$HERE/template.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
SRC=$(build_template "$TMP/template")
export GIT_CONFIG_NOSYSTEM=1
unset AGENTIC_BRAIN_GLOBAL

FAILS=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; FAILS=$((FAILS + 1)); }
check() { # description command...
  local d=$1; shift
  if "$@"; then ok "$d"; else bad "$d"; fi
}
snapshot() { # tree under $1: paths, symlink targets, content
  (cd "$1" && find . -print0 | sort -z | xargs -0 ls -ld | awk '{ $6 = $7 = $8 = ""; print }' && find . -type f -print0 | sort -z | xargs -0 cat | cksum)
}

# 1. global, nested brain (a clone of the template in ~/agentic-brain)
H1="$TMP/h1"; mkdir -p "$H1/.claude"
cp -a "$SRC" "$H1/agentic-brain"; rm -rf "$H1/agentic-brain/.git"
printf 'my rule' > "$H1/.claude/CLAUDE.md"
mkdir -p "$H1/.claude/skills/error"; printf 'foreign\n' > "$H1/.claude/skills/error/SKILL.md"
ln -s /tmp/somewhere "$H1/.claude/skills/task-end"
OUT=$(HOME="$H1" bash "$H1/agentic-brain/agentic-brain/bin/install.sh" --global 2>&1); RC=$?
check "global: exits with code 0" test "$RC" -eq 0
check "global: original CLAUDE.md content stayed" grep -qx 'my rule' "$H1/.claude/CLAUDE.md"
check "global: import added once" test "$(grep -cxF '@~/agentic-brain/agentic-brain/RULES.md' "$H1/.claude/CLAUDE.md")" -eq 1
check "global: foreign folder stayed" test "$(cat "$H1/.claude/skills/error/SKILL.md")" = foreign
check "global: foreign symlink stayed" test "$(readlink "$H1/.claude/skills/task-end")" = /tmp/somewhere
check "global: output reports the skip" bash -c 'printf "%s" "$1" | grep -q "Skipped"' _ "$OUT"

# 2. global, clean HOME and idempotence
H2="$TMP/h2"; mkdir -p "$H2"
cp -a "$SRC" "$H2/agentic-brain"; rm -rf "$H2/agentic-brain/.git"
HOME="$H2" bash "$H2/agentic-brain/agentic-brain/bin/install.sh" --global > "$TMP/g1.out" 2>&1
check "global: error symlink points into the clone" test "$(readlink "$H2/.claude/skills/error")" = "$H2/agentic-brain/agentic-brain/skills/error"
check "global: task-end symlink exists" test -L "$H2/.claude/skills/task-end"
check "global: skill is reachable through the symlink" test -f "$H2/.claude/skills/error/SKILL.md"
A=$(snapshot "$H2")
HOME="$H2" bash "$H2/agentic-brain/agentic-brain/bin/install.sh" --global > "$TMP/g2.out" 2>&1
B=$(snapshot "$H2")
check "global: second run changes nothing" test "$A" = "$B"
check "global: import is in CLAUDE.md once" test "$(grep -c RULES.md "$H2/.claude/CLAUDE.md")" -eq 1

# 3. global, flat brain (the repo root is the brain), path exactly as designed
H3="$TMP/h3"; mkdir -p "$H3/agentic-brain"
cp -a "$SRC/agentic-brain/." "$H3/agentic-brain/"
HOME="$H3" bash "$H3/agentic-brain/bin/install.sh" --global > "$TMP/f1.out" 2>&1
check "flat global: import @~/agentic-brain/RULES.md" grep -qxF '@~/agentic-brain/RULES.md' "$H3/.claude/CLAUDE.md"
check "flat global: skill symlink" test "$(readlink "$H3/.claude/skills/error")" = "$H3/agentic-brain/skills/error"

# 4. project installation with a target (the install.sh of this repo, no copy in the target)
P="$TMP/project"; mkdir -p "$P"
cp -a "$SRC/." "$P/"; rm -rf "$P/.git"; git -C "$P" init -q
rm "$P/.claude/skills/error"
HOME="$TMP/h4" bash "$REPO/brain/bin/install.sh" "$P" > "$TMP/p1.out" 2>&1; RC=$?
check "project: exits with code 0" test "$RC" -eq 0
check "project: symlink restored" test "$(readlink "$P/.claude/skills/error")" = "../../agentic-brain/skills/error"
check "project: hook installed" test -x "$P/.git/hooks/pre-commit"
HOME="$TMP/h4" bash "$REPO/brain/bin/install.sh" "$P" > "$TMP/p2.out" 2>&1; RC=$?
check "project: second run passes" test "$RC" -eq 0

# 5. project installation without a target: the repo of the current folder
rm "$P/.claude/skills/task-end"
(cd "$P/agentic-brain/memory" && HOME="$TMP/h4" bash "$REPO/brain/bin/install.sh" > "$TMP/p3.out" 2>&1); RC=$?
check "project (no target): exits with code 0" test "$RC" -eq 0
check "project (no target): symlink restored in the repo of the current folder" test -L "$P/.claude/skills/task-end"

# 6. usage errors
bash "$REPO/brain/bin/install.sh" --bogus > /dev/null 2>&1; RC=$?
check "usage: an unknown option" test "$RC" -eq 2
bash "$REPO/brain/bin/install.sh" "$P" "$P" > /dev/null 2>&1; RC=$?
check "usage: two targets" test "$RC" -eq 2

echo
if [ "$FAILS" -gt 0 ]; then echo "install.test.sh: $FAILS failures"; exit 1; fi
echo "install.test.sh: all passed"
