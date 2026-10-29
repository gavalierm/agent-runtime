#!/bin/bash
# Test lib/agent_name.sh v dočasnom priečinku (živé PERSONA.md ani prostredie
# sa nedotknú): poradie AGENT_NAME, TASKER_USER, PERSONA.md v
# CLAUDE_PROJECT_DIR, v PWD a v rodičovi PWD, platnosť mena, veľké písmeno.
# Spustenie: bash lib/agent_name.test.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/agent_name.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
failures=0

mkdir -p "$T/projekt/pod/hlbsie" "$T/prazdny" "$T/dir-persona"
printf '# Delta\n\nText.\n' >"$T/projekt/PERSONA.md"
printf '# Boris\n' >"$T/dir-persona/PERSONA.md"
mkdir -p "$T/zle"
printf '# Zlé meno s medzerami\n' >"$T/zle/PERSONA.md"
mkdir -p "$T/bez-nadpisu"
printf 'Len text bez nadpisu.\n' >"$T/bez-nadpisu/PERSONA.md"
mkdir -p "$T/projekt/pod/bez-nadpisu"
printf 'Len text.\n' >"$T/projekt/pod/bez-nadpisu/PERSONA.md"
mkdir -p "$T/crlf"
printf '# Ada  \r\n' >"$T/crlf/PERSONA.md"

# run popis očakávaný_kód očakávaný_výstup cwd [VAR=hodnota...] -- funkcia:
# prostredie je prázdne (env -i), len dané premenné.
run() {
    local name="$1" want_rc="$2" want_out="$3" cwd="$4" fn="$5"
    shift 5
    local out rc
    out="$(cd "$cwd" && env -i PATH="$PATH" HOME="$T" "$@" bash -c ". '$LIB'; $fn")"
    rc=$?
    if [ "$rc" = "$want_rc" ] && [ "$out" = "$want_out" ]; then
        echo "ok   $name"
    else
        echo "FAIL $name: kód $rc výstup '$out', čakal som kód $want_rc výstup '$want_out'"
        failures=$((failures + 1))
    fi
}

run "AGENT_NAME má prednosť" 0 "alfa" "$T/projekt" agent_name AGENT_NAME=alfa TASKER_USER=beta CLAUDE_PROJECT_DIR="$T/dir-persona"
run "TASKER_USER je druhý" 0 "beta" "$T/projekt" agent_name TASKER_USER=beta CLAUDE_PROJECT_DIR="$T/dir-persona"
run "PERSONA.md v CLAUDE_PROJECT_DIR" 0 "boris" "$T/projekt" agent_name CLAUDE_PROJECT_DIR="$T/dir-persona"
run "CLAUDE_PROJECT_DIR bez persony padne na PWD" 0 "delta" "$T/projekt" agent_name CLAUDE_PROJECT_DIR="$T/prazdny"
run "PERSONA.md v PWD, # Delta dá delta" 0 "delta" "$T/projekt" agent_name
run "PERSONA.md v rodičovi PWD" 0 "delta" "$T/projekt/pod" agent_name
run "PERSONA.md vo vzdialenom rodičovi PWD" 0 "delta" "$T/projekt/pod/hlbsie" agent_name
run "PERSONA.md bez nadpisu sa preskočí, vyššia nesie meno" 0 "delta" "$T/projekt/pod/bez-nadpisu" agent_name
run "koniec riadku CRLF a medzery sa orežú" 0 "ada" "$T/crlf" agent_name
run "bez mena kód 1 a nič na výstupe" 1 "" "$T/prazdny" agent_name
run "PERSONA.md bez nadpisu: bez mena" 1 "" "$T/bez-nadpisu" agent_name
run "neplatné meno z AGENT_NAME kód 1" 1 "" "$T/projekt" agent_name AGENT_NAME="zlé meno"
run "neplatné meno z persony kód 1" 1 "" "$T/zle" agent_name
run "AGENT_NAME s veľkým písmenom sa zníži" 0 "alfa" "$T/prazdny" agent_name AGENT_NAME=Alfa
run "agent_name_capital dá Delta" 0 "Delta" "$T/projekt" agent_name_capital
run "agent_name_capital z AGENT_NAME" 0 "Beta" "$T/prazdny" agent_name_capital AGENT_NAME=beta
run "agent_name_capital bez mena kód 1" 1 "" "$T/prazdny" agent_name_capital

# Načítanie lib nemení voľby shellu: set -e a -u ostanú, ako boli.
opts="$(env -i PATH="$PATH" bash -c 'set -eu; before="$-"; . "'"$LIB"'"; [ "$before" = "$-" ] && echo same')"
if [ "$opts" = same ]; then echo "ok   source nemení voľby shellu"; else echo "FAIL source zmenil voľby shellu"; failures=$((failures + 1)); fi

# Pod set -e skript s `|| true` neskončí na zlyhaní funkcie.
out="$(cd "$T/prazdny" && env -i PATH="$PATH" bash -c 'set -euo pipefail; . "'"$LIB"'"; n="$(agent_name)" || n=bez; echo "$n"')"
if [ "$out" = bez ]; then echo "ok   zlyhanie pod set -e sa dá zachytiť"; else echo "FAIL set -e: '$out'"; failures=$((failures + 1)); fi

if [ "$failures" -eq 0 ]; then
    echo "agent_name: všetko prešlo."
else
    echo "agent_name: $failures zlyhaní." >&2
    exit 1
fi
