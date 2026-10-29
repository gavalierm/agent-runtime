#!/usr/bin/env bash
# Rolls the brain into an existing repo. It commits nothing and overwrites nothing.
# Usage: adopt.sh [--standalone] [--root] [--project <path>] <target-repo>
#
# By default the script creates only data in the target: agentic-brain/ with RULES.md, skills/,
# artifacts/README.md, errors/REGISTER.md, decisions/README.md, memory/MEMORY.md and
# scratch/.gitkeep, the symlinks .claude/skills/<name>, the line @agentic-brain/RULES.md in
# CLAUDE.md and AGENTS.md, and the scratch lines in .gitignore. The code (check.sh, the skills
# error and task-end) stays in this repo and serves the target without a copy:
# check.sh --install-hook <target> and check.sh <target>.
#
#   --standalone      also copies bin/ and the skills error and task-end into
#                     agentic-brain/ and creates .claude/settings.json with the repeat_guard hook
#                     (a repo of an operator who has no clone of this repo)
#   --root            the brain is the whole target repo: RULES.md, skills/, artifacts/, errors/,
#                     decisions/, memory/, scratch/ at its root, CLAUDE.md with the single line
#                     @RULES.md, no agentic-brain/ folder
#   --project <path>  the project layer above the repo: a folder with RULES.md and skills/,
#                     path relative to the root of the target repo (for example
#                     ../project/agentic-brain). The script writes "project: <path>" into
#                     the frontmatter of the target's RULES.md and creates the
#                     symlinks .claude/skills/<name> to the skills of the project layer, except
#                     the skills the repo layer has under the same name (that link goes to the
#                     repo layer).
set -u

usage() { echo "Usage: adopt.sh [--standalone] [--root] [--project <path>] <target-repo>" >&2; exit 2; }

PROJECT=""; STANDALONE=0; ROOT_MODE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) [ "$#" -ge 2 ] || usage; PROJECT=$2; shift 2 ;;
    --standalone) STANDALONE=1; shift ;;
    --root) ROOT_MODE=1; shift ;;
    *) break ;;
  esac
done
if [ "$#" -ne 1 ] || [ ! -d "$1" ]; then usage; fi

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
SRC=$(cd "$SELF_DIR/.." && pwd -P)
TARGET=$(cd "$1" && pwd -P)

if [ ! -e "$TARGET/.git" ]; then
  echo "$TARGET is not a git repo (.git is missing)" >&2
  exit 1
fi
if [ "$SRC" = "$TARGET/agentic-brain" ] || [ "$SRC" = "$TARGET" ]; then
  echo "Source and target are the same folder" >&2
  exit 1
fi

if [ "$ROOT_MODE" = 1 ]; then
  DEST=$TARGET; PREFIX=""; IMPORT="@RULES.md"; DESTNAME=""
else
  DEST=$TARGET/agentic-brain; PREFIX="agentic-brain/"; IMPORT="@agentic-brain/RULES.md"; DESTNAME="agentic-brain/"
fi

# the skills of the template: the folders skills/error and skills/task-end of the repo above brain/,
# or skills/ of this folder when the script runs from a standalone copy
template_skill() { # name -> folder on stdout
  if [ -d "$SRC/../skills/$1" ]; then printf '%s' "$(cd "$SRC/../skills/$1" && pwd -P)"
  elif [ -d "$SRC/skills/$1" ]; then printf '%s' "$SRC/skills/$1"
  fi
}

