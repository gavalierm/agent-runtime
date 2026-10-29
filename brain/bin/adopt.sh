#!/usr/bin/env bash
# Rolls the template out into an existing repo. It commits nothing and overwrites nothing.
# Usage: adopt.sh [--project <path>] <target-repo>
#
#   --project <path>  the project layer above the repo: a folder with RULES.md and skills/,
#                     path relative to the root of the target repo (for example
#                     ../project/agentic-brain). The script writes "project: <path>" into
#                     the frontmatter of the target's agentic-brain/RULES.md and creates the
#                     symlinks .claude/skills/<name> to the skills of the project layer, except
#                     the skills the repo layer has under the same name (that link goes to the
#                     repo layer).
set -u

usage() { echo "Usage: adopt.sh [--project <path>] <target-repo>" >&2; exit 2; }

PROJECT=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --project) [ "$#" -ge 2 ] || usage; PROJECT=$2; shift 2 ;;
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

DEST="$TARGET/agentic-brain"
IMPORT="@agentic-brain/RULES.md"

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

# 1. agentic-brain/ without overwriting existing files
copied=0; skipped=0
while IFS= read -r f; do
  r=${f#"$SRC"/}
  case "$r" in
    scratch/.gitkeep) ;;
    scratch/*) continue ;;
  esac
  if [ -e "$DEST/$r" ] || [ -L "$DEST/$r" ]; then
    echo "Skipped, already exists: agentic-brain/$r"
    skipped=$((skipped + 1))
  else
    mkdir -p "$(dirname "$DEST/$r")"
    cp -p "$f" "$DEST/$r"
    copied=$((copied + 1))
  fi
done < <(find "$SRC" -type f ! -path '*/.git/*' ! -name '.DS_Store' | sort)
echo "Copied files: $copied, skipped: $skipped"

# 2. skill symlinks
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

# 2b. project layer: the line "project: <path>" in the frontmatter of RULES.md and symlinks to its skills
if [ -n "$PROJECT" ]; then
  RULES="$DEST/RULES.md"
  cur=""
  if [ "$(head -n 1 "$RULES" | tr -d '\r')" = "---" ]; then
    cur=$(tr -d '\r' < "$RULES" | awk 'NR == 1 { next } $0 == "---" { exit } { print }' | sed -n 's/^project:[[:space:]]*//p' | head -n 1 | sed 's/[[:space:]]*$//')
  fi
  proj_ok=1
  if [ "$cur" = "$PROJECT" ]; then
    echo "Line project: $PROJECT already in agentic-brain/RULES.md"
  elif [ -n "$cur" ]; then
    echo "Skipped, agentic-brain/RULES.md already has project: $cur (not changed to $PROJECT), no project symlinks created"
    proj_ok=0
  else
    tmp=$(mktemp)
    if [ "$(head -n 1 "$RULES" | tr -d '\r')" = "---" ]; then
      { head -n 1 "$RULES"; printf 'project: %s\n' "$PROJECT"; tail -n +2 "$RULES"; } > "$tmp"
    else
      { printf -- '---\nproject: %s\n---\n' "$PROJECT"; cat "$RULES"; } > "$tmp"
    fi
    cat "$tmp" > "$RULES"; rm -f "$tmp"
    echo "Added line project: $PROJECT to the frontmatter of agentic-brain/RULES.md"
  fi
  if [ "$proj_ok" = 1 ]; then
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

# 3. .claude/settings.json
SETTINGS="$TARGET/.claude/settings.json"
if [ ! -e "$SETTINGS" ]; then
  mkdir -p "$TARGET/.claude"
  cat > "$SETTINGS" <<'EOT'
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$CLAUDE_PROJECT_DIR/agentic-brain/bin/repeat_guard.mjs\""
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
  cat <<'EOT'
      {
        "matcher": "Bash",
        "hooks": [
          { "type": "command", "command": "node \"$CLAUDE_PROJECT_DIR/agentic-brain/bin/repeat_guard.mjs\"" }
        ]
      }
EOT
fi

# 4. import line in CLAUDE.md and AGENTS.md
# CLAUDE.md gets the line first. A missing AGENTS.md is created as a copy of it,
# so both files are identical (check.sh requires this).
both_existed=0
[ -f "$TARGET/CLAUDE.md" ] && [ -f "$TARGET/AGENTS.md" ] && both_existed=1
for f in CLAUDE.md AGENTS.md; do
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
if [ "$both_existed" -eq 1 ] && ! cmp -s "$TARGET/CLAUDE.md" "$TARGET/AGENTS.md"; then
  echo "Warning: CLAUDE.md and AGENTS.md differ. check.sh requires identical content, make them the same."
fi

# 5. .gitignore
GI="$TARGET/.gitignore"
for line in "agentic-brain/scratch/*" "!agentic-brain/scratch/.gitkeep"; do
  if [ -f "$GI" ] && grep -qxF "$line" "$GI"; then continue; fi
  if [ -s "$GI" ] && [ -n "$(tail -c1 "$GI")" ]; then printf '\n' >> "$GI"; fi
  printf '%s\n' "$line" >> "$GI"
  echo "Added line to .gitignore: $line"
done

echo
echo "Done. Nothing was committed. Next, in the target repo:"
echo "  agentic-brain/bin/check.sh --install-hook"
echo "  agentic-brain/bin/check.sh"
exit 0
