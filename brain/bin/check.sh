#!/usr/bin/env bash
# Check of the project repo. Exit code 0 is ok, exit code 1 means at least one error.
# It runs from the repo root and from any subfolder. An error is one line on stderr
# with a path, a warning is one line on stdout.
#
#   check.sh                 runs all checks
#   check.sh --install-hook  copies bin/pre-commit to .git/hooks/pre-commit
#
# The variable AGENTIC_BRAIN_GLOBAL may point to the folder of the global brain
# (with RULES.md and skills/). Without it, the script looks for ~/agentic-brain.
#
# The variable AGENTIC_BRAIN_PROJECT may point to the folder of the project layer
# (with RULES.md and skills/), absolute or relative to the repo root. Without it,
# the script reads the line "project: <path>" in the frontmatter of this repo's
# agentic-brain/RULES.md (path relative to the repo root). Without both, the repo
# has no project layer. The project layer is checked only inside a repo (not in
# the global brain). Its skills get symlinks in .claude/skills, except the skills the repo
# layer has under the same name (the link goes to the nearest layer).
#
# A skill with the same name in two layers is an error when its SKILL.md differs. The same
# SKILL.md (the same skill of the template) may exist in every layer.
set -u

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
BRAIN=$(cd "$SELF_DIR/.." && pwd -P)

case "${1:-}" in
  ""|--install-hook) ;;
  *) echo "Usage: check.sh [--install-hook]" >&2; exit 2 ;;
esac

ROOT=$(git -C "$BRAIN" rev-parse --show-toplevel 2>/dev/null) || ROOT=""
if [ -z "$ROOT" ]; then
  if [ "$(basename "$BRAIN")" = "agentic-brain" ]; then ROOT=$(dirname "$BRAIN"); else ROOT=$BRAIN; fi
fi
ROOT=$(cd "$ROOT" && pwd -P)

# project: the agentic-brain/ folder inside a code repo (the repo layer), global: the repo is the
# brain itself. Not to be mixed up with the project layer, which sits above several repos.
if [ "$BRAIN" = "$ROOT" ]; then MODE=global; else MODE=project; fi

ERRS=0
err() { echo "ERROR $1: $2" >&2; ERRS=$((ERRS + 1)); }
warn() { echo "WARNING $1: $2"; }
info() { echo "$1"; }
rel() { printf '%s' "${1#"$ROOT"/}"; }

# frontmatter lines (between the first two ---)
fm() { tr -d '\r' < "$1" | awk 'NR == 1 { if ($0 != "---") exit; next } $0 == "---" { exit } { print }'; }
fm_get() { fm "$1" | sed -n "s/^$2:[[:space:]]*//p" | head -n 1; }
# text without code blocks and without text in backticks
strip_code() { tr -d '\r' < "$1" | awk '/^```/ { f = !f; next } !f { gsub(/`[^`]*`/, ""); print }'; }
nonempty_dir() { [ -d "$1" ] && [ -n "$(find "$1" -type f ! -name '.gitkeep' ! -name '.DS_Store' 2>/dev/null | head -n 1)" ]; }

# folder of the global brain, empty output and exit code 1 when it does not exist or is this one
global_brain() {
  local d=""
  if [ -n "${AGENTIC_BRAIN_GLOBAL:-}" ]; then
    d=$AGENTIC_BRAIN_GLOBAL
  elif [ -f "${HOME:-/nonexistent}/agentic-brain/RULES.md" ] || [ -d "${HOME:-/nonexistent}/agentic-brain/skills" ]; then
    d=$HOME/agentic-brain
  elif [ -f "${HOME:-/nonexistent}/agentic-brain/agentic-brain/RULES.md" ] || [ -d "${HOME:-/nonexistent}/agentic-brain/agentic-brain/skills" ]; then
    d=$HOME/agentic-brain/agentic-brain
  fi
  [ -n "$d" ] && [ -d "$d" ] || return 1
  d=$(cd "$d" && pwd -P)
  [ "$d" = "$BRAIN" ] && return 1
  printf '%s' "$d"
}

