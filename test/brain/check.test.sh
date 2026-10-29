#!/usr/bin/env bash
# Test of bin/check.sh: the template passes, every broken rule fails with the right message.
# It runs in a temporary folder with its own HOME and never touches the real HOME.
set -u

HERE=$(cd "$(dirname "$0")" && pwd -P)
. "$HERE/template.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
SRC=$(build_template "$TMP/template")
export HOME="$TMP/home"
mkdir -p "$HOME"
export GIT_CONFIG_NOSYSTEM=1
unset AGENTIC_BRAIN_GLOBAL AGENT_BRAIN_GLOBAL

N=0; FAILS=0; W=""; OUT=""; RC=0

fresh() {
  N=$((N + 1)); W="$TMP/w$N"
  mkdir -p "$W"
  cp -a "$SRC/." "$W/"
  rm -rf "$W/.git"
  git -C "$W" init -q
}
run_check() { OUT=$(cd "${1:-$W}" && bash agentic-brain/bin/check.sh 2>&1); RC=$?; }
expect() { # description code regex
  if [ "$RC" -eq "$2" ] && printf '%s' "$OUT" | grep -qE "$3"; then
    echo "ok   $1"
  else
    echo "FAIL $1 (code $RC, expected $2 and /$3/)"
    printf '%s\n' "$OUT" | sed 's/^/     /'
    FAILS=$((FAILS + 1))
  fi
}
expect_true() { # description command...
  local d=$1; shift
  if "$@"; then echo "ok   $d"; else echo "FAIL $d"; FAILS=$((FAILS + 1)); fi
}

# project layer: a folder above the repo (sibling of the work repo) with the skill pskill
mkproj() { # creates $P and sets the line project: in the RULES.md of $W
  P="$TMP/proj$N"
  mkdir -p "$P/agentic-brain/skills/pskill/scripts" "$P/agentic-brain/artifacts"
  : > "$P/agentic-brain/RULES.md"
  printf -- '---\nname: pskill\ndescription: Use when the project skill is needed.\n---\n' > "$P/agentic-brain/skills/pskill/SKILL.md"
  printf '#!/usr/bin/env bash\ntrue\n' > "$P/agentic-brain/skills/pskill/scripts/a.sh"
  setproj "../proj$N/agentic-brain"
}
setproj() { # path [rules file]
  local f=${2:-$W/agentic-brain/RULES.md}
  { printf -- '---\nproject: %s\n---\n' "$1"; cat "$f"; } > "$TMP/rules.new"
  cat "$TMP/rules.new" > "$f"
}

fresh; run_check
expect "template passes" 0 "^check.sh: ok$"

fresh; (cd "$W/agentic-brain/memory" && bash ../bin/check.sh >/dev/null 2>&1); RC=$?; OUT=x
expect "runs from a subfolder too" 0 x

# symlinks
fresh; rm "$W/.claude/skills/error"; run_check
expect "missing symlink is created" 0 "CREATED symlink .claude/skills/error"
expect_true "created symlink points to the skill" test "$(readlink "$W/.claude/skills/error")" = "../../agentic-brain/skills/error"
run_check
expect "second run prints nothing about symlinks" 0 "^check.sh: ok$"

fresh; ln -s ../../agentic-brain/skills/old "$W/.claude/skills/old"; run_check
expect "dangling symlink is deleted" 0 "DELETED dangling symlink .claude/skills/old"
expect_true "dangling symlink is gone" test ! -L "$W/.claude/skills/old"

fresh; mkdir "$W/.claude/skills/foreign"; run_check
expect "other entry without a skill is an error" 1 "ERROR .claude/skills/foreign"

fresh; rm "$W/.claude/skills/error"; mkdir "$W/.claude/skills/error"; run_check
expect "folder instead of a symlink is an error" 1 "ERROR .claude/skills/error: not a symlink"

fresh; mkdir -p "$W/agentic-brain/skills/fresh/scripts"
printf -- '---\nname: fresh\ndescription: Use when a new skill is needed.\n---\n' > "$W/agentic-brain/skills/fresh/SKILL.md"
printf '#!/usr/bin/env bash\ntrue\n' > "$W/agentic-brain/skills/fresh/scripts/a.sh"
run_check
expect "new skill gets a symlink" 0 "CREATED symlink .claude/skills/fresh"

# skills
fresh; rm -rf "$W/agentic-brain/skills/error/scripts"; run_check
expect "skill without scripts" 1 "ERROR agentic-brain/skills/error/scripts: scripts/ is missing"

