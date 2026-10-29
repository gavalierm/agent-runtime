#!/bin/bash
# chyba.sh — uznaná chyba agenta (D0142, úloha Taskera 426).
#
#   chyba.sh --trieda <trieda> --subor <súbor, ktorý správanie riadi> [--popis "<čo som tvrdil alebo urobil>"]
#            [--pravda "<čo bola pravda>"] [--kontrola "<hook alebo test, ktorý to zastaví>"]
#            --mechanizmus <hook:<cesta>|test:<cesta>|deny:<vzor>|rozhodnutie:D<nnnn>>
#   chyba.sh --otvorene
#
# Zapíše chybu do registra (dátum, agent, trieda, súbor, commit, popis, úloha, mechanizmus),
# pri druhom výskyte tej istej triedy toho istého agenta založí v Taskeri úlohu
# na kontrolu (projekt agenti, riešiteľ $CHYBA_REVIEWER) a vypíše hlásenie pre operátora
# v štyroch vetách. Agent dodá triedu, súbor a mechanizmus.
#
# Register je jediné miesto chyby (úloha 613): chyba sa nezapisuje ako odsek
# "Chyba <dátum>" do CLAUDE.md ani PERSONA.md, hook own_rule_scope.mjs taký zápis
# zamietne. Stĺpce TSV: 1 dátum, 2 agent, 3 trieda, 4 súbor, 5 commit, 6 popis,
# 7 úloha, 8 mechanizmus (povinná voľba --mechanizmus, tvar hook:<cesta>,
# test:<cesta>, deny:<vzor> alebo rozhodnutie:D<nnnn>; bez nej alebo s iným
# tvarom skript skončí kódom 1 a nič nezapíše). Staršie riadky bez 8. stĺpca sú
# otvorené chyby: --otvorene ich vypíše (dátum, agent, trieda, súbor), nič nezapíše.
#
# Prostredie:
#   CHYBA_AGENT     meno agenta, inak AGENT_NAME, TASKER_USER, inak "# Meno" z PERSONA.md
#                   v CLAUDE_PROJECT_DIR alebo v pracovnom priečinku
#   CHYBA_REVIEWER  agent, ktorému sa založí úloha na kontrolu, inak spravca-agentov
#   CHYBA_TASKER_USER  používateľ správcu úloh na serveri, inak tasker
#   CHYBA_REGISTER  súbor registra, inak ~/.local/state/agentic-workflow/chyby.tsv
#   CHYBA_TASKER    príkaz Taskera (rozdelí sa na slová), inak obal bin/tk tohto
#                   repa. Test ho nahradí falošným. Bez dosiahnuteľného Taskera
#                   (Mac) skript úlohu nezaloží a povie to na stderr.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/deny.sh
. "$HERE/../lib/deny.sh"

trieda="" subor="" popis="" pravda="" kontrola="" mechanizmus="" otvorene=""
while [ $# -gt 0 ]; do
    case "$1" in
        --trieda) trieda="${2:-}"; shift 2 ;;
        --subor) subor="${2:-}"; shift 2 ;;
        --popis) popis="${2:-}"; shift 2 ;;
        --pravda) pravda="${2:-}"; shift 2 ;;
        --kontrola) kontrola="${2:-}"; shift 2 ;;
        --mechanizmus) mechanizmus="${2:-}"; shift 2 ;;
        --otvorene) otvorene=1; shift ;;
        *) echo "chyba.sh: neznáma voľba $1" >&2; exit 64 ;;
    esac
done
reg="${CHYBA_REGISTER:-$HOME/.local/state/agentic-workflow/chyby.tsv}"
if [ -n "$otvorene" ]; then
    # Riadky bez 8. stĺpca: chyba bez mechanizmu. Register sa nemení.
    [ -f "$reg" ] && awk -F'\t' '$8 == "" { print $1 "\t" $2 "\t" $3 "\t" $4 }' "$reg"
    exit 0
fi
agent="${CHYBA_AGENT:-${AGENT_NAME:-${TASKER_USER:-}}}"
# Vlákno T3 agenta nemá AGENT_NAME ani TASKER_USER, meno nesie "# Meno" v PERSONA.md projektu.
if [ -z "$agent" ]; then
    persona="${CLAUDE_PROJECT_DIR:-$PWD}/PERSONA.md"
    [ -f "$persona" ] && agent="$(sed -n 's/^# \(.*\)$/\1/p' "$persona" | head -n1 | tr '[:upper:]' '[:lower:]')"
fi
trim() { local v="$1"; v="${v//$'\t'/ }"; v="${v//$'\n'/ }"; printf '%s' "$v"; }
trieda="$(trim "$trieda")"; popis="$(trim "$popis")"; pravda="$(trim "$pravda")"; kontrola="$(trim "$kontrola")"
mechanizmus="$(trim "$mechanizmus")"
if ! [[ "$mechanizmus" =~ ^((hook|test):[^[:space:]]+|deny:.+|rozhodnutie:D[0-9]{4})$ ]]; then
    deny_postup "chýba mechanizmus, ktorý chybu nabudúce zastaví, alebo má zlý tvar: '$mechanizmus'" "chyba.sh --trieda <trieda> --subor <súbor s opravou> --mechanizmus <hook|test|deny|rozhodnutie>:<cesta alebo id>, napríklad --mechanizmus hook:hooks/own_rule_scope.mjs, test:test/chyba.test.mjs, deny:<vzor> alebo rozhodnutie:D0183"; exit 1
