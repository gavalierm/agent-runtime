#!/bin/bash
# Nasadí klon kódu agentov a klon spoločného mozgu na server. Spúšťa sa ako
# root z klonu kódu (koreň tohto repa je `dirname $0/../..`), opakované
# spustenie nič nepokazí. Skript nenesie mená: hodnoty nasadenia berie z
# `<spoločný mozog>/env/server/config.env` (vzor `config.env.example`):
#   RUNS_USER      používateľ behov správcu úloh (prázdny: len root)
#   GIT_EMAIL      e-mail autora commitov (inak commit_guard/git_email.txt mozgu)
#   ENV_ROOT       koreň stromu agentov (predvolene /root)
#   LEGACY_PATHS   cesty starých klonov, odkazy a importy z nich sa odstránia
#   LEGACY_UNITS   staré jednotky systemd, vypnú sa a zmažú
#
# Pre root a používateľa behov (vlastný ~/.claude):
#   - ~/.claude/CLAUDE.md je súbor s dvoma importmi, `@<kód>/RULES.md` a
#     `@<mozog>/RULES.md`; odkaz zo starej inštalácie sa odloží, súbor s inými
#     riadkami sa doplní
#   - skilly: odkazy na `<kód>/skills/*` aj `<mozog>/skills/*` (rovnaké meno v
#     oboch je chyba), agents/ a output-styles/ z klonu kódu
#   - settings.json cez env/hooks.mjs: `main` pre root, `runs` pre používateľa
#     behov; voliteľný `<mozog>/env/server/settings.base.json` doplní kľúče
#     mimo hookov (pluginy, jazyk), existujúca hodnota vyhráva
# $ENV_ROOT/CLAUDE.md a domov používateľa behov dostanú odkaz na
# `<mozog>/env/server/RULES.md`. Git: user.email, core.hooksPath klonu kódu,
# enable_repo_hooks.sh pod používateľom behov. Systemd: agentic-workflow-sync
# (.service a .timer, sync.sh ťahá oba klony).
#
# Pôvodný súbor alebo priečinok, ktorý nie je odkaz, skript presunie do
# <claude>/pred-odkazom, nezmaže ho. Odkaz do starého klonu odstráni.
#
# Premenné AR_CLAUDE_DIR (~/.claude rootu), AR_ENV_ROOT, AR_RUNS_HOME (domov
# používateľa behov, príkazy bežia pod volajúcim) a AR_UNIT_DIR menia cesty,
# používa ich test env/server/tests/test_install.sh. systemctl sa nevolá, keď
# je AR_NO_SYSTEMCTL=1, ani keď je AR_UNIT_DIR bez AR_SYSTEMCTL (príkaz
# namiesto systemctl, test dáva falošný).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORKFLOW="$(cd "$HERE/../.." && pwd)"
# shellcheck source=../../lib/paths.sh
. "$WORKFLOW/lib/paths.sh"
BRAIN="$(brain_global_dir)"
CONFIG="$BRAIN/env/server/config.env"

RUNS_USER="" GIT_EMAIL="" ENV_ROOT="" LEGACY_PATHS="" LEGACY_UNITS=""
if [ -r "$CONFIG" ]; then
    # shellcheck source=/dev/null
    . "$CONFIG"
fi
CLAUDE_DIR="${AR_CLAUDE_DIR:-${HOME:-/root}/.claude}"
UNIT_DIR="${AR_UNIT_DIR:-/etc/systemd/system}"
ENV_ROOT="${AR_ENV_ROOT:-${ENV_ROOT:-/root}}"
LIVE=1
if [ -n "${AR_CLAUDE_DIR:-}" ] || [ -n "${AR_UNIT_DIR:-}" ] || [ -n "${AR_ENV_ROOT:-}" ] || [ -n "${AR_RUNS_HOME:-}" ]; then LIVE=0; fi

for f in "$WORKFLOW/RULES.md" "$WORKFLOW/env/hooks.mjs" "$BRAIN/RULES.md" "$BRAIN/env/server/RULES.md"; do
    if [ ! -e "$f" ]; then
        echo "Chýba $f (klon kódu alebo spoločný mozog)." >&2
        exit 1
    fi
done
if [ ! -d "$WORKFLOW/hooks" ]; then
    echo "V klone kódu chýba $WORKFLOW/hooks." >&2
    exit 1
fi

# Používateľ behov: domov z AR_RUNS_HOME (test, príkazy pod volajúcim), inak z
# passwd a príkazy idú cez runuser.
RUNS_HOME="${AR_RUNS_HOME:-}"
AS=()
if [ -n "$RUNS_USER" ] && [ -z "$RUNS_HOME" ]; then
    if [ "$LIVE" = 1 ] && id "$RUNS_USER" >/dev/null 2>&1; then
        RUNS_HOME="$(getent passwd "$RUNS_USER" | cut -d: -f6)"
        AS=(runuser -u "$RUNS_USER" --)
    else
        echo "Používateľ behov $RUNS_USER neexistuje, preskočený." >&2
    fi