# the project layer is checked before anything is changed
if [ -n "$PROJECT" ]; then
  PROJECT=${PROJECT#./}; PROJECT=${PROJECT%/}
  case "$PROJECT" in
    /*) echo "--project must be a path relative to the root of the target repo: $PROJECT" >&2; exit 1 ;;
  esac
  if [ ! -d "$TARGET/$PROJECT" ] || { [ ! -f "$TARGET/$PROJECT/RULES.md" ] && [ ! -d "$TARGET/$PROJECT/skills" ]; }; then
    echo "project layer $PROJECT is missing (expected a folder with RULES.md or skills/ relative to $TARGET)" >&2
    exit 1
  fi
fi
if [ "$STANDALONE" = 1 ]; then
  for s in error task-end; do
    [ -n "$(template_skill "$s")" ] || { echo "skill $s of the template was not found next to $SRC" >&2; exit 1; }
  done
fi

# 1. the brain folder without overwriting existing files
copied=0; skipped=0
put_file() { # source file, path relative to DEST
  if [ -e "$DEST/$2" ] || [ -L "$DEST/$2" ]; then
    echo "Skipped, already exists: $DESTNAME$2"
    skipped=$((skipped + 1))
  else
    mkdir -p "$(dirname "$DEST/$2")"
    cp -p "$1" "$DEST/$2"
    copied=$((copied + 1))
  fi
}
put_empty() { # path relative to DEST
  if [ -e "$DEST/$1" ]; then
    echo "Skipped, already exists: $DESTNAME$1"
    skipped=$((skipped + 1))
  else
    mkdir -p "$(dirname "$DEST/$1")"
    : > "$DEST/$1"
    copied=$((copied + 1))
  fi
}
for r in RULES.md artifacts/README.md errors/REGISTER.md decisions/README.md memory/MEMORY.md scratch/.gitkeep; do
  put_file "$SRC/$r" "$r"
done
put_empty skills/.gitkeep
if [ "$STANDALONE" = 1 ]; then
  while IFS= read -r f; do
    put_file "$f" "bin/${f#"$SRC"/bin/}"
  done < <(find "$SRC/bin" -type f ! -name '.DS_Store' | sort)
  for s in error task-end; do
    from=$(template_skill "$s")
    while IFS= read -r f; do
      put_file "$f" "skills/$s/${f#"$from"/}"
    done < <(find "$from" -type f ! -name '.DS_Store' | sort)
  done
fi
echo "Copied files: $copied, skipped: $skipped"

# 2. skill symlinks (only for a brain in agentic-brain/, the root brain is linked by install.sh --global)
if [ "$ROOT_MODE" = 0 ]; then
  for d in "$DEST"/skills/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    link="$TARGET/.claude/skills/$name"
    if [ -L "$link" ] || [ -e "$link" ]; then
      echo "Skipped, already exists: .claude/skills/$name"
    else
      mkdir -p "$TARGET/.claude/skills"
      ln -s "../../agentic-brain/skills/$name" "$link"
      echo "Created symlink: .claude/skills/$name"
    fi
  done
fi

# 2b. project layer: the line "project: <path>" in the frontmatter of RULES.md and symlinks to its skills
if [ -n "$PROJECT" ]; then
  RULES="$DEST/RULES.md"
  cur=""
  if [ "$(head -n 1 "$RULES" | tr -d '\r')" = "---" ]; then
    cur=$(tr -d '\r' < "$RULES" | awk 'NR == 1 { next } $0 == "---" { exit } { print }' | sed -n 's/^project:[[:space:]]*//p' | head -n 1 | sed 's/[[:space:]]*$//')
  fi
  proj_ok=1
  if [ "$cur" = "$PROJECT" ]; then
    echo "Line project: $PROJECT already in ${DESTNAME}RULES.md"
  elif [ -n "$cur" ]; then
    echo "Skipped, ${DESTNAME}RULES.md already has project: $cur (not changed to $PROJECT), no project symlinks created"
    proj_ok=0
  else
    tmp=$(mktemp)
    if [ "$(head -n 1 "$RULES" | tr -d '\r')" = "---" ]; then
      { head -n 1 "$RULES"; printf 'project: %s\n' "$PROJECT"; tail -n +2 "$RULES"; } > "$tmp"
    else
      { printf -- '---\nproject: %s\n---\n' "$PROJECT"; cat "$RULES"; } > "$tmp"
    fi
    cat "$tmp" > "$RULES"; rm -f "$tmp"
    echo "Added line project: $PROJECT to the frontmatter of ${DESTNAME}RULES.md"
  fi
  if [ "$proj_ok" = 1 ] && [ "$ROOT_MODE" = 0 ]; then
    for d in "$TARGET/$PROJECT"/skills/*/; do
      [ -d "$d" ] || continue
      name=$(basename "$d")
      link="$TARGET/.claude/skills/$name"
      if [ -d "$DEST/skills/$name" ]; then
        echo "Skipped, the repo layer has skill $name"
      elif [ -L "$link" ] || [ -e "$link" ]; then
        echo "Skipped, already exists: .claude/skills/$name"
      else
        mkdir -p "$TARGET/.claude/skills"
        ln -s "../../$PROJECT/skills/$name" "$link"
        echo "Created symlink: .claude/skills/$name (project layer)"
      fi
    done
  fi
fi

# 3. .claude/settings.json with the repeat_guard hook, only with the copied bin/
if [ "$STANDALONE" = 1 ]; then
  SETTINGS="$TARGET/.claude/settings.json"
  if [ ! -e "$SETTINGS" ]; then
    mkdir -p "$TARGET/.claude"
    cat > "$SETTINGS" <<EOT
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"\$CLAUDE_PROJECT_DIR/${PREFIX}bin/repeat_guard.mjs\""
          }
        ]
      }
    ]
  }
}
EOT
    echo "Created .claude/settings.json with the repeat_guard hook"
  elif grep -q 'repeat_guard.mjs' "$SETTINGS"; then
    echo "The repeat_guard hook is already in .claude/settings.json"
  else
    echo "Skipped, .claude/settings.json already exists. Add this entry to hooks.PreToolUse:"
    cat <<EOT
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node \"\$CLAUDE_PROJECT_DIR/${PREFIX}bin/repeat_guard.mjs\"" }
        ]
      }
EOT
  fi
fi

# 4. import line in CLAUDE.md (and AGENTS.md for a brain in agentic-brain/)
# CLAUDE.md gets the line first. A missing AGENTS.md is created as a copy of it,
# so both files are identical (check.sh requires this).
if [ "$ROOT_MODE" = 1 ]; then files=(CLAUDE.md); else files=(CLAUDE.md AGENTS.md); fi
both_existed=0
[ -f "$TARGET/CLAUDE.md" ] && [ -f "$TARGET/AGENTS.md" ] && both_existed=1
for f in "${files[@]}"; do
  p="$TARGET/$f"
  if [ "$f" = AGENTS.md ] && [ ! -f "$p" ] && [ -f "$TARGET/CLAUDE.md" ]; then
    cp "$TARGET/CLAUDE.md" "$p"
    echo "Created AGENTS.md as a copy of CLAUDE.md"
    continue
  fi
  if [ -f "$p" ] && grep -qxF "$IMPORT" "$p"; then
    echo "Import line already in $f"
    continue
  fi
  if [ -s "$p" ] && [ -n "$(tail -c1 "$p")" ]; then printf '\n' >> "$p"; fi
  printf '%s\n' "$IMPORT" >> "$p"
  echo "Added line $IMPORT to $f"
done
if [ "$ROOT_MODE" = 0 ] && [ "$both_existed" -eq 1 ] && ! cmp -s "$TARGET/CLAUDE.md" "$TARGET/AGENTS.md"; then
  echo "Warning: CLAUDE.md and AGENTS.md differ. check.sh requires identical content, make them the same."
fi

# 5. .gitignore
GI="$TARGET/.gitignore"
for line in "${PREFIX}scratch/*" "!${PREFIX}scratch/.gitkeep"; do
  if [ -f "$GI" ] && grep -qxF "$line" "$GI"; then continue; fi
  if [ -s "$GI" ] && [ -n "$(tail -c1 "$GI")" ]; then printf '\n' >> "$GI"; fi
  printf '%s\n' "$line" >> "$GI"
  echo "Added line to .gitignore: $line"
done

echo
echo "Done. Nothing was committed. Next, in the target repo:"
if [ "$STANDALONE" = 1 ]; then
  echo "  ${PREFIX}bin/check.sh --install-hook"
  echo "  ${PREFIX}bin/check.sh"
else
  echo "  $SELF_DIR/check.sh --install-hook $TARGET"
  echo "  $SELF_DIR/check.sh $TARGET"
fi
exit 0
