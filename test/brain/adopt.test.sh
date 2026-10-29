#!/usr/bin/env bash
# Test of bin/adopt.sh: rollout into an existing repo without overwriting and without a commit.
set -u

HERE=$(cd "$(dirname "$0")" && pwd -P)
. "$HERE/template.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
SRC=$(build_template "$TMP/template")
ADOPT="$REPO/brain/bin/adopt.sh"
CHECK="$REPO/brain/bin/check.sh"
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

OUT=$(bash "$ADOPT" "$T1" 2>&1); RC=$?
check "adopt: exit code 0" test "$RC" -eq 0
check "adopt: original CLAUDE.md stayed at the start" test "$(head -n 2 "$T1/CLAUDE.md")" = "$(printf '# My project\nRule A')"
check "adopt: import line added once" test "$(grep -cxF '@agentic-brain/RULES.md' "$T1/CLAUDE.md")" -eq 1
check "adopt: AGENTS.md created as a copy of CLAUDE.md" cmp -s "$T1/CLAUDE.md" "$T1/AGENTS.md"
check "adopt: output reports the copy" has "$OUT" "Created AGENTS.md as a copy of CLAUDE.md"
check "adopt: existing RULES.md not overwritten" test "$(cat "$T1/agentic-brain/RULES.md")" = "own rules"
check "adopt: output reports the skipped RULES.md" has "$OUT" "Skipped, already exists: agentic-brain/RULES.md"
check "adopt: bin/ is not copied" test ! -e "$T1/agentic-brain/bin"
check "adopt: the skills of the template are not copied" test ! -e "$T1/agentic-brain/skills/error"
check "adopt: skills/ is created" test -d "$T1/agentic-brain/skills"
check "adopt: the data files are created" test -f "$T1/agentic-brain/errors/REGISTER.md" -a -f "$T1/agentic-brain/decisions/README.md" -a -f "$T1/agentic-brain/memory/MEMORY.md" -a -f "$T1/agentic-brain/artifacts/README.md"
check "adopt: no skill symlinks" test ! -e "$T1/.claude/skills"
check "adopt: existing settings.json stayed" test "$(cat "$T1/.claude/settings.json")" = '{"permissions":{}}'
check "adopt: output names check.sh of this repo" has "$OUT" "$CHECK $T1"
check "adopt: .gitignore kept the original line" grep -qxF 'node_modules' "$T1/.gitignore"
check "adopt: .gitignore has the scratch line" grep -qxF 'agentic-brain/scratch/*' "$T1/.gitignore"
check "adopt: scratch/.gitkeep copied" test -f "$T1/agentic-brain/scratch/.gitkeep"
check "adopt: committed nothing" test "$(git -C "$T1" rev-list --all --count)" = "$BEFORE"
check "adopt: no warning about a difference, files are identical" test "$(printf '%s' "$OUT" | grep -c 'differ')" -eq 0
check "adopt: check.sh passes in the target" bash "$CHECK" "$T1"

A=$(cd "$T1" && find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 cat | cksum)
bash "$ADOPT" "$T1" > /dev/null 2>&1
B=$(cd "$T1" && find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 cat | cksum)
check "adopt: second run changes nothing" test "$A" = "$B"

# empty repo without CLAUDE.md and settings.json, check.sh must pass afterwards
T2="$TMP/r2"; mkdir -p "$T2"; git -C "$T2" init -q
OUT=$(bash "$ADOPT" "$T2" 2>&1); RC=$?
check "adopt (empty repo): exit code 0" test "$RC" -eq 0
check "adopt (empty repo): CLAUDE.md and AGENTS.md identical" cmp -s "$T2/CLAUDE.md" "$T2/AGENTS.md"
check "adopt (empty repo): no settings.json without --standalone" test ! -e "$T2/.claude/settings.json"
check "adopt (empty repo): check.sh passes" bash "$CHECK" "$T2"

# repo where CLAUDE.md and AGENTS.md already exist and differ
T4="$TMP/r4"; mkdir -p "$T4"; git -C "$T4" init -q
printf 'A\n' > "$T4/CLAUDE.md"; printf 'B\n' > "$T4/AGENTS.md"
OUT=$(bash "$ADOPT" "$T4" 2>&1)
check "adopt (different files): output reports the difference" has "$OUT" "differ"
check "adopt (different files): import in both" test "$(grep -lxF '@agentic-brain/RULES.md' "$T4/CLAUDE.md" "$T4/AGENTS.md" | wc -l)" -eq 2