fresh; rm "$W/agentic-brain/skills/error/scripts/error.sh"; touch "$W/agentic-brain/skills/error/scripts/.gitkeep"; run_check
expect "skill with empty scripts" 1 "ERROR agentic-brain/skills/error/scripts"

fresh; printf -- '---\nname: error\n---\n' > "$W/agentic-brain/skills/error/SKILL.md"; run_check
expect "skill without description" 1 "ERROR agentic-brain/skills/error/SKILL.md: frontmatter has no description"

fresh; rm "$W/agentic-brain/skills/error/SKILL.md"; run_check
expect "skill without SKILL.md" 1 "SKILL.md is missing"

# error register (rows are written by hand here, skills/error/scripts/error.sh has its own test)
fresh; printf '%s\n' '| 2026-01-01 | class1 | first occurrence | | |' >> "$W/agentic-brain/errors/REGISTER.md"; run_check
expect "one open error is only a warning" 0 "WARNING .*class class1 is open"
printf '%s\n' '| 2026-01-02 | class1 | second occurrence | | |' >> "$W/agentic-brain/errors/REGISTER.md"; run_check
expect "duplicate error without a fix" 1 "ERROR agentic-brain/errors/REGISTER.md: class class1 has 2 rows without a fix"

fresh
printf '%s\n' '| 2026-01-01 | t | a | fixed | test |' '| 2026-01-02 | t | b | fixed | test |' >> "$W/agentic-brain/errors/REGISTER.md"; run_check
expect "errors with a filled-in fix pass" 0 "^check.sh: ok$"

# scratch
fresh; touch "$W/agentic-brain/scratch/notes.txt"; run_check
expect "scratch not empty" 1 "ERROR agentic-brain/scratch/notes.txt: scratch is not empty"

# memory
fresh; printf -- '- [Missing](missing.md): hook\n' >> "$W/agentic-brain/memory/MEMORY.md"; run_check
expect "MEMORY.md points to a missing file" 1 "ERROR agentic-brain/memory/MEMORY.md: line points to a missing file memory/missing.md"

fresh; printf 'content\n' > "$W/agentic-brain/memory/orphan.md"; run_check
expect "memory file outside the index" 1 "ERROR agentic-brain/memory/orphan.md: file is not in the MEMORY.md index"
printf -- '- [Orphan](orphan.md): hook\n' >> "$W/agentic-brain/memory/MEMORY.md"; run_check
expect "memory file in the index passes" 0 "^check.sh: ok$"

# links
fresh; printf '\n[dead](missing.md)\n' >> "$W/agentic-brain/decisions/README.md"; run_check
expect "dead link" 1 "ERROR agentic-brain/decisions/README.md: dead link to missing.md"

fresh; printf '\nExample `[x](missing.md)` in code.\n' >> "$W/agentic-brain/decisions/README.md"; run_check
expect "link in code is not checked" 0 "^check.sh: ok$"

fresh; printf '\n[ok](README.md) [web](https://example.org/a)\n' >> "$W/agentic-brain/decisions/README.md"
run_check
expect "existing and external links pass" 0 "^check.sh: ok$"

# CLAUDE.md and AGENTS.md
fresh; printf '@agentic-brain/RULES.md\nextra\n' > "$W/AGENTS.md"; run_check
expect "CLAUDE.md and AGENTS.md differ" 1 "ERROR AGENTS.md: content differs"

fresh; printf 'no import\n' | tee "$W/CLAUDE.md" > "$W/AGENTS.md"; run_check
expect "import line is missing" 1 "ERROR CLAUDE.md: line @agentic-brain/RULES.md is missing"

fresh; rm "$W/AGENTS.md"; run_check
expect "AGENTS.md is missing" 1 "ERROR AGENTS.md: file is missing"

# artifacts
fresh; mkdir -p "$W/agentic-brain/artifacts/web"; printf '# Web\n' > "$W/agentic-brain/artifacts/web/PLAYBOOK.md"; run_check
expect "artifact without reference" 1 "ERROR agentic-brain/artifacts/web/reference"
mkdir "$W/agentic-brain/artifacts/web/reference"; printf '<html></html>\n' > "$W/agentic-brain/artifacts/web/reference/sample.html"; run_check
expect "artifact with a reference passes" 0 "^check.sh: ok$"
rm "$W/agentic-brain/artifacts/web/PLAYBOOK.md"; run_check
expect "artifact without PLAYBOOK.md" 1 "ERROR agentic-brain/artifacts/web: PLAYBOOK.md is missing"

