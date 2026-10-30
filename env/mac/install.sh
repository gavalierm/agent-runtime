#!/bin/bash
# install.sh — nasadí klon kódu agentov a klon spoločného mozgu na Mac do
# ~/.claude a ~/Work. Spúšťa sa z klonu kódu (koreň tohto repa je
# `dirname $0/../..`), klon mozgu je brain_global_dir z lib/paths.sh.
# Idempotentné. Veci agenta (pamäť, watchdog, launchd, jeho skilly) nasadzuje
# install.sh v repe agenta. Skript nenesie mená: hodnoty nasadenia berie z
# `<mozog>/env/mac/config.env` (voliteľný, shell KEY=hodnota):
#   GIT_EMAIL      e-mail autora commitov (inak commit_guard/git_email.txt mozgu)
#   LEGACY_PATHS   cesty starých klonov (oddelené medzerou), odkazy a importy
#                  z nich sa odstránia
#
#   ~/.claude/CLAUDE.md          súbor s dvoma importmi, @<kód>/RULES.md a
#                                @<mozog>/RULES.md; odkaz zo starej inštalácie
#                                sa zálohuje, súbor s inými riadkami sa doplní
#   ~/Work/CLAUDE.md             symlink na <mozog>/env/mac/RULES.md
#   skills                       symlinky na <kód>/skills/* aj <mozog>/skills/*
#                                (rovnaké meno v oboch je chyba)
#   agents/<meno>.md             symlink ~/.claude/agents/<meno>.md
#   output-styles/<meno>.md      symlink ~/.claude/output-styles/<meno>.md
#   ~/.claude/settings.json      hooky z env/hooks.mjs (druh mac) zlúčené do
#                                živého súboru, ostatné kľúče ostanú;
#                                voliteľný <mozog>/env/mac/settings.base.json
#                                doplní kľúče mimo hookov (pluginy, jazyk),
#                                existujúca hodnota vyhráva
#   env/mac/gitignore            git config --global core.excludesfile
#   pluginové skilly             disable-model-invocation: true v cache pluginov,
#                                pluginom z MODEL_PLUGINS ho odoberie
#
# Čo nahrádza, zálohuje do $AR_BACKUPS (predvolene scratch/backups v klone
# kódu, mimo gitu). Na konci spustí check.mjs (AR_NO_CHECK=1 ho vynechá, test).
# Premenné AR_BACKUPS a AR_NO_CHECK používa test env/mac/install.test.sh,
# ostatné cesty idú z HOME a AGENT_BRAIN_GLOBAL.

set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
# shellcheck source=../../lib/paths.sh
. "$REPO/lib/paths.sh"
BRAIN="$(brain_global_dir)"
# hooks.mjs berie cestu mozgu pre --allow hooku repeat_guard z tejto premennej
export AGENT_BRAIN_GLOBAL="$BRAIN"
BACKUPS="${AR_BACKUPS:-$REPO/scratch/backups}"
TS="$(date +%Y%m%d_%H%M%S)"
CLAUDE="$HOME/.claude"

GIT_EMAIL="" LEGACY_PATHS=""
if [ -r "$BRAIN/env/mac/config.env" ]; then
  # shellcheck source=/dev/null
  . "$BRAIN/env/mac/config.env"
fi
if [ -z "$GIT_EMAIL" ] && [ -r "$BRAIN/commit_guard/git_email.txt" ]; then
  GIT_EMAIL="$(tr -d '[:space:]' < "$BRAIN/commit_guard/git_email.txt")"
fi

for f in "$REPO/RULES.md" "$REPO/env/hooks.mjs" "$BRAIN/RULES.md" "$BRAIN/env/mac/RULES.md"; do
  if [ ! -e "$f" ]; then
    echo "chýba $f (klon kódu alebo spoločný mozog, AGENT_WORKFLOW a AGENT_BRAIN_GLOBAL menia cesty)" >&2
    exit 1
  fi
done

backup() {
  mkdir -p "$BACKUPS"
  local dst n=1
  dst="$BACKUPS/$(basename "$1").$TS"
  while [ -e "$dst" ] || [ -L "$dst" ]; do
    dst="$BACKUPS/$(basename "$1").$TS.$n"
    n=$((n + 1))
  done
  mv "$1" "$dst"
  echo "záloha: $1 → $dst"
}