# without --project nothing about the project layer appears
check "adopt (no --project): no project line in RULES.md" test "$(head -n 5 "$T2/agentic-brain/RULES.md" | grep -c '^project:')" -eq 0
check "adopt (no --project): RULES.md has no frontmatter" test "$(head -n 1 "$T2/agentic-brain/RULES.md")" != "---"
check "adopt (no --project): no skills are linked" test ! -e "$T2/.claude/skills"

# --project: a project layer above the repo
PL="$TMP/pp/proj/agentic-brain"
mkdir -p "$PL/skills/pskill/scripts" "$TMP/pp/repo"
: > "$PL/RULES.md"
printf -- '---\nname: pskill\ndescription: Use when the project skill is needed.\n---\n' > "$PL/skills/pskill/SKILL.md"
printf '#!/usr/bin/env bash\ntrue\n' > "$PL/skills/pskill/scripts/a.sh"
T5="$TMP/pp/repo"; git -C "$T5" init -q
OUT=$(bash "$ADOPT" --project ../proj/agentic-brain "$T5" 2>&1); RC=$?
check "adopt --project: exit code 0" test "$RC" -eq 0
check "adopt --project: frontmatter starts the RULES.md" test "$(head -n 3 "$T5/agentic-brain/RULES.md")" = "$(printf -- '---\nproject: ../proj/agentic-brain\n---')"
check "adopt --project: the rules text follows the frontmatter" test "$(sed -n '4p' "$T5/agentic-brain/RULES.md")" = "# Project rules"
check "adopt --project: output reports the line" has "$OUT" "Added line project: ../proj/agentic-brain"
check "adopt --project: symlink to the project skill" test "$(readlink "$T5/.claude/skills/pskill")" = "../../../proj/agentic-brain/skills/pskill"
check "adopt --project: the project symlink resolves" test -f "$T5/.claude/skills/pskill/SKILL.md"
check "adopt --project: check.sh passes in the target" bash "$CHECK" "$T5"

A=$(cd "$T5" && find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 cat | cksum)
OUT=$(bash "$ADOPT" --project ../proj/agentic-brain "$T5" 2>&1); RC=$?
B=$(cd "$T5" && find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 cat | cksum)
check "adopt --project: second run changes nothing" test "$A" = "$B"
check "adopt --project: second run exit code 0" test "$RC" -eq 0
check "adopt --project: the line is written once" test "$(head -n 5 "$T5/agentic-brain/RULES.md" | grep -c '^project:')" -eq 1

mkdir -p "$TMP/pp/other/agentic-brain/skills/oskill/scripts"
printf 'x\n' > "$TMP/pp/other/agentic-brain/skills/oskill/scripts/a.sh"
OUT=$(bash "$ADOPT" --project ../other/agentic-brain "$T5" 2>&1); RC=$?
check "adopt --project: a different value is reported" has "$OUT" "already has project: ../proj/agentic-brain"
check "adopt --project: a different value is not written" test "$(head -n 5 "$T5/agentic-brain/RULES.md" | grep -c '^project:')" -eq 1 -a "$(sed -n '2p' "$T5/agentic-brain/RULES.md")" = "project: ../proj/agentic-brain"
check "adopt --project: a different value creates no symlinks" test ! -e "$T5/.claude/skills/oskill"