# global layer
fresh; mkdir -p "$HOME/agentic-brain/skills/error"; touch "$HOME/agentic-brain/RULES.md"; run_check
expect "same skill in the local and the global layer" 1 "ERROR agentic-brain/skills/error: skill error also exists in the global layer"
rm -rf "$HOME/agentic-brain/skills/error"; run_check
expect "without a duplicate it passes" 0 "^check.sh: ok$"

fresh; mkdir -p "$HOME/agentic-brain/skills" "$W/agentic-brain/skills/shared/scripts"
touch "$HOME/agentic-brain/RULES.md"
printf -- '---\nname: shared\ndescription: Use when a shared skill is needed.\nscope: shared\n---\n' > "$W/agentic-brain/skills/shared/SKILL.md"
printf '#!/usr/bin/env bash\ntrue\n' > "$W/agentic-brain/skills/shared/scripts/a.sh"; run_check
expect "scope shared outside the global layer is a warning" 0 "WARNING agentic-brain/skills/shared: scope is shared"
rm -rf "$HOME/agentic-brain"

# the folder of the global brain from AGENT_BRAIN_GLOBAL (the variable of lib/paths.sh);
# AGENTIC_BRAIN_GLOBAL wins when both are set
fresh; mkdir -p "$TMP/gb$N/skills/error" "$TMP/gb$N/skills/other"; touch "$TMP/gb$N/RULES.md"
AGENT_BRAIN_GLOBAL="$TMP/gb$N" run_check
expect "AGENT_BRAIN_GLOBAL points to the global layer" 1 "ERROR agentic-brain/skills/error: skill error also exists in the global layer"
mkdir -p "$TMP/gc$N"; touch "$TMP/gc$N/RULES.md"
AGENTIC_BRAIN_GLOBAL="$TMP/gc$N" AGENT_BRAIN_GLOBAL="$TMP/gb$N" run_check
expect "AGENTIC_BRAIN_GLOBAL wins over AGENT_BRAIN_GLOBAL" 0 "^check.sh: ok$"
run_check
expect "without both variables the global layer is not found" 0 "^check.sh: ok$"

# the global repo itself (a folder without a parent agentic-brain/)
N=$((N + 1)); W="$TMP/flat$N"; mkdir -p "$W"; cp -a "$SRC/agentic-brain/." "$W/"; git -C "$W" init -q
OUT=$(cd "$W" && bash bin/check.sh 2>&1); RC=$?
expect "global (the brain is the repo root) passes" 0 "^check.sh: ok$"

# project layer
fresh; mkproj; run_check
expect "project skill gets a symlink" 0 "CREATED symlink .claude/skills/pskill to ../../../proj$N/agentic-brain/skills/pskill"
expect_true "project symlink points to the project layer" test "$(readlink "$W/.claude/skills/pskill")" = "../../../proj$N/agentic-brain/skills/pskill"
expect_true "project symlink resolves to the skill" test -f "$W/.claude/skills/pskill/SKILL.md"
run_check
expect "existing project symlink passes" 0 "^check.sh: ok$"

fresh; mkproj; run_check; rm -rf "$P/agentic-brain/skills/pskill"; run_check
expect "dangling project symlink is deleted" 0 "DELETED dangling symlink .claude/skills/pskill"

fresh; mkproj; mkdir "$W/.claude/skills/pskill"; run_check
expect "folder instead of a project symlink is an error" 1 "ERROR .claude/skills/pskill: not a symlink"

fresh; mkproj; mkdir -p "$TMP/elsewhere"; ln -s "$TMP/elsewhere" "$W/.claude/skills/pskill"; run_check
expect "project symlink to another folder is an error" 1 "ERROR .claude/skills/pskill: symlink points to"

fresh; mkproj; mkdir "$P/agentic-brain/skills/error"; run_check
expect "same skill in the repo and the project layer" 1 "ERROR agentic-brain/skills/error: skill error also exists in the project layer"

