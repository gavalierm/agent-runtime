#!/usr/bin/env bash
# Test of bin/adopt.sh: rollout into an existing repo without overwriting and without a commit.
set -u

HERE=$(cd "$(dirname "$0")" && pwd -P)
. "$HERE/template.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
SRC=$(build_template "$TMP/template")
export HOME="$TMP/home"; mkdir -p "$HOME"
export GIT_CONFIG_NOSYSTEM=1
unset AGENTIC_BRAIN_GLOBAL

FAILS=0
ok() { echo "ok   $1"; }
bad() { echo "FAIL $1"; FAILS=$((FAILS + 1)); }
check() { local d=$1; shift; if "$@"; then ok "$d"; else bad "$d"; fi; }
has() { printf '%s' "$1" | grep -q -- "$2"; }

GC="git -c user.name=t -c user.email=t@example.org"

# repo with existing content
T1="$TMP/r1"; mkdir -p "$T1/agentic-brain" "$T1/.claude"
git -C "$T1" init -q
printf '# My project\nRule A\n' > "$T1/CLAUDE.md"
printf 'node_modules\n' > "$T1/.gitignore"
printf 'own rules\n' > "$T1/agentic-brain/RULES.md"
printf '{"permissions":{}}\n' > "$T1/.claude/settings.json"
printf 'x\n' > "$T1/f.txt"
git -C "$T1" add -A; $GC -C "$T1" commit -qm start
BEFORE=$(git -C "$T1" rev-list --all --count)

OUT=$(bash "$SRC/agentic-brain/bin/adopt.sh" "$T1" 2>&1); RC=$?
check "adopt: exit code 0" test "$RC" -eq 0
check "adopt: original CLAUDE.md stayed at the start" test "$(head -n 2 "$T1/CLAUDE.md")" = "$(printf '# My project\nRule A')"
check "adopt: import line added once" test "$(grep -cxF '@agentic-brain/RULES.md' "$T1/CLAUDE.md")" -eq 1
check "adopt: AGENTS.md created as a copy of CLAUDE.md" cmp -s "$T1/CLAUDE.md" "$T1/AGENTS.md"
check "adopt: output reports the copy" has "$OUT" "Created AGENTS.md as a copy of CLAUDE.md"
check "adopt: existing RULES.md not overwritten" test "$(cat "$T1/agentic-brain/RULES.md")" = "own rules"
check "adopt: output reports the skipped RULES.md" has "$OUT" "Skipped, already exists: agentic-brain/RULES.md"
check "adopt: skill copied" test -f "$T1/agentic-brain/skills/error/scripts/error.sh"
check "adopt: skill symlink" test "$(readlink "$T1/.claude/skills/error")" = "../../agentic-brain/skills/error"
check "adopt: existing settings.json stayed" test "$(cat "$T1/.claude/settings.json")" = '{"permissions":{}}'
check "adopt: output says what to add to settings.json" has "$OUT" "repeat_guard.mjs"
check "adopt: .gitignore kept the original line" grep -qxF 'node_modules' "$T1/.gitignore"
check "adopt: .gitignore has the scratch line" grep -qxF 'agentic-brain/scratch/*' "$T1/.gitignore"
check "adopt: scratch/.gitkeep copied" test -f "$T1/agentic-brain/scratch/.gitkeep"
check "adopt: committed nothing" test "$(git -C "$T1" rev-list --all --count)" = "$BEFORE"
check "adopt: no warning about a difference, files are identical" test "$(printf '%s' "$OUT" | grep -c 'differ')" -eq 0
check "adopt: check.sh passes in the target" bash "$T1/agentic-brain/bin/check.sh"

A=$(cd "$T1" && find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 cat | cksum)
bash "$SRC/agentic-brain/bin/adopt.sh" "$T1" > /dev/null 2>&1
B=$(cd "$T1" && find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 cat | cksum)
check "adopt: second run changes nothing" test "$A" = "$B"

# empty repo without CLAUDE.md and settings.json, check.sh must pass afterwards
T2="$TMP/r2"; mkdir -p "$T2"; git -C "$T2" init -q
OUT=$(bash "$SRC/agentic-brain/bin/adopt.sh" "$T2" 2>&1); RC=$?
check "adopt (empty repo): exit code 0" test "$RC" -eq 0
check "adopt (empty repo): CLAUDE.md and AGENTS.md identical" cmp -s "$T2/CLAUDE.md" "$T2/AGENTS.md"
check "adopt (empty repo): settings.json same as in the template" cmp -s "$T2/.claude/settings.json" "$SRC/.claude/settings.json"
check "adopt (empty repo): check.sh passes" bash "$T2/agentic-brain/bin/check.sh"