# folder of the project layer. PROJ_RAW is the path as written (for messages and for
# the symlink targets), PROJ_DIR the resolved folder. Both are empty when the repo
# has no project layer or when the configured folder is missing (one error is raised).
PROJ_RAW=""; PROJ_DIR=""
project_brain() {
  local raw="" src="" abs
  PROJ_RAW=""; PROJ_DIR=""
  [ "$MODE" = project ] || return 1
  if [ -n "${AGENTIC_BRAIN_PROJECT:-}" ]; then
    raw=$AGENTIC_BRAIN_PROJECT; src="AGENTIC_BRAIN_PROJECT"
  elif [ -f "$BRAIN/RULES.md" ]; then
    raw=$(fm_get "$BRAIN/RULES.md" project | sed 's/[[:space:]]*$//'); src=$(rel "$BRAIN/RULES.md")
  fi
  [ -n "$raw" ] || return 1
  raw=${raw#./}; raw=${raw%/}
  case "$raw" in /*) abs=$raw ;; *) abs=$ROOT/$raw ;; esac
  if [ ! -d "$abs" ] || { [ ! -f "$abs/RULES.md" ] && [ ! -d "$abs/skills" ]; }; then
    err "$src" "project layer $raw is missing"
    return 1
  fi
  abs=$(cd "$abs" && pwd -P)
  if [ "$abs" = "$BRAIN" ]; then
    err "$src" "project layer $raw is this folder"
    return 1
  fi
  PROJ_RAW=$raw; PROJ_DIR=$abs
  printf '%s' "$abs"
}

install_hook() {
  local src="$BRAIN/bin/pre-commit" gitdir hooks dst
  [ -f "$src" ] || { err "$(rel "$src")" "pre-commit hook is missing"; return 1; }
  gitdir=$(git -C "$ROOT" rev-parse --git-common-dir 2>/dev/null) || { err "$ROOT" "not a git repo, the hook is not installed"; return 1; }
  gitdir=$(cd "$ROOT" && cd "$gitdir" && pwd -P)
  hooks="$gitdir/hooks"
  dst="$hooks/pre-commit"
  if [ -e "$dst" ] && ! cmp -s "$src" "$dst" && ! grep -q 'agentic-brain/bin/check.sh' "$dst"; then
    err "$dst" "another pre-commit hook exists and was left alone, add a call to agentic-brain/bin/check.sh to it"
    return 1
  fi
  mkdir -p "$hooks"
  cp "$src" "$dst" && chmod +x "$dst"
  info "Hook installed: $dst"
  if [ -n "$(git -C "$ROOT" config core.hooksPath 2>/dev/null)" ]; then
    warn "$dst" "core.hooksPath is set, git will not run the hook from .git/hooks"
  fi
  return 0
}

if [ "${1:-}" = "--install-hook" ]; then
  install_hook && exit 0
  exit 1
fi

# 1. CLAUDE.md and AGENTS.md
check_entry_files() {
  [ "$MODE" = project ] || return 0
  local line="@agentic-brain/RULES.md" f ok=1
  for f in CLAUDE.md AGENTS.md; do
    if [ ! -f "$ROOT/$f" ]; then err "$f" "file is missing"; ok=0; continue; fi
    grep -qxF "$line" "$ROOT/$f" || err "$f" "line $line is missing"
  done
  if [ "$ok" = 1 ] && ! cmp -s "$ROOT/CLAUDE.md" "$ROOT/AGENTS.md"; then
    err "AGENTS.md" "content differs from CLAUDE.md, the files must be identical"
  fi
}

# 2. skills
check_skills() {
  local d name f
  for d in "$BRAIN"/skills/*/; do
    [ -d "$d" ] || continue
    d=${d%/}; name=$(basename "$d"); f="$d/SKILL.md"
    if [ ! -f "$f" ]; then
      err "$(rel "$d")" "SKILL.md is missing"
    elif [ -z "$(fm_get "$f" description)" ]; then
      err "$(rel "$f")" "frontmatter has no description"
    fi
    nonempty_dir "$d/scripts" || err "$(rel "$d")/scripts" "scripts/ is missing or empty"
  done
}

# makes sure $1 is a symlink to the skill folder $3 (the link target text is $2)
sync_link() {
  local link=$1 want=$2 real=$3 cur sdir
  sdir=$(dirname "$link")
  if [ -L "$link" ]; then
    cur=$(readlink "$link")
    [ "$cur" = "$want" ] && return 0
    if [ -e "$link" ]; then
      [ "$(cd "$link" 2>/dev/null && pwd -P)" = "$real" ] && return 0
      err "$(rel "$link")" "symlink points to $cur, should point to $want"
      return 0
    fi
    rm "$link"; info "DELETED dangling symlink $(rel "$link")"
  elif [ -e "$link" ]; then
    err "$(rel "$link")" "not a symlink, should be a symlink to $want"
    return 0
  fi
  mkdir -p "$sdir" && ln -s "$want" "$link" && info "CREATED symlink $(rel "$link") to $want"
}

# 3. symlinks in .claude/skills: skills of this layer and of the project layer
check_symlinks() {
  [ "$MODE" = project ] || return 0
  local sdir="$ROOT/.claude/skills" d name base p
  for d in "$BRAIN"/skills/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    sync_link "$sdir/$name" "../../agentic-brain/skills/$name" "$BRAIN/skills/$name"
  done
  if [ -n "$PROJ_DIR" ]; then
    case "$PROJ_RAW" in /*) base=$PROJ_RAW ;; *) base="../../$PROJ_RAW" ;; esac
    for d in "$PROJ_DIR"/skills/*/; do
      [ -d "$d" ] || continue
      name=$(basename "$d")
      # the repo layer has the skill: the link goes to the nearest layer (the repo layer),
      # and a different SKILL.md is reported by check_duplicates
      [ -d "$BRAIN/skills/$name" ] && continue
      sync_link "$sdir/$name" "$base/skills/$name" "$PROJ_DIR/skills/$name"
    done
  fi
  for p in "$sdir"/* "$sdir"/.[!.]*; do
    [ -L "$p" ] || [ -e "$p" ] || continue
    name=$(basename "$p")
    case "$name" in .gitkeep|.DS_Store) continue ;; esac
    [ -d "$BRAIN/skills/$name" ] && continue
    [ -n "$PROJ_DIR" ] && [ -d "$PROJ_DIR/skills/$name" ] && continue
    if [ -L "$p" ] && [ ! -e "$p" ]; then
      rm "$p"; info "DELETED dangling symlink $(rel "$p")"
    else
      err "$(rel "$p")" "entry in .claude/skills has no skill in agentic-brain/skills or in the project layer"
    fi
  done
}

# 4. same skill name in two layers (this layer, the project layer, the global layer).
# The same SKILL.md in both is the same skill of the template and passes. A different SKILL.md is an error.
same_skill() { [ -f "$1/SKILL.md" ] && [ -f "$2/SKILL.md" ] && cmp -s "$1/SKILL.md" "$2/SKILL.md"; }
check_duplicates() {
  local g="" p="" d name
  g=$(global_brain) || g=""
  p=$PROJ_DIR
  for d in "$BRAIN"/skills/*/; do
    [ -d "$d" ] || continue
    d=${d%/}; name=$(basename "$d")
    if [ -n "$g" ] && [ -d "$g/skills/$name" ] && ! same_skill "$d" "$g/skills/$name"; then
      err "$(rel "$d")" "skill $name also exists in the global layer ($g/skills/$name) with a different SKILL.md"
    fi
    if [ -n "$p" ] && [ -d "$p/skills/$name" ] && ! same_skill "$d" "$p/skills/$name"; then
      err "$(rel "$d")" "skill $name also exists in the project layer ($p/skills/$name) with a different SKILL.md"
    fi
  done
  if [ -n "$g" ] && [ -n "$p" ]; then
    for d in "$p"/skills/*/; do
      [ -d "$d" ] || continue
      d=${d%/}; name=$(basename "$d")
      if [ -d "$g/skills/$name" ] && ! same_skill "$d" "$g/skills/$name"; then
        err "$PROJ_RAW/skills/$name" "skill $name exists in both the project layer and the global layer ($g/skills/$name) with a different SKILL.md"
      fi
    done
  fi
}

# 5. artifacts
check_artifacts() {
  local d
  for d in "$BRAIN"/artifacts/*/; do
    [ -d "$d" ] || continue
    d=${d%/}
    [ -f "$d/PLAYBOOK.md" ] || err "$(rel "$d")" "PLAYBOOK.md is missing"
    nonempty_dir "$d/reference" || err "$(rel "$d")/reference" "reference/ is missing or empty"
  done
}

# 6. error register
check_register() {
  local f="$BRAIN/errors/REGISTER.md" kind t n
  [ -f "$f" ] || { err "$(rel "$f")" "error register is missing"; return; }
  while IFS=$'\t' read -r kind t n; do
    if [ "$kind" = ERR ]; then
      err "$(rel "$f")" "class $t has $n rows without a fix, fix the cause and fill in the fix and test columns (or open a task)"
    else
      warn "$(rel "$f")" "class $t is open, one row without a fix"
    fi
  done < <(tr -d '\r' < "$f" | awk -F'|' '
    function trim(s) { gsub(/^[ \t]+|[ \t]+$/, "", s); return s }
    /^\|/ {
      if (trim($2) !~ /^[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]$/) next
      t = tolower(trim($3))
      if (!(t in seen)) { seen[t] = 1; order[++k] = t }
      if (trim($5) == "") open[t]++
    }
    END {
      for (i = 1; i <= k; i++) {
        t = order[i]
        if (open[t] >= 2) printf "ERR\t%s\t%d\n", t, open[t]
        else if (open[t] == 1) printf "WARN\t%s\t1\n", t
      }
    }')
}

# 7. scratch
check_scratch() {
  local p
  [ -d "$BRAIN/scratch" ] || return 0
  while IFS= read -r p; do
    err "$(rel "$p")" "scratch is not empty, delete the file or turn it into a skill"
  done < <(find "$BRAIN/scratch" -mindepth 1 ! -name '.gitkeep' | sort)
}

# 8. memory
check_memory() {
  local idx="$BRAIN/memory/MEMORY.md" t f name
  [ -f "$idx" ] || { err "$(rel "$idx")" "memory index is missing"; return; }
  while IFS= read -r t; do
    case "$t" in http://*|https://*) continue ;; esac
    t=${t%%#*}
    [ -e "$BRAIN/memory/$t" ] || err "$(rel "$idx")" "line points to a missing file memory/$t"
  done < <(strip_code "$idx" | grep '^- \[' | sed -n 's/^- \[[^]]*\](\([^)]*\)).*/\1/p')
  for f in "$BRAIN"/memory/*.md; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    [ "$name" = MEMORY.md ] && continue
    strip_code "$idx" | grep -qF "($name)" || err "$(rel "$f")" "file is not in the MEMORY.md index"
  done
}

# 9. relative links in md files
check_md_links() {
  local f dir link path
  while IFS= read -r f; do
    dir=$(dirname "$f")
    while IFS= read -r link; do
      case "$link" in http://*|https://*|mailto:*|\#*|/*|~*|"") continue ;; esac
      path=${link%%#*}; path=${path%% *}
      [ -n "$path" ] || continue
      [ -e "$dir/$path" ] || err "$(rel "$f")" "dead link to $path"
    done < <(strip_code "$f" | grep -o '\[[^]]*\]([^)]*)' | sed 's/^\[[^]]*\](\(.*\))$/\1/')
  done < <(find "$BRAIN" -name '*.md' ! -path "$BRAIN/scratch/*" ! -path '*/.git/*' | sort)
}

# 10. items with scope: shared that are in neither the global nor the project layer
check_shared() {
  local g="" p="" kind file d name layers=""
  g=$(global_brain) || g=""
  p=$PROJ_DIR
  [ -n "$g" ] || [ -n "$p" ] || return 0
  [ -n "$g" ] && layers="the global layer ($g)"
  [ -n "$p" ] && layers="${layers:+$layers or }the project layer ($p)"
  for kind in skills:SKILL.md artifacts:PLAYBOOK.md; do
    file=${kind#*:}; kind=${kind%%:*}
    for d in "$BRAIN/$kind"/*/; do
      [ -f "$d$file" ] || continue
      name=$(basename "$d")
      [ "$(fm_get "$d$file" scope)" = shared ] || continue
      [ -n "$g" ] && [ -d "$g/$kind/$name" ] && continue
      [ -n "$p" ] && [ -d "$p/$kind/$name" ] && continue
      warn "$(rel "${d%/}")" "scope is shared but it is not in $layers, name it in the report to the operator"
    done
  done
}

project_brain >/dev/null
check_entry_files
check_skills
check_symlinks
check_duplicates
check_artifacts
check_register
check_scratch
check_memory
check_md_links
check_shared

if [ "$ERRS" -gt 0 ]; then
  echo "check.sh: $ERRS errors" >&2
  exit 1
fi
echo "check.sh: ok"
exit 0