# the same skill of the template (identical SKILL.md) in several layers
copy_skill() { # skill name, target layer dir [, source layer dir, default the repo layer]
  local from=${3:-$W/agentic-brain}
  [ -f "$from/skills/$1/SKILL.md" ] || { echo "test setup: no skill $1 in $from"; exit 2; }
  mkdir -p "$2/skills"; cp -a "$from/skills/$1" "$2/skills/$1"
}
fresh; mkproj; copy_skill error "$P/agentic-brain"; copy_skill task-end "$P/agentic-brain"; run_check
expect "same SKILL.md in the repo and the project layer passes" 0 "^check.sh: ok$"
expect_true "the link of a shared skill points to the repo layer" test "$(readlink "$W/.claude/skills/error")" = "../../agentic-brain/skills/error"
expect_true "a second shared skill links to the repo layer too" test "$(readlink "$W/.claude/skills/task-end")" = "../../agentic-brain/skills/task-end"
expect_true "the project only skill still gets its link" test -L "$W/.claude/skills/pskill"
run_check
expect "second run with shared skills prints nothing new" 0 "^check.sh: ok$"

fresh; mkproj; copy_skill error "$P/agentic-brain"; printf '\nDifferent text.\n' >> "$P/agentic-brain/skills/error/SKILL.md"; run_check
expect "different SKILL.md in the repo and the project layer" 1 "ERROR agentic-brain/skills/error: skill error also exists in the project layer .* with a different SKILL.md"
expect_true "the link of a different skill stays on the repo layer" test "$(readlink "$W/.claude/skills/error")" = "../../agentic-brain/skills/error"

fresh; mkproj; mkdir -p "$P/agentic-brain/skills/error"; run_check
expect "a project skill without SKILL.md is a different skill" 1 "ERROR agentic-brain/skills/error: skill error also exists in the project layer"

fresh; copy_skill error "$HOME/agentic-brain"; touch "$HOME/agentic-brain/RULES.md"; run_check
expect "same SKILL.md in the repo and the global layer passes" 0 "^check.sh: ok$"
printf '\nDifferent text.\n' >> "$HOME/agentic-brain/skills/error/SKILL.md"; run_check
expect "different SKILL.md in the repo and the global layer" 1 "ERROR agentic-brain/skills/error: skill error also exists in the global layer .* with a different SKILL.md"
rm -rf "$HOME/agentic-brain"

fresh; mkproj; copy_skill pskill "$HOME/agentic-brain" "$P/agentic-brain"; touch "$HOME/agentic-brain/RULES.md"; run_check
expect "same SKILL.md in the project and the global layer passes" 0 "^check.sh: ok$"
printf '\nDifferent text.\n' >> "$HOME/agentic-brain/skills/pskill/SKILL.md"; run_check
expect "different SKILL.md in the project and the global layer" 1 "ERROR .*proj$N/agentic-brain/skills/pskill: skill pskill exists in both the project layer and the global layer .* with a different SKILL.md"
rm -rf "$HOME/agentic-brain"

fresh; mkproj; copy_skill error "$P/agentic-brain"; copy_skill error "$HOME/agentic-brain"; touch "$HOME/agentic-brain/RULES.md"; run_check
expect "the same skill in all three layers passes" 0 "^check.sh: ok$"
rm -rf "$HOME/agentic-brain"

fresh; mkproj; run_check
mkdir -p "$HOME/agentic-brain/skills/pskill"; touch "$HOME/agentic-brain/RULES.md"; run_check
expect "a global skill without SKILL.md differs from the project skill" 1 "ERROR .*proj$N/agentic-brain/skills/pskill: skill pskill exists in both the project layer and the global layer"
rm -rf "$HOME/agentic-brain"

fresh; setproj "../nope/agentic-brain"; run_check
expect "project line to a missing folder" 1 "ERROR agentic-brain/RULES.md: project layer ../nope/agentic-brain is missing"

fresh; mkdir -p "$TMP/empty$N"; setproj "../empty$N"; run_check
expect "project folder without RULES.md and skills" 1 "ERROR agentic-brain/RULES.md: project layer ../empty$N is missing"

fresh; setproj "agentic-brain"; run_check
expect "project layer that is the repo layer itself" 1 "ERROR agentic-brain/RULES.md: project layer agentic-brain is this folder"

fresh; mkproj; run_check; N2=$N
fresh; AGENTIC_BRAIN_PROJECT="$TMP/proj$N2/agentic-brain" run_check
expect "AGENTIC_BRAIN_PROJECT sets the project layer" 0 "CREATED symlink .claude/skills/pskill to $TMP/proj$N2/agentic-brain/skills/pskill"
fresh; AGENTIC_BRAIN_PROJECT="$TMP/nope" run_check
expect "AGENTIC_BRAIN_PROJECT to a missing folder" 1 "ERROR AGENTIC_BRAIN_PROJECT: project layer $TMP/nope is missing"