# repo where CLAUDE.md and AGENTS.md already exist and differ
T4="$TMP/r4"; mkdir -p "$T4"; git -C "$T4" init -q
printf 'A\n' > "$T4/CLAUDE.md"; printf 'B\n' > "$T4/AGENTS.md"
OUT=$(bash "$SRC/agentic-brain/bin/adopt.sh" "$T4" 2>&1)
check "adopt (different files): output reports the difference" has "$OUT" "differ"
check "adopt (different files): import in both" test "$(grep -lxF '@agentic-brain/RULES.md' "$T4/CLAUDE.md" "$T4/AGENTS.md" | wc -l)" -eq 2

# without --project nothing about the project layer appears
check "adopt (no --project): no project line in RULES.md" test "$(head -n 5 "$T2/agentic-brain/RULES.md" | grep -c '^project:')" -eq 0
check "adopt (no --project): RULES.md has no frontmatter" test "$(head -n 1 "$T2/agentic-brain/RULES.md")" != "---"
check "adopt (no --project): only the template skills are linked" test "$(ls "$T2/.claude/skills" | tr '\n' ' ')" = "error task-end "

# --project: a project layer above the repo
PL="$TMP/pp/proj/agentic-brain"
mkdir -p "$PL/skills/pskill/scripts" "$TMP/pp/repo"
: > "$PL/RULES.md"
printf -- '---\nname: pskill\ndescription: Use when the project skill is needed.\n---\n' > "$PL/skills/pskill/SKILL.md"
printf '#!/usr/bin/env bash\ntrue\n' > "$PL/skills/pskill/scripts/a.sh"
T5="$TMP/pp/repo"; git -C "$T5" init -q
OUT=$(bash "$SRC/agentic-brain/bin/adopt.sh" --project ../proj/agentic-brain "$T5" 2>&1); RC=$?
check "adopt --project: exit code 0" test "$RC" -eq 0
check "adopt --project: frontmatter starts the RULES.md" test "$(head -n 3 "$T5/agentic-brain/RULES.md")" = "$(printf -- '---\nproject: ../proj/agentic-brain\n---')"
check "adopt --project: the rules text follows the frontmatter" test "$(sed -n '4p' "$T5/agentic-brain/RULES.md")" = "# Project rules"
check "adopt --project: output reports the line" has "$OUT" "Added line project: ../proj/agentic-brain"
check "adopt --project: symlink to the project skill" test "$(readlink "$T5/.claude/skills/pskill")" = "../../../proj/agentic-brain/skills/pskill"
check "adopt --project: the project symlink resolves" test -f "$T5/.claude/skills/pskill/SKILL.md"
check "adopt --project: template skill symlink stays" test "$(readlink "$T5/.claude/skills/error")" = "../../agentic-brain/skills/error"
check "adopt --project: check.sh passes in the target" bash "$T5/agentic-brain/bin/check.sh"

A=$(cd "$T5" && find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 cat | cksum)
OUT=$(bash "$SRC/agentic-brain/bin/adopt.sh" --project ../proj/agentic-brain "$T5" 2>&1); RC=$?
B=$(cd "$T5" && find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 cat | cksum)
check "adopt --project: second run changes nothing" test "$A" = "$B"
check "adopt --project: second run exit code 0" test "$RC" -eq 0
check "adopt --project: the line is written once" test "$(head -n 5 "$T5/agentic-brain/RULES.md" | grep -c '^project:')" -eq 1

mkdir -p "$TMP/pp/other/agentic-brain/skills/oskill/scripts"
printf 'x\n' > "$TMP/pp/other/agentic-brain/skills/oskill/scripts/a.sh"
OUT=$(bash "$SRC/agentic-brain/bin/adopt.sh" --project ../other/agentic-brain "$T5" 2>&1); RC=$?
check "adopt --project: a different value is reported" has "$OUT" "already has project: ../proj/agentic-brain"
check "adopt --project: a different value is not written" test "$(head -n 5 "$T5/agentic-brain/RULES.md" | grep -c '^project:')" -eq 1 -a "$(sed -n '2p' "$T5/agentic-brain/RULES.md")" = "project: ../proj/agentic-brain"
check "adopt --project: a different value creates no symlinks" test ! -e "$T5/.claude/skills/oskill"