fi

if [ -z "$agent" ]; then
    deny_postup "chyba.sh nevie, ktorý agent chybu uznal" "nastav CHYBA_AGENT=<meno> alebo spusti skript v projekte agenta s PERSONA.md"; exit 64
fi
if [ -z "$trieda" ] || [ -z "$subor" ]; then
    deny_postup "chýba trieda alebo súbor" "chyba.sh --trieda <krátky kľúč triedy, napríklad todo-po-komentari> --subor <PERSONA.md, CLAUDE.md alebo hook, ktorý správanie riadi>"; exit 64
fi
if [ ! -f "$subor" ]; then
    deny_postup "súbor $subor neexistuje" "zadaj cestu k súboru, ktorý správanie riadi (PERSONA.md, CLAUDE.md, hook, check.mjs)"; exit 64
fi
dir="$(dirname "$subor")"
subor="$(cd "$dir" && pwd)/$(basename "$subor")" # git -C $dir by relatívnu cestu nenašiel, commit ostal prázdny
if ! git -C "$dir" rev-parse --git-dir >/dev/null 2>&1 || [ -n "$(git -C "$dir" status --porcelain -- "$subor" 2>/dev/null)" ]; then
    deny_postup "súbor $subor nie je commitnutý, hlásenie by nemalo číslo commitu opravy" "oprav súbor, \`git add $subor\`, \`git commit -m \"...\" -- $subor\`, \`git push\` a spusti chyba.sh znova"; exit 1
fi
commit="$(git -C "$dir" log -1 --format=%h -- "$subor")"

reviewer="${CHYBA_REVIEWER:-spravca-agentov}"
mkdir -p "$(dirname "$reg")"
touch "$reg"
datum="$(date +%F)"
# Stĺpce: dátum, agent, trieda, súbor, commit, popis, úloha, mechanizmus. Prázdne
# stĺpce sa nesmú zlúčiť (read s tabulátorom ich zlučuje), preto awk.
pocet="$(awk -F'\t' -v a="$agent" -v t="$trieda" '$2 == a && $3 == t { n++ } END { print n + 0 }' "$reg")"
uloha="$(awk -F'\t' -v a="$agent" -v t="$trieda" '$2 == a && $3 == t && $7 != "" { u = $7 } END { print u }' "$reg")"
pocet=$((pocet + 1))

if [ "$pocet" -ge 2 ] && [ -z "$uloha" ]; then
    if [ -n "${CHYBA_TASKER:-}" ]; then
        read -r -a tcmd <<< "$CHYBA_TASKER"
    elif command -v runuser >/dev/null && id "${CHYBA_TASKER_USER:-tasker}" >/dev/null 2>&1; then
        tcmd=(env "AGENT_NAME=$agent" "$HERE/tk")
    else
        tcmd=()
    fi
    if [ "${#tcmd[@]}" -gt 0 ]; then
        titul="Kontrola proti chybe triedy $trieda ($agent)"
        telo="Chyba triedy $trieda sa u agenta $agent zopakovala ($pocet. výskyt, ${datum}). Správanie riadi súbor $subor (commit $commit). ${popis:+Čo bolo tvrdené alebo urobené: $popis. }Zaveď kontrolu, ktorá chybu zablokuje: hook alebo test, ktorý na nej zlyhá (globálne pravidlá §4, druhý výskyt). Hotovo: replay chyby kontrola zastaví, nasadené. Register: $reg."
        if out="$("${tcmd[@]}" task add --project agenti --assign "$reviewer" --title "$titul" --body "$telo" --json 2>/dev/null)"; then
            uloha="$(printf '%s' "$out" | grep -o '"id": *[0-9]*' | head -1 | grep -o '[0-9]*')"
        fi
        [ -n "$uloha" ] || echo "chyba.sh: úlohu na kontrolu sa nepodarilo založiť, založ ju ručne (projekt agenti, riešiteľ $reviewer)" >&2
    else
        echo "chyba.sh: Tasker tu nie je dosiahnuteľný, úlohu na kontrolu založ na serveri (projekt agenti, riešiteľ $reviewer)" >&2
    fi
fi

printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$datum" "$agent" "$trieda" "$subor" "$commit" "${popis:-bez popisu}" "$uloha" "$mechanizmus" >> "$reg"

# Hlásenie pre operátora, štyri vety.
[ -n "$popis" ] || popis="chyba triedy $trieda"
[ -n "$pravda" ] || pravda="správanie mal riadiť súbor $subor a nedržalo"
echo "Tvrdil alebo urobil som: ${popis%.}."
echo "Pravda bola: ${pravda%.}."
echo "Zmenil sa súbor $subor, commit $commit."
if [ -n "$kontrola" ]; then
    echo "Nabudúce to zastaví: ${kontrola%.}."
elif [ -n "$uloha" ]; then
    echo "Nabudúce to zastaví kontrola, ktorú rieši úloha $uloha v Taskeri."
else
    echo "Kontrola zatiaľ nie je, druhý výskyt tejto triedy založí úlohu na ňu."
fi