fi
[ -n "$RUNS_USER" ] || RUNS_HOME=""

# ex root|runs príkaz...: príkaz pod rootom, alebo pod používateľom behov
ex() {
    local who="$1"
    shift
    if [ "$who" = runs ] && [ "${#AS[@]}" -gt 0 ]; then "${AS[@]}" "$@"; else "$@"; fi
}

KEEP=""
# park cesta: nie odkaz sa odloží do $KEEP, nezmaže sa
park() {
    local who="$1" l="$2" dest
    dest="$KEEP/$(basename "$l")"
    if [ -e "$dest" ] || [ -L "$dest" ]; then dest="$dest.$(date +%Y%m%d%H%M%S)"; fi
    ex "$who" install -d -m 700 "$KEEP"
    ex "$who" mv "$l" "$dest"
}

# link kto cieľ odkaz: odkaz na súbor v klone, pôvodný stav odloží
link() {
    local who="$1" target="$2" l="$3"
    if [ ! -e "$target" ]; then
        echo "Chýba $target." >&2
        exit 1
    fi
    if [ -e "$l" ] && [ ! -L "$l" ]; then park "$who" "$l"; fi
    ex "$who" ln -sfn "$target" "$l"
}

# legacy_target cieľ: ukazuje odkaz do starého klonu?
legacy_target() {
    local p
    for p in $LEGACY_PATHS; do
        case "$1" in "$p" | "$p"/*) return 0 ;; esac
    done
    return 1
}

# prune kto priečinok: odstráni odkaz do starého klonu a mŕtvy odkaz do klonov
prune() {
    local who="$1" l t
    for l in "$2"/*; do
        [ -L "$l" ] || continue
        t="$(readlink "$l")"
        if legacy_target "$t"; then
            ex "$who" rm "$l"
            continue
        fi
        case "$t" in
            "$WORKFLOW"/* | "$BRAIN"/*) [ -e "$l" ] || ex "$who" rm "$l" ;;
        esac
    done
}

# imports kto súbor: súbor s dvoma importmi pravidiel. Odkaz sa odloží, cudzie
# riadky ostanú, importy zo starých klonov zmiznú, chýbajúce importy sa pridajú.
imports() {
    local who="$1" file="$2" cur="" out="" line drop p w
    if [ -L "$file" ]; then
        ex "$who" install -d -m 700 "$KEEP"
        if [ ! -e "$KEEP/$(basename "$file")" ] && [ ! -L "$KEEP/$(basename "$file")" ]; then
            ex "$who" mv "$file" "$KEEP/"
        else
            ex "$who" rm "$file"
        fi
    fi
    [ -f "$file" ] && cur="$(cat "$file")"
    if [ -n "$cur" ]; then
        while IFS= read -r line || [ -n "$line" ]; do
            drop=0
            for p in $LEGACY_PATHS; do
                case "$line" in "@$p" | "@$p"/*) drop=1 ;; esac
            done
            [ "$drop" = 1 ] || out+="$line"$'\n'
        done <<< "$cur"
    fi
    for w in "@$WORKFLOW/RULES.md" "@$BRAIN/RULES.md"; do
        printf '%s' "$out" | grep -qxF -- "$w" || out+="$w"$'\n'
    done
    if [ "$out" != "$cur"$'\n' ] || [ ! -f "$file" ]; then
        printf '%s' "$out" | ex "$who" tee "$file" >/dev/null
    fi
}

# Zdroje skillov: kód a mozog. Rovnaké meno v oboch je chyba.
declare -A SKILL_SRC=()
for root in "$WORKFLOW" "$BRAIN"; do
    for d in "$root"/skills/*/; do
        [ -f "${d}SKILL.md" ] || continue
        d="${d%/}"
        n="$(basename "$d")"
        if [ -n "${SKILL_SRC[$n]:-}" ]; then
            echo "Skill $n je v $(dirname "$(dirname "${SKILL_SRC[$n]}")") aj v $root (kolízia mena)." >&2
            exit 1
        fi
        SKILL_SRC[$n]="$d"
    done
done

# deploy_claude kto priečinok-claude: CLAUDE.md, skilly, agents, output-styles
deploy_claude() {
    local who="$1" dir="$2" n f
    KEEP="$dir/pred-odkazom"
    ex "$who" install -d -m 700 "$dir" "$dir/skills" "$dir/agents" "$dir/output-styles"
    imports "$who" "$dir/CLAUDE.md"
    for n in "${!SKILL_SRC[@]}"; do link "$who" "${SKILL_SRC[$n]}" "$dir/skills/$n"; done
    for f in "$WORKFLOW"/agents/*.md; do
        [ -f "$f" ] && link "$who" "$f" "$dir/agents/$(basename "$f")"
    done
    for f in "$WORKFLOW"/output-styles/*.md; do
        [ -f "$f" ] && link "$who" "$f" "$dir/output-styles/$(basename "$f")"
    done
    prune "$who" "$dir/skills"
    prune "$who" "$dir/agents"
    prune "$who" "$dir/output-styles"
}

settings_main() {
    local base=()
    [ -r "$BRAIN/env/server/settings.base.json" ] && base=(--base "$BRAIN/env/server/settings.base.json")
    node "$WORKFLOW/env/hooks.mjs" apply main "$CLAUDE_DIR/settings.json" ${base[@]+"${base[@]}"}
}

# Root
deploy_claude root "$CLAUDE_DIR"
# Pravidlá prostredia: CLAUDE.md v koreni stromu, pod ktorým agenti bežia,
# Claude Code ho načíta z každého rodiča cwd.
KEEP="$CLAUDE_DIR/pred-odkazom"
# Existujúci koreň nemení: /root má 711, aby používateľ behov prešiel do
# /root/<agent> (29. 10. 2026 install -d -m 700 dal /root 700, strážca agenta
# padal 203/EXEC). Režim 700 dostane len nový koreň.
[ -d "$ENV_ROOT" ] || install -d -m 700 "$ENV_ROOT"
link root "$BRAIN/env/server/RULES.md" "$ENV_ROOT/CLAUDE.md"
settings_main

# Používateľ behov: vlastný ~/.claude a domov
if [ -n "$RUNS_HOME" ]; then
    deploy_claude runs "$RUNS_HOME/.claude"
    KEEP="$RUNS_HOME/.claude/pred-odkazom"
    link runs "$BRAIN/env/server/RULES.md" "$RUNS_HOME/CLAUDE.md"
    ex runs node "$WORKFLOW/env/hooks.mjs" apply runs "$RUNS_HOME/.claude/settings.json"
fi

# Git: e-mail autora commitov a globálne hooky. Hook commit-msg odmietne iný
# e-mail (lib/commit_guard.sh), globálny hook potom spustí lokálny hook repa.
# Používateľ behov globálny hooksPath nedostane (klony projektov majú iné
# user.name), zapne sa len lokálne v klonoch z repo_authors.txt mozgu.
if [ -z "$GIT_EMAIL" ] && [ -r "$BRAIN/commit_guard/git_email.txt" ]; then
    GIT_EMAIL="$(tr -d '[:space:]' < "$BRAIN/commit_guard/git_email.txt")"
fi
if [ "$LIVE" = 1 ] || [ -n "${GIT_CONFIG_GLOBAL:-}" ]; then
    if [ -n "$GIT_EMAIL" ]; then
        git config --global user.email "$GIT_EMAIL"
    else
        echo "GIT_EMAIL nie je v $CONFIG ani v commit_guard/git_email.txt mozgu, e-mail nenastavený." >&2
    fi
    git config --global core.hooksPath "$WORKFLOW/git-hooks/global"
fi
if [ -n "$RUNS_HOME" ]; then
    ex runs bash "$WORKFLOW/git-hooks/enable_repo_hooks.sh" "$RUNS_HOME" "$WORKFLOW/git-hooks/global"
fi

# Systemd: sync klonov. Šablóna nesie @WORKFLOW@ a @BRAIN@ namiesto ciest.
SYSTEMCTL=(systemctl)
if [ "${AR_NO_SYSTEMCTL:-}" = 1 ]; then
    SYSTEMCTL=()
elif [ -n "${AR_SYSTEMCTL:-}" ]; then
    SYSTEMCTL=("$AR_SYSTEMCTL")
elif [ -n "${AR_UNIT_DIR:-}" ]; then
    SYSTEMCTL=()
fi
sc() {
    if [ "${#SYSTEMCTL[@]}" -gt 0 ]; then "${SYSTEMCTL[@]}" "$@" || true; fi
}

install -d -m 755 "$UNIT_DIR"
for u in $LEGACY_UNITS; do
    sc disable --now "$u" 2>/dev/null
    rm -f "$UNIT_DIR/$u"
done
for u in agentic-workflow-sync.service agentic-workflow-sync.timer; do
    sed -e "s|@WORKFLOW@|$WORKFLOW|g" -e "s|@BRAIN@|$BRAIN|g" "$HERE/systemd/$u" > "$UNIT_DIR/$u"
    chmod 644 "$UNIT_DIR/$u"
done
sc daemon-reload
sc enable --now agentic-workflow-sync.timer
echo "Nasadené: kód $WORKFLOW, mozog $BRAIN."
