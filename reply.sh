#!/bin/bash
# Odpoveď agenta na správu zo schránky. Agent ho volá vo
# vlákne T3 s menom správy z hlavičky <schranka id="...">, text odpovede ide
# na stdin. Agent ho volá s AGENT_NAME=<meno> (budič to dáva do
# hlavičky cez AGENT_REPLY_CMD).
#
# Odpoveď sa zapíše do $AGENT_BOX/outbox pod menom správy, odkiaľ ju
# odosielateľ prečíta (`ask_agent.sh --replies`). Odpoveď pre odosielateľa z AGENT_INBOX_ONLY ide len do jeho schránky. Keď tam neprečítaná
# odpoveď s tým menom ešte je, nová dostane meno <správa>.<čas v ns>.
# Odosielateľ s vlastným kanálom dostane odpoveď aj do svojej schránky:
# premenná AGENT_REPLY_ROUTE_<odosielateľ> nesie jej
# priečinok, napríklad AGENT_REPLY_ROUTE_bob=/var/lib/boris/inbox. Tam ide pod
# menom $AGENT_REPLY_PREFIX-<odosielateľ>-<jadro> (predpona je predvolene meno
# agenta, jadro je meno správy bez opakovaných predpôn oboch strán). Odosielateľa určí predpona
# mena správy (sender="adam" je správa od anny, píše ako adam-).
#
# Odpoveď z vlákna témy zapíše trasu (route.mjs), budič potom pošle
# ďalšiu správu k tej istej veci do toho vlákna.
#
# Hlavička: `id:`, `od:`, `komu:`, `téma:` a `k: <id pôvodnej správy>`
# (bin/ask_agent.sh v repe pravidiel, hlavička správy).
#
# Prvý riadok odpovede nesie, čo od nej čakám (README.md, časť Budenie):
# predvolene `odpoveď: na vedomie` (hlásenie, odosielateľa budí len keď
# na odpoveď čaká), `--cakam` (potrebujem niečo späť, budí a jeho odpoveď
# zobudí mňa), `--necakam` (pokyn, budí, odpoveď prečítam pri ďalšom
# ťahu). Druhý riadok `k správe: <hodnota>` opíše prvý riadok pôvodnej
# správy z processed, budič odosielateľa podľa neho rozhodne, keď mu
# chýba záznam. Bez prepínača odmietne telo s riadkom, ktorý začína
# `Úloha` alebo `Otázka`, to je pokyn a potrebuje --cakam alebo
# --necakam. Riadok `Hotovo: <výsledok>` je výsledok, nie pokyn.
# Telo musí mať riadky `Výsledok:`, `Dôkaz:` a `Otvorené:` s neprázdnou
# hodnotou (v každom režime, aj s `Hotovo:`), inak kód 1 s riadkom
# `Správny postup:` a príkladom.
#
# Použitie: reply.sh [--cakam|--necakam] <meno správy> < odpoved.md
# Kód 0 zapísané, 1 chyba.
set -euo pipefail

mode="na vedomie"
explicit=0
args=()
for a in "$@"; do
    case "$a" in
        --cakam) mode="čakám"; explicit=1 ;;
        --necakam) mode="nečakám"; explicit=1 ;;
        --vedomie) mode="na vedomie"; explicit=1 ;;
        *) args+=("$a") ;;
    esac
done
set -- "${args[@]+"${args[@]}"}"

# Rovnaké nastavenie ako služby (EnvironmentFile), vlákno T3 ho nededí.
AGENT="${AGENT_NAME:-agent}"
ENV_FILE="${AGENT_ENV_FILE:-$HOME/.config/$AGENT/runtime.env}"
# shellcheck disable=SC1090
if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi

BOX="${AGENT_BOX:-/var/lib/$AGENT}"
PREFIX="${AGENT_REPLY_PREFIX:-$AGENT}"
name="${1:-}"
if ! [[ "$name" =~ ^[a-z][a-z0-9_]{0,30}-[A-Za-z0-9._-]{1,120}$ ]]; then
    echo "Chýba alebo je zlé meno správy: '$name'." >&2
    exit 1
fi
text="$(cat)"
if [ -z "$text" ]; then
    echo "Prázdna odpoveď, nič som nezapísal." >&2
    exit 1
fi
if [ "$explicit" = 0 ] && grep -qE '^(Úloha|Otázka)' <<<"$text"; then
    echo "Telo vyzerá ako pokyn (riadok Úloha alebo Otázka), odpoveď na vedomie by adresáta nezobudila. Daj --cakam alebo --necakam. Nič som nezapísal." >&2
    exit 1