legacy_target() { # legacy_target <cieľ>: ukazuje do starého klonu?
  local p
  for p in $LEGACY_PATHS; do
    case "$1" in "$p" | "$p"/*) return 0 ;; esac
  done
  return 1
}

link() { # link <cieľ> <symlink>
  local target="$1" link="$2"
  if [ ! -e "$target" ]; then
    echo "chýba $target" >&2
    exit 1
  fi
  if [ -L "$link" ]; then
    [ "$(readlink "$link")" = "$target" ] && return
    rm "$link"
  elif [ -e "$link" ]; then
    if cmp -s "$link" "$target" 2>/dev/null; then rm "$link"; else backup "$link"; fi
  fi
  ln -s "$target" "$link"
  echo "link: $link → $target"
}

prune() { # prune <priečinok>: odstráni odkaz do starého klonu a mŕtvy odkaz do klonov
  local l t
  for l in "$1"/*; do
    [ -L "$l" ] || continue
    t="$(readlink "$l")"
    if legacy_target "$t"; then
      rm "$l"
      echo "odstránený starý link: $l"
      continue
    fi
    case "$t" in
      "$REPO"/* | "$BRAIN"/*) [ -e "$l" ] || { rm "$l"; echo "odstránený mŕtvy link: $l"; } ;;
    esac
  done
}

imports() { # imports <súbor>: dva importy pravidiel, cudzie riadky ostanú
  local file="$1" cur="" out="" line drop p w
  if [ -L "$file" ]; then backup "$file"; fi
  if [ -f "$file" ]; then cur="$(cat "$file")"; fi
  if [ -n "$cur" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      drop=0
      for p in $LEGACY_PATHS; do
        case "$line" in "@$p" | "@$p"/*) drop=1 ;; esac
      done
      [ "$drop" = 1 ] || out="$out$line"$'\n'
    done <<< "$cur"
  fi
  for w in "@$REPO/RULES.md" "@$BRAIN/RULES.md"; do
    printf '%s' "$out" | grep -qxF -- "$w" || out="$out$w"$'\n'
  done
  if [ ! -f "$file" ] || [ "$out" != "$cur"$'\n' ]; then
    printf '%s' "$out" > "$file"
    echo "CLAUDE.md: $file"
  fi
}

mkdir -p "$CLAUDE/skills" "$CLAUDE/agents" "$CLAUDE/output-styles" "$HOME/Work"

imports "$CLAUDE/CLAUDE.md"
link "$BRAIN/env/mac/RULES.md" "$HOME/Work/CLAUDE.md"

# Skilly z klonu kódu a z mozgu; rovnaké meno v oboch je chyba.
for d in "$REPO"/skills/*/; do
  [ -f "${d}SKILL.md" ] || continue
  n="$(basename "$d")"
  if [ -f "$BRAIN/skills/$n/SKILL.md" ]; then
    echo "skill $n je v klone kódu aj v mozgu (kolízia mena)" >&2
    exit 1
  fi
  link "$REPO/skills/$n" "$CLAUDE/skills/$n"
done
for d in "$BRAIN"/skills/*/; do
  [ -f "${d}SKILL.md" ] || continue
  n="$(basename "$d")"
  link "${d%/}" "$CLAUDE/skills/$n"
done
prune "$CLAUDE/skills"

for f in "$REPO"/agents/*.md; do
  [ -f "$f" ] || continue
  link "$f" "$CLAUDE/agents/$(basename "$f")"
done
prune "$CLAUDE/agents"

for f in "$REPO"/output-styles/*.md; do
  [ -f "$f" ] || continue
  link "$f" "$CLAUDE/output-styles/$(basename "$f")"
done
prune "$CLAUDE/output-styles"

# settings.json: hooky z tabuľky env/hooks.mjs, ostatné kľúče živého súboru ostanú.
base=()
[ -r "$BRAIN/env/mac/settings.base.json" ] && base=(--base "$BRAIN/env/mac/settings.base.json")
node "$REPO/env/hooks.mjs" apply mac "$CLAUDE/settings.json" ${base[@]+"${base[@]}"}

git config --global core.excludesfile "$REPO/env/mac/gitignore"
# E-mail autora commitov (lib/commit_guard.sh).
if [ -n "$GIT_EMAIL" ]; then
  git config --global user.email "$GIT_EMAIL"
else
  echo "GIT_EMAIL nie je v $BRAIN/env/mac/config.env ani v commit_guard/git_email.txt mozgu, e-mail nenastavený" >&2
fi
if [ -d "$REPO/.githooks" ] && [ -e "$REPO/.git" ]; then git -C "$REPO" config core.hooksPath .githooks; fi
chmod +x "$REPO"/hooks/*.mjs "$REPO/check.mjs" "$REPO/lib/plugin_skills_user_only.mjs"

node "$REPO/lib/plugin_skills_user_only.mjs"
if [ "${AR_NO_CHECK:-}" != 1 ]; then node "$REPO/check.mjs"; fi