# existing RULES.md with a frontmatter but without the project line, and an existing foreign skill entry
T6="$TMP/pp/repo6"; mkdir -p "$T6/agentic-brain" "$T6/.claude/skills/pskill"; git -C "$T6" init -q
printf -- '---\nupstream: https://example.org/x.git\n---\nown rules\n' > "$T6/agentic-brain/RULES.md"
OUT=$(bash "$ADOPT" --project ../proj/agentic-brain "$T6" 2>&1); RC=$?
check "adopt --project (frontmatter): exit code 0" test "$RC" -eq 0
check "adopt --project (frontmatter): the line goes into the existing frontmatter" test "$(head -n 4 "$T6/agentic-brain/RULES.md")" = "$(printf -- '---\nproject: ../proj/agentic-brain\nupstream: https://example.org/x.git\n---')"
check "adopt --project (frontmatter): the body stays" grep -qxF 'own rules' "$T6/agentic-brain/RULES.md"
check "adopt --project (frontmatter): an existing entry is skipped" has "$OUT" "Skipped, already exists: .claude/skills/pskill"
check "adopt --project (frontmatter): the existing entry stays a folder" test -d "$T6/.claude/skills/pskill" -a ! -L "$T6/.claude/skills/pskill"

# the project layer holds the same skills as the template (a layer made from the template)
T8="$TMP/pp8/repo"; mkdir -p "$T8" "$TMP/pp8/proj"; git -C "$T8" init -q
cp -a "$PL/." "$TMP/pp8/proj/agentic-brain/" 2>/dev/null || { mkdir -p "$TMP/pp8/proj/agentic-brain"; cp -a "$PL/." "$TMP/pp8/proj/agentic-brain/"; }
cp -a "$SRC/agentic-brain/skills/error" "$TMP/pp8/proj/agentic-brain/skills/error"
OUT=$(bash "$ADOPT" --standalone --project ../proj/agentic-brain "$T8" 2>&1); RC=$?
check "adopt --project (shared skill): exit code 0" test "$RC" -eq 0
check "adopt --project (shared skill): the skip is reported" has "$OUT" "Skipped, the repo layer has skill error"
check "adopt --project (shared skill): the link points to the repo layer" test "$(readlink "$T8/.claude/skills/error")" = "../../agentic-brain/skills/error"
check "adopt --project (shared skill): the project only skill is linked" test "$(readlink "$T8/.claude/skills/pskill")" = "../../../proj/agentic-brain/skills/pskill"
check "adopt --project (shared skill): check.sh passes in the target" bash "$CHECK" "$T8"
OUT=$(bash "$ADOPT" --standalone --project ../proj/agentic-brain "$T8" 2>&1); RC=$?
check "adopt --project (shared skill): second run exit code 0" test "$RC" -eq 0
check "adopt --project (shared skill): second run keeps the repo link" test "$(readlink "$T8/.claude/skills/error")" = "../../agentic-brain/skills/error"

# a missing project layer is an error and changes nothing
T7="$TMP/pp/repo7"; mkdir -p "$T7"; git -C "$T7" init -q
OUT=$(bash "$ADOPT" --project ../nope/agentic-brain "$T7" 2>&1); RC=$?
check "adopt --project (missing path): exit code 1" test "$RC" -eq 1
check "adopt --project (missing path): message" has "$OUT" "project layer ../nope/agentic-brain is missing"
check "adopt --project (missing path): nothing was copied" test ! -e "$T7/agentic-brain"
bash "$ADOPT" --project /abs/path "$T7" > /dev/null 2>&1; RC=$?
check "adopt --project (absolute path): exit code 1" test "$RC" -eq 1
bash "$ADOPT" --project > /dev/null 2>&1; RC=$?
check "adopt --project (no value): usage error 2" test "$RC" -eq 2

# target that is not a git repo
T3="$TMP/r3"; mkdir -p "$T3"
bash "$ADOPT" "$T3" > /dev/null 2>&1; RC=$?
check "adopt: folder without git is an error" test "$RC" -eq 1