fi
# Telo odpovede nesie tri riadky: Výsledok, Dôkaz a Otvorené (každý aspoň
# raz, v ľubovoľnom poradí, hodnota za dvojbodkou neprázdna). Platí pre
# všetky režimy vrátane riadka `Hotovo:`.
missing=()
for label in Výsledok Dôkaz Otvorené; do
    grep -qE "^${label}:[[:space:]]*[^[:space:]]" <<<"$text" || missing+=("$label")
done
if [ "${#missing[@]}" -gt 0 ]; then
    {
        echo "Telo odpovede nemá neprázdny riadok: ${missing[*]}. Nič som nezapísal."
        echo "Správny postup: telo má tri riadky, ktoré začínajú Výsledok:, Dôkaz: a Otvorené: (v ľubovoľnom poradí, za dvojbodkou text). Keď nič neostalo, napíš Otvorené: nič."
        echo "Príklad:"
        echo "Výsledok: reply.sh odmietne telo bez troch riadkov."
        echo "Dôkaz: node --test v /root/agent-runtime, 0 zlyhaní."
        echo "Otvorené: nič"
    } >&2
    exit 1
fi
# Prvý riadok pôvodnej správy, budič ho presunul do processed.
original=""
for f in "$BOX/processed/$name" "$BOX/inbox/$name"; do
    [ -f "$f" ] || continue
    original="$(sed -n '1{s/^odpoveď: *//p}' "$f")"
    break
done
head="odpoveď: $mode"
case "$original" in
    "čakám"|"nečakám"|"na vedomie") head="$head"$'\n'"k správe: $original" ;;
esac
# Hlavička s id a `k:` (id pôvodnej správy): budič odosielateľa páruje
# odpoveď podľa nej, nie podľa mena súboru. Téma z hlavičky pôvodnej správy,
# inak z jej mena.
orig_topic=""
for f in "$BOX/processed/$name" "$BOX/inbox/$name"; do
    [ -f "$f" ] || continue
    orig_topic="$(sed -n 's/^téma: *//p' "$f" | head -n1)"
    break
done
if [ -z "$orig_topic" ]; then
    rest="${name#*-}"
    [[ "$rest" =~ ^([a-z][a-z0-9_]*)-[0-9] ]] && orig_topic="${BASH_REMATCH[1]}"
fi
text="$head"$'\n'"id: $name"$'\n'"od: $AGENT"$'\n'"komu: ${name%%-*}"$'\n'"téma: $orig_topic"$'\n'"k: $name"$'\n'"$text"

# Zápis cez dočasný súbor s bodkou a mv, čitateľ nevidí polovičný súbor.
put() {
    local dir="$1" target="$2"
    [ -e "$dir/$target" ] && target="$target.$(date +%s%N)"
    printf '%s\n' "$text" > "$dir/.$target.tmp"
    mv "$dir/.$target.tmp" "$dir/$target"
    echo "$dir/$target"
}

umask 007
# Odosielateľ z AGENT_INBOX_ONLY (zoznam mien cez dvojbodku) má vlastnú schránku
# na serveri, odpoveď preňho ide len tam. Kým priečinok schránky neexistuje,
# ide odpoveď do outboxu.
inbox_only=0
for s in $(printf '%s' "${AGENT_INBOX_ONLY:-}" | tr ':' ' '); do
    [ "${name%%-*}" = "$s" ] && [ -d "${ASK_VAR_LIB:-/var/lib}/$s/inbox" ] && inbox_only=1 && sender_only="$s"
done
if [ "$inbox_only" = 1 ]; then
    route_only="AGENT_REPLY_ROUTE_$sender_only"
    export "$route_only=${!route_only:-${ASK_VAR_LIB:-/var/lib}/$sender_only/inbox}"
else
    put "$BOX/outbox" "$name"
fi
# Trasa: odpoveď na túto odpoveď (to isté jadro mena alebo tá istá téma)
# príde do vlákna, z ktorého agent odpovedá, nie do hlavného (route.mjs).
# Chyba trasy odpoveď nezastaví, odpoveď na ňu príde do hlavného vlákna.
node "$(dirname "$0")/route.mjs" remember "$name" --mode "$mode" >&2 || true
sender="${name%%-*}"
route_var="AGENT_REPLY_ROUTE_${sender}"
if [ -n "${!route_var:-}" ]; then
    # Odpoveď na odpoveď nesie predpony oboch strán (boris-adam-boris-adam-...).
    # Jadro je meno bez nich, cieľ je vždy <predpona>-<odosielateľ>-<jadro>.
    core="$name"
    while [[ "$core" == "$sender"-* || "$core" == "$PREFIX"-* ]] && [[ "${core#*-}" == *-* ]]; do
        core="${core#*-}"
    done
    put "${!route_var}" "$PREFIX-$sender-$core"
fi