# scope shared with a project layer
shared_skill() { # layer dir
  mkdir -p "$1/skills/shared/scripts"
  printf -- '---\nname: shared\ndescription: Use when a shared skill is needed.\nscope: shared\n---\n' > "$1/skills/shared/SKILL.md"
  printf '#!/usr/bin/env bash\ntrue\n' > "$1/skills/shared/scripts/a.sh"
}
fresh; mkproj; shared_skill "$W/agentic-brain"; run_check
expect "scope shared missing in the project layer is a warning" 0 "WARNING agentic-brain/skills/shared: scope is shared but it is not in the project layer"
shared_artifact() { # layer dir
  mkdir -p "$1/artifacts/shared/reference"
  printf -- '---\nscope: shared\n---\n# Shared\n' > "$1/artifacts/shared/PLAYBOOK.md"
  printf 'x\n' > "$1/artifacts/shared/reference/a.txt"
}
fresh; mkproj; shared_artifact "$W/agentic-brain"; run_check
expect "shared artifact missing in the project layer is a warning" 0 "WARNING agentic-brain/artifacts/shared: scope is shared but it is not in the project layer"
fresh; mkproj; shared_artifact "$W/agentic-brain"; mkdir -p "$P/agentic-brain/artifacts/shared"; run_check
expect "shared artifact present in the project layer is no warning" 0 "^check.sh: ok$"
fresh; mkproj; shared_artifact "$W/agentic-brain"; mkdir -p "$HOME/agentic-brain/artifacts/shared"; touch "$HOME/agentic-brain/RULES.md"; run_check
expect "shared artifact present in the global layer is no warning" 0 "^check.sh: ok$"
rm -rf "$HOME/agentic-brain"

# the project layer line is ignored in the global brain (no repo layer)
N=$((N + 1)); W="$TMP/flat$N"; mkdir -p "$W"; cp -a "$SRC/agentic-brain/." "$W/"; git -C "$W" init -q
setproj "../nope" "$W/RULES.md"
OUT=$(cd "$W" && bash bin/check.sh 2>&1); RC=$?
expect "project line is ignored in the global brain" 0 "^check.sh: ok$"

# hook
fresh; (cd "$W" && bash agentic-brain/bin/check.sh --install-hook) > "$TMP/hook.out" 2>&1
expect_true "hook is installed" test -x "$W/.git/hooks/pre-commit"
(cd "$W" && bash agentic-brain/bin/check.sh --install-hook) > "$TMP/hook2.out" 2>&1
expect_true "repeated hook installation passes" test "$?" -eq 0
GC=(git -C "$W" -c user.name=t -c user.email=t@example.org)
"${GC[@]}" add -A >/dev/null 2>&1
if "${GC[@]}" commit -qm first >/dev/null 2>&1; then echo "ok   commit in a clean repo passes"; else echo "FAIL commit in a clean repo passes"; FAILS=$((FAILS + 1)); fi
touch "$W/agentic-brain/scratch/junk" "$W/new-file"
"${GC[@]}" add new-file >/dev/null 2>&1
if "${GC[@]}" commit -qm second >/dev/null 2>&1; then
  echo "FAIL hook rejects a commit on error"; FAILS=$((FAILS + 1))
else
  echo "ok   hook rejects a commit on error"
fi

fresh; mkdir -p "$W/.git/hooks"; printf '#!/bin/sh\n# old agentic-brain hook\nbash agentic-brain/bin/check.sh\n' > "$W/.git/hooks/pre-commit"
(cd "$W" && bash agentic-brain/bin/check.sh --install-hook) > /dev/null 2>&1
expect_true "an older own hook is replaced" grep -q 'agentic-brain check hook' "$W/.git/hooks/pre-commit"

fresh; mkdir -p "$W/.git/hooks"; printf '#!/bin/sh\nexit 0\n' > "$W/.git/hooks/pre-commit"
(cd "$W" && bash agentic-brain/bin/check.sh --install-hook) > "$TMP/hook3.out" 2>&1; RC=$?; OUT=$(cat "$TMP/hook3.out")
expect "foreign hook is not overwritten" 1 "another pre-commit hook exists"

