# agent_name.sh: meno agenta pre shellové skripty. Načíta sa príkazom `source`,
# nemení voľby shellu ani premenné a sama nič nevypíše.
#
# Používajú ju bin/tk, bin/ask_agent.sh, bin/rozhodni.sh a reply.sh. Vlákno T3
# agenta nemá AGENT_NAME ani TASKER_USER, meno nesie len persona (PERSONA.md,
# prvý riadok `# Meno`), preto skripty, ktoré chceli len AGENT_NAME, v ňom
# padali (regresia úlohy 665: starý obal meno z persony odvodil, nový kód nie).
# Persona sa hľadá ako v lib/agent_name.mjs pre hooky (CLAUDE_PROJECT_DIR),
# navyše v PWD a jeho rodičoch, aby meno našiel aj worktree a podpriečinok
# klonu agenta. Poradie premenných je tu AGENT_NAME pred TASKER_USER, v .mjs
# je opačné; keď sú obe nastavené, nesú to isté meno.
#
#   agent_name           vypíše meno malými písmenami, zlyhá kódom 1 a nič
#                        nevypíše, keď meno chýba alebo nevyhovuje
#                        ^[a-z0-9_-]+$
#   agent_name_capital   to isté s veľkým prvým písmenom (napríklad Delta)
#
# Poradie: AGENT_NAME, TASKER_USER, PERSONA.md v CLAUDE_PROJECT_DIR, PERSONA.md
# v PWD a jeho rodičoch po koreň (prvá, ktorá nesie `# Meno`). Prvý zdroj
# s hodnotou rozhoduje, neplatná hodnota nepadá na ďalší zdroj.

# Prvý riadok `# Meno` z PERSONA.md v priečinku $1, inak kód 1.
_agent_name_persona() {
    local f="$1/PERSONA.md" line
    [ -f "$f" ] || return 1
    while IFS= read -r line || [ -n "$line" ]; do
        if [[ "$line" == "# "* ]]; then
            line="${line#"# "}"
            line="${line%"${line##*[![:space:]]}"}"
            [ -n "$line" ] || return 1
            printf '%s' "$line"
            return 0
        fi
    done <"$f"
    return 1
}

agent_name() {
    local raw="" dir
    if [ -n "${AGENT_NAME:-}" ]; then raw="$AGENT_NAME"
    elif [ -n "${TASKER_USER:-}" ]; then raw="$TASKER_USER"
    else
        if [ -n "${CLAUDE_PROJECT_DIR:-}" ]; then
            raw="$(_agent_name_persona "$CLAUDE_PROJECT_DIR")" || raw=""
        fi
        if [ -z "$raw" ]; then
            dir="${PWD:-$(pwd)}"
            while :; do
                raw="$(_agent_name_persona "$dir")" && break
                raw=""
                if [ "$dir" = / ] || [ -z "$dir" ]; then break; fi
                dir="$(dirname "$dir")"
            done
        fi
    fi
    [ -n "$raw" ] || return 1
    raw="$(printf '%s' "$raw" | tr '[:upper:]' '[:lower:]')"
    [[ "$raw" =~ ^[a-z0-9_-]+$ ]] || return 1
    printf '%s' "$raw"
}

agent_name_capital() {
    local n
    n="$(agent_name)" || return 1
    printf '%s%s' "$(printf '%s' "${n:0:1}" | tr '[:lower:]' '[:upper:]')" "${n:1}"
}
