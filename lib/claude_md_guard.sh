#!/bin/bash
# Kontrola CLAUDE.md, PERSONA.md, RULES.md agenta a značiek konfliktu v indexe commitu
# (audit T3, úloha 612, krok 2, úloha 621, úloha 681). Volá ju hook pre-commit repa
# pravidiel a repí agentov. Kód 0 commit pustí, 1 odmietne.
#
# Pre každý pridaný alebo zmenený súbor v indexe:
#  - súbor s menom CLAUDE.md má najviac 200 riadkov, rovnako RULES.md, ktorý má
#    v indexe vedľa seba PERSONA.md (tvar D0197: prevádzkový text agenta je v RULES.md);
#    RULES.md bez PERSONA.md vedľa (projekt, repo kódu) ostáva bez tejto kontroly,
#  - CLAUDE.md, PERSONA.md a RULES.md vedľa PERSONA.md nenesú odsek "Chyba <dátum>": chyba
#    agenta žije v registri (skill error, skills/error/scripts/error.sh), do súboru ide len pravidlo,
#  - textový súbor nemá riadok začínajúci značkou konfliktu.
#
# Výnimka len s dôvodom: CLAUDE_MD_GUARD_SKIP="<dôvod>" git commit ...
# Dôvod sa vypíše, prázdna hodnota výnimkou nie je.
#
# Premenná testu: CLAUDE_MD_GUARD_MAX_LINES (predvolené 200).
set -u

# shellcheck source=deny.sh
source "$(dirname "${BASH_SOURCE[0]}")/deny.sh"
max="${CLAUDE_MD_GUARD_MAX_LINES:-200}"

if [ -n "${CLAUDE_MD_GUARD_SKIP:-}" ]; then
    echo "claude_md_guard: výnimka, dôvod: $CLAUDE_MD_GUARD_SKIP" >&2 # info
    exit 0
fi

cd "$(git rev-parse --show-toplevel)" || exit 1

status=0
while IFS= read -r -d '' f; do
    base="${f##*/}"
    # Binárny súbor (numstat "-") nemá riadky ani značky, null bajt by bash hlásil.
    case "$(git diff --cached --numstat -- "$f")" in -*) continue ;; esac
    content="$(git show ":$f" 2>/dev/null; printf x)"
    content="${content%x}"

    # RULES.md je pravidlový súbor agenta len s PERSONA.md vedľa seba v indexe.
    rules=0
    if [ "$base" = "RULES.md" ]; then
        dir="${f%/*}"
        [ "$dir" = "$f" ] && persona="PERSONA.md" || persona="$dir/PERSONA.md"
        git cat-file -e ":$persona" 2>/dev/null && rules=1
    fi

    if [ "$base" = "CLAUDE.md" ] || [ "$rules" = 1 ]; then
        lines="$(printf '%s' "$content" | awk 'END { print NR }')"
        if [ "$lines" -gt "$max" ]; then
            deny_postup "Commit odmietnutý: $f má $lines riadkov, strop je $max." \
                "skráť $f pod $max riadkov: postup s krokmi daj do skillu (skills/<meno>/SKILL.md), fakt do README repa, ktorý ho drží, a pravidlo nechaj jednou vetou."
            status=1
        fi
    fi

    if [ "$base" = "CLAUDE.md" ] || [ "$base" = "PERSONA.md" ] || [ "$rules" = 1 ]; then
        hit="$(printf '%s' "$content" | grep -nE 'Chyba [0-9]|chyba [0-9]+\. [0-9]+\. 20[0-9][0-9]' | head -n 1)"
        if [ -n "$hit" ]; then
            deny_postup "Commit odmietnutý: $f nesie chybu s dátumom (riadok ${hit%%:*})." \
                "chybu zapíš skriptom skills/error/scripts/error.sh (skill error) a do $f daj len pravidlo bez dátumu, čísla úlohy a príbehu."
            status=1
        fi
    fi

    if printf '%s' "$content" | grep -Iq -e '^<<<<<<<' -e '^>>>>>>>'; then
        deny_postup "Commit odmietnutý: $f nesie značku konfliktu." \
            "vyrieš konflikt v $f, odstráň riadky so značkami <<<<<<< a >>>>>>> a pridaj súbor do indexu znova."
        status=1
    fi
done < <(git diff --cached --name-only -z --diff-filter=AM)

exit "$status"
