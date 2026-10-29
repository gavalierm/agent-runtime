#!/usr/bin/env bash
# Installation of the brain.
#
#   install.sh           project layer in this repo: skill symlinks
#                        in .claude/skills and the pre-commit hook
#   install.sh --global  this repo is a clone of the global brain (~/agentic-brain):
#                        adds an import of RULES.md to ~/.claude/CLAUDE.md and
#                        puts symlinks to the skills in ~/.claude/skills
#
# The script is idempotent. The target of the global installation is $HOME/.claude.
set -u

SELF_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
BRAIN=$(cd "$SELF_DIR/.." && pwd -P)

install_project() {
  local rc=0
  bash "$BRAIN/bin/check.sh" || rc=1
  bash "$BRAIN/bin/check.sh" --install-hook || rc=1
  return "$rc"
}

install_global() {
  local home claude imp rel_path link name d cur
  home=${HOME:-}
  if [ -z "$home" ] || [ ! -d "$home" ]; then
    echo "HOME is not set or does not exist" >&2
    return 1
  fi
  home=$(cd "$home" && pwd -P)
  claude="$home/.claude"
  mkdir -p "$claude/skills"

  # import of RULES.md in ~/.claude/CLAUDE.md, path with ~ when the brain is under HOME
  case "$BRAIN" in
    "$home"/*) rel_path="~/${BRAIN#"$home"/}" ;;
    *) rel_path=$BRAIN ;;
  esac
  imp="@$rel_path/RULES.md"
  if [ -f "$claude/CLAUDE.md" ] && grep -qxF "$imp" "$claude/CLAUDE.md"; then
    echo "Import already present: $imp"
  else
    if [ -s "$claude/CLAUDE.md" ] && [ -n "$(tail -c1 "$claude/CLAUDE.md")" ]; then
      printf '\n' >> "$claude/CLAUDE.md"
    fi
    printf '%s\n' "$imp" >> "$claude/CLAUDE.md"
    echo "Added import to $claude/CLAUDE.md: $imp"
  fi

  # skill symlinks
  for d in "$BRAIN"/skills/*/; do
    [ -d "$d" ] || continue
    name=$(basename "$d")
    link="$claude/skills/$name"
    if [ -L "$link" ]; then
      cur=$(readlink "$link")
      if [ "$cur" = "$BRAIN/skills/$name" ]; then
        echo "Symlink already present: $link"
      else
        echo "Skipped, foreign symlink: $link points to $cur"
      fi
    elif [ -e "$link" ]; then
      echo "Skipped, a file or folder is in the way: $link"
    else
      ln -s "$BRAIN/skills/$name" "$link"
      echo "Created symlink: $link"
    fi
  done
  return 0
}

case "${1:-}" in
  "") install_project ;;
  --global) install_global ;;
  *) echo "Usage: install.sh [--global]" >&2; exit 2 ;;
esac
