#!/usr/bin/env bash
# Builds the rolled-out layout of the template for the tests: a folder with agentic-brain/
# (brain/ of this repo plus the skills error and task-end from skills/ of this repo),
# CLAUDE.md and AGENTS.md. Sourced by check.test.sh, adopt.test.sh and install.test.sh.
# Use: . "$HERE/template.sh"; SRC=$(build_template "$TMP/template")
REPO=$(cd "$HERE/../.." && pwd -P)

build_template() { # destination folder, printed on stdout
  local d=$1 s
  mkdir -p "$d/agentic-brain/skills"
  cp -a "$REPO/brain/." "$d/agentic-brain/"
  for s in error task-end; do
    cp -a "$REPO/skills/$s" "$d/agentic-brain/skills/$s"
  done
  printf '@agentic-brain/RULES.md\n' > "$d/CLAUDE.md"
  cp "$d/CLAUDE.md" "$d/AGENTS.md"
  mkdir -p "$d/.claude/skills"
  cp "$HERE/fixtures/settings.json" "$d/.claude/settings.json"
  cp "$HERE/fixtures/template-ignore" "$d/.gitignore"
  for s in error task-end; do
    ln -s "../../agentic-brain/skills/$s" "$d/.claude/skills/$s"
  done
  printf '%s\n' "$d"
}