# existing RULES.md with a frontmatter but without the project line, and an existing foreign skill entry
T6="$TMP/pp/repo6"; mkdir -p "$T6/agentic-brain" "$T6/.claude/skills/pskill"; git -C "$T6" init -q
printf -- '---\nupstream: https://example.org/x.git\n---\nown rules\n' > "$T6/agentic-brain/RULES.md"
OUT=$(bash "$SRC/agentic-brain/bin/adopt.sh" --project ../proj/agentic-brain "$T6" 2>&1); RC=$?
check "adopt --project (frontmatter): exit code 0" test "$RC" -eq 0
check "adopt --project (frontmatter): the line goes into the existing frontmatter" test "$(head -n 4 "$T6/agentic-brain/RULES.md")" = "$(printf -- '---\nproject: ../proj/agentic-brain\nupstream: https://example.org/x.git\n---')"
check "adopt --project (frontmatter): the body stays" grep -qxF 'own rules' "$T6/agentic-brain/RULES.md"
check "adopt --project (frontmatter): an existing entry is skipped" has "$OUT" "Skipped, already exists: .claude/skills/pskill"
check "adopt --project (frontmatter): the existing entry stays a folder" test -d "$T6/.claude/skills/pskill" -a ! -L "$T6/.claude/skills/pskill"

# the project layer holds the same skills as the template (a layer made from the template)
T8="$TMP/pp8/repo"; mkdir -p "$T8" "$TMP/pp8/proj"; git -C "$T8" init -q
cp -a "$PL/." "$TMP/pp8/proj/agentic-brain/" 2>/dev/null || { mkdir -p "$TMP/pp8/proj/agentic-brain"; cp -a "$PL/." "$TMP/pp8/proj/agentic-brain/"; }
cp -a "$SRC/agentic-brain/skills/error" "$TMP/pp8/proj/agentic-brain/skills/error"
OUT=$(bash "$SRC/agentic-brain/bin/adopt.sh" --project ../proj/agentic-brain "$T8" 2>&1); RC=$?
check "adopt --project (shared skill): exit code 0" test "$RC" -eq 0
check "adopt --project (shared skill): the skip is reported" has "$OUT" "Skipped, the repo layer has skill error"
check "adopt --project (shared skill): the link points to the repo layer" test "$(readlink "$T8/.claude/skills/error")" = "../../agentic-brain/skills/error"
check "adopt --project (shared skill): the project only skill is linked" test "$(readlink "$T8/.claude/skills/pskill")" = "../../../proj/agentic-brain/skills/pskill"
check "adopt --project (shared skill): check.sh passes in the target" bash "$T8/agentic-brain/bin/check.sh"
OUT=$(bash "$SRC/agentic-brain/bin/adopt.sh" --project ../proj/agentic-brain "$T8" 2>&1); RC=$?
check "adopt --project (shared skill): second run exit code 0" test "$RC" -eq 0
check "adopt --project (shared skill): second run keeps the repo link" test "$(readlink "$T8/.claude/skills/error")" = "../../agentic-brain/skills/error"

# a missing project layer is an error and changes nothing
T7="$TMP/pp/repo7"; mkdir -p "$T7"; git -C "$T7" init -q
OUT=$(bash "$SRC/agentic-brain/bin/adopt.sh" --project ../nope/agentic-brain "$T7" 2>&1); RC=$?
check "adopt --project (missing path): exit code 1" test "$RC" -eq 1
check "adopt --project (missing path): message" has "$OUT" "project layer ../nope/agentic-brain is missing"
check "adopt --project (missing path): nothing was copied" test ! -e "$T7/agentic-brain"
bash "$SRC/agentic-brain/bin/adopt.sh" --project /abs/path "$T7" > /dev/null 2>&1; RC=$?
check "adopt --project (absolute path): exit code 1" test "$RC" -eq 1
bash "$SRC/agentic-brain/bin/adopt.sh" --project > /dev/null 2>&1; RC=$?
check "adopt --project (no value): usage error 2" test "$RC" -eq 2

# target that is not a git repo
T3="$TMP/r3"; mkdir -p "$T3"
bash "$SRC/agentic-brain/bin/adopt.sh" "$T3" > /dev/null 2>&1; RC=$?
check "adopt: folder without git is an error" test "$RC" -eq 1

echo
if [ "$FAILS" -gt 0 ]; then echo "adopt.test.sh: $FAILS failures"; exit 1; fi
echo "adopt.test.sh: all passed"