# skills with "scripts: none"
fresh; mkdir -p "$W/agentic-brain/skills/rules-only"
printf -- '---\nname: rules-only\ndescription: Use when only rules are needed.\nscripts: none\nscripts-reason: The skill has no mechanical step.\n---\n' > "$W/agentic-brain/skills/rules-only/SKILL.md"; run_check
expect "scripts: none with a reason passes without scripts/" 0 "^check.sh: ok$"
expect_true "scripts: none skill gets a symlink" test -L "$W/.claude/skills/rules-only"
printf -- '---\nname: rules-only\ndescription: Use when only rules are needed.\nscripts: none\n---\n' > "$W/agentic-brain/skills/rules-only/SKILL.md"; run_check
expect "scripts: none without a reason" 1 "ERROR agentic-brain/skills/rules-only/SKILL.md: scripts: none needs a scripts-reason line"
printf -- '---\nname: rules-only\ndescription: Use when only rules are needed.\nscripts: none\nscripts-reason:\n---\n' > "$W/agentic-brain/skills/rules-only/SKILL.md"; run_check
expect "scripts: none with an empty reason" 1 "scripts: none needs a scripts-reason line"
printf -- '---\nname: rules-only\ndescription: Use when only rules are needed.\n---\n' > "$W/agentic-brain/skills/rules-only/SKILL.md"; run_check
expect "a skill without the scripts line still needs scripts/" 1 "ERROR agentic-brain/skills/rules-only/scripts: scripts/ is missing"

# check.sh with a target, run from elsewhere
RT="$REPO/brain/bin/check.sh"
run_target() { OUT=$(cd "$TMP" && bash "$RT" "$@" 2>&1); RC=$?; }
fresh; run_target "$W"
expect "target: repo root with agentic-brain/ passes" 0 "^check.sh: ok$"
fresh; run_target "$W/agentic-brain"
expect "target: the brain folder of a repo passes" 0 "^check.sh: ok$"
fresh; touch "$W/agentic-brain/scratch/junk"; run_target "$W"
expect "target: errors are reported with the target paths" 1 "ERROR agentic-brain/scratch/junk: scratch is not empty"
fresh; rm "$W/.claude/skills/error"; run_target "$W"
expect "target: the symlink is created in the target" 0 "CREATED symlink .claude/skills/error"
expect_true "target: the created symlink exists" test -L "$W/.claude/skills/error"
N=$((N + 1)); W="$TMP/flat$N"; mkdir -p "$W"; cp -a "$SRC/agentic-brain/." "$W/"; git -C "$W" init -q
run_target "$W"
expect "target: a brain at the root of a repo passes (global mode)" 0 "^check.sh: ok$"
N=$((N + 1)); W="$TMP/nobrain$N"; mkdir -p "$W"; git -C "$W" init -q
run_target "$W"
expect "target: a folder without a brain" 1 "has no brain"
run_target "$TMP/does-not-exist"
expect "target: a missing folder" 2 "is not a folder"
run_target "$W" "$W"
expect "two targets are a usage error" 2 "Usage: check.sh"

# hook of a repo without a copy of bin/ (the hook runs the check.sh it was installed from)
N=$((N + 1)); W="$TMP/def$N"; mkdir -p "$W"; git -C "$W" init -q
bash "$REPO/brain/bin/adopt.sh" "$W" > /dev/null 2>&1
OUT=$(cd "$TMP" && bash "$RT" --install-hook "$W" 2>&1); RC=$?
expect "target: --install-hook for a repo without bin/" 0 "Hook installed"
expect_true "target: the installed hook names this check.sh" grep -q "$REPO/brain/bin/check.sh" "$W/.git/hooks/pre-commit"
GC=(git -C "$W" -c user.name=t -c user.email=t@example.org)
"${GC[@]}" add -A >/dev/null 2>&1
if "${GC[@]}" commit -qm first >/dev/null 2>&1; then echo "ok   target hook: a commit in a clean repo passes"; else echo "FAIL target hook: a commit in a clean repo passes"; FAILS=$((FAILS + 1)); fi
touch "$W/agentic-brain/scratch/junk" "$W/new-file"; "${GC[@]}" add new-file >/dev/null 2>&1
if "${GC[@]}" commit -qm second >/dev/null 2>&1; then echo "FAIL target hook rejects a commit on error"; FAILS=$((FAILS + 1)); else echo "ok   target hook rejects a commit on error"; fi

echo
if [ "$FAILS" -gt 0 ]; then echo "check.test.sh: $FAILS failures"; exit 1; fi
echo "check.test.sh: all passed"