# --standalone: a copy of bin/ and of the skills error and task-end, settings.json with the hook
S1="$TMP/s1"; mkdir -p "$S1"; git -C "$S1" init -q
OUT=$(bash "$ADOPT" --standalone "$S1" 2>&1); RC=$?
check "adopt --standalone: exit code 0" test "$RC" -eq 0
check "adopt --standalone: bin/check.sh copied" test -x "$S1/agentic-brain/bin/check.sh"
check "adopt --standalone: the whole bin/ copied" test -f "$S1/agentic-brain/bin/repeat_guard.mjs" -a -f "$S1/agentic-brain/bin/pre-commit" -a -f "$S1/agentic-brain/bin/adopt.sh"
check "adopt --standalone: skill error copied with its script" test -f "$S1/agentic-brain/skills/error/scripts/error.sh" -a -f "$S1/agentic-brain/skills/error/SKILL.md"
check "adopt --standalone: skill task-end copied" test -f "$S1/agentic-brain/skills/task-end/scripts/task-end.sh"
check "adopt --standalone: the copy is the skill of this repo" cmp -s "$S1/agentic-brain/skills/error/SKILL.md" "$REPO/skills/error/SKILL.md"
check "adopt --standalone: skill symlinks" test "$(ls "$S1/.claude/skills" | tr '\n' ' ')" = "error task-end "
check "adopt --standalone: settings.json with repeat_guard" grep -q 'agentic-brain/bin/repeat_guard.mjs' "$S1/.claude/settings.json"
check "adopt --standalone: settings.json is the template one" cmp -s "$S1/.claude/settings.json" "$SRC/.claude/settings.json"
check "adopt --standalone: output names the copied check.sh" has "$OUT" "agentic-brain/bin/check.sh --install-hook"
check "adopt --standalone: the copied check.sh passes" bash "$S1/agentic-brain/bin/check.sh"
check "adopt --standalone: the check of this repo passes too" bash "$CHECK" "$S1"
check "adopt --standalone: task-end runs from the copy" bash -c 'cd "$1" && bash agentic-brain/skills/task-end/scripts/task-end.sh >/dev/null' _ "$S1"
A=$(cd "$S1" && find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 cat | cksum)
bash "$ADOPT" --standalone "$S1" > /dev/null 2>&1
B=$(cd "$S1" && find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 cat | cksum)
check "adopt --standalone: second run changes nothing" test "$A" = "$B"

# --root: the whole repo is the brain
R1="$TMP/root1"; mkdir -p "$R1"; git -C "$R1" init -q
OUT=$(bash "$ADOPT" --root "$R1" 2>&1); RC=$?
check "adopt --root: exit code 0" test "$RC" -eq 0
check "adopt --root: the folders are at the root" test -f "$R1/RULES.md" -a -f "$R1/errors/REGISTER.md" -a -f "$R1/decisions/README.md" -a -f "$R1/memory/MEMORY.md" -a -f "$R1/artifacts/README.md" -a -f "$R1/scratch/.gitkeep" -a -d "$R1/skills"
check "adopt --root: no agentic-brain/ folder" test ! -e "$R1/agentic-brain"
check "adopt --root: CLAUDE.md is the single line @RULES.md" test "$(cat "$R1/CLAUDE.md")" = "@RULES.md"
check "adopt --root: no AGENTS.md, no .claude/" test ! -e "$R1/AGENTS.md" -a ! -e "$R1/.claude"
check "adopt --root: .gitignore has the scratch lines" grep -qxF 'scratch/*' "$R1/.gitignore"
check "adopt --root: .gitignore keeps the scratch marker" grep -qxF '!scratch/.gitkeep' "$R1/.gitignore"
check "adopt --root: check.sh passes in the target" bash "$CHECK" "$R1"
A=$(cd "$R1" && find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 cat | cksum)
bash "$ADOPT" --root "$R1" > /dev/null 2>&1
B=$(cd "$R1" && find . -path ./.git -prune -o -type f -print0 | sort -z | xargs -0 cat | cksum)
check "adopt --root: second run changes nothing" test "$A" = "$B"
R2="$TMP/root2"; mkdir -p "$R2"; git -C "$R2" init -q
bash "$ADOPT" --root --standalone "$R2" > /dev/null 2>&1
check "adopt --root --standalone: bin/ and skills at the root" test -x "$R2/bin/check.sh" -a -f "$R2/skills/error/scripts/error.sh"
check "adopt --root --standalone: the copied check.sh passes" bash "$R2/bin/check.sh"
check "adopt --root --standalone: settings.json points to bin/" grep -q '/bin/repeat_guard.mjs' "$R2/.claude/settings.json"
bash "$ADOPT" --bogus "$R2" > /dev/null 2>&1; RC=$?
check "adopt: an unknown option is a usage error" test "$RC" -eq 2

echo
if [ "$FAILS" -gt 0 ]; then echo "adopt.test.sh: $FAILS failures"; exit 1; fi
echo "adopt.test.sh: all passed"
