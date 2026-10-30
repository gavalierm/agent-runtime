#!/bin/bash
# Zápis rozhodnutia do decisions/ spoločného mozgu agentov: pridelí číslo,
# zapíše súbor, prepíše INDEX.md, commitne pod menom agenta, pushne a podľa
# ROZHODNI_SYNC_UNIT spustí sync. Schéma je v docs/decisions-schema.md, logiku
# nesie lib/rozhodnutia.mjs. Skript nepredpokladá, že leží v repe s rozhodnutiami,
# klon s nimi dáva lib/paths.sh (AGENT_BRAIN_GLOBAL).
#
# Použitie (text záznamu na stdin):
#   rozhodni.sh --nazov N --kluc K --rozsah R,R --agenti A,A --rozhodol KTO
#               --moc MOC --zdroj Z [--nahradza D0001] [--uloha N]
#               [--alias R153] [--subory s1,s2] [--zrusene-tvrdenie REGEX] [--z-ulohy N]
#               [--zapisal správca agentov] [--datum RRRR-MM-DD] [--dry-run]
#   rozhodni.sh --zrus D0007 --dovod "dôvod" [--dry-run]
#   rozhodni.sh --premenuj-subor <stará cesta> <nová cesta[, ďalšia]> [--dry-run]
#     (súbor zo `subory` sa presunul alebo rozdelil: každý záznam dostane nové cesty, INDEX.md sa prepíše)
# --z-ulohy N doplní --zdroj a --uloha z úlohy Taskera (ROZHODNI_TASKER, inak
# bin/tk tohto repa), explicitné --zdroj a --uloha majú prednosť.
# --dry-run vypíše záznam a nezapíše nič, ani git. Rovnaký kľúč ako platný
# záznam bez --nahradza skončí chybou s výpisom platných záznamov.
#
# Premenné: AGENT_BRAIN_GLOBAL (klon so spoločným mozgom, priečinok decisions/),
# AGENT_NAME (kto píše, inak meno z PERSONA.md cez lib/agent_name.sh, inak
# --zapisal), ROZHODNI_STROJ (meno stroja v mene autora, inak hostname),
# ROZHODNI_SYNC_UNIT (jednotka systemd, ktorú po pushi
# spustí sync klonu, bez nej sa sync nespúšťa), ROZHODNI_TASKER (príkaz Taskera
# pre --z-ulohy), AGENT_WORKFLOW.
# Commit nesie meno "<Agent> (<stroj>)". Kód 0 zapísané, 1 chyba, 2 zlé použitie.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib/paths.sh
. "$here/../lib/paths.sh"
# shellcheck source=../lib/agent_name.sh
. "$here/../lib/agent_name.sh"
lib="$here/../lib/rozhodnutia.mjs"
repo="$(brain_global_dir)"
dir="$(decisions_dir)"
if [ ! -d "$dir" ]; then
    echo "Chýba priečinok rozhodnutí $dir: nastav AGENT_BRAIN_GLOBAL na klon so spoločným mozgom (priečinok decisions/)." >&2
    exit 2
fi

args=()
dry=0
zrus=0
premenuj=0; premenuj_args=()
zapisal=""
z_ulohy=""; zdroj_dany=0; uloha_dana=0
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) dry=1 ;;
        --zrus) zrus=1; args+=("$1" "${2:-}"); shift ;;
        --premenuj-subor) premenuj=1; premenuj_args=(--stary "${2:-}" --novy "${3:-}"); shift 2 ;;
        --zapisal) zapisal="${2:-}"; shift ;;
        --z-ulohy) z_ulohy="${2:-}"; shift ;;
        --zdroj) zdroj_dany=1; args+=("$1" "${2:-}"); shift ;;
        --uloha) uloha_dana=1; args+=("$1" "${2:-}"); shift ;;
        --telo|--dir)
            echo "Prepínač $1 nie je pre rozhodni.sh, text ide na stdin." >&2
            exit 2 ;;
        *) args+=("$1") ;;
    esac
    shift
done

# --z-ulohy N: zdroj a číslo úlohy z Taskera (ROZHODNI_TASKER, inak bin/tk tohto repa),
# explicitné --zdroj a --uloha majú prednosť.
if [ -n "$z_ulohy" ]; then
    if ! [[ "$z_ulohy" =~ ^[0-9]+$ ]]; then echo "--z-ulohy chce číslo úlohy, dostal som '$z_ulohy'." >&2; exit 2; fi
    tasker_cmd="${ROZHODNI_TASKER:-$here/tk}"
    if ! uj="$($tasker_cmd task show "$z_ulohy" --json 2>/dev/null)" || [ -z "$uj" ]; then
        echo "Úlohu $z_ulohy sa nepodarilo prečítať z Taskera, zapíš --zdroj a --uloha ručne." >&2
        exit 1
    fi
    zdroj_z="$(node "$lib" zdroj-ulohy <<<"$uj")" || { echo "Úloha $z_ulohy: $zdroj_z" >&2; exit 1; }
    [ "$uloha_dana" = 0 ] && args+=(--uloha "$z_ulohy")
    [ "$zdroj_dany" = 0 ] && args+=(--zdroj "$zdroj_z")
fi

if [ -z "$zapisal" ]; then
    zapisal="$(agent_name_capital)" || zapisal=""
fi
[ -n "$zapisal" ] && args+=(--zapisal "$zapisal")

telo=""
if [ "$zrus" = 0 ] && [ "$premenuj" = 0 ]; then telo="$(cat)"; fi
node_zapis() {
    if [ "$premenuj" = 1 ]; then node "$lib" subor-premenuj --dir "$dir" "${premenuj_args[@]}" "$@"
    elif [ "$zrus" = 1 ]; then node "$lib" zapis --dir "$dir" "$@"
    else node "$lib" zapis --dir "$dir" --telo "$telo" "$@"; fi
}

if [ "$dry" = 1 ]; then
    node_zapis "${args[@]}" --dry-run
    exit $?
fi

if [ -z "$zapisal" ]; then
    echo "Chýba kto píše: nastav AGENT_NAME, spusti v priečinku s PERSONA.md (riadok '# Meno') alebo daj --zapisal." >&2
    exit 2
fi
stroj="${ROZHODNI_STROJ:-$(hostname -s)}"
autor="$zapisal ($stroj)"
git_r() { git -C "$repo" "$@"; }

if [ "$(git_r rev-parse --abbrev-ref HEAD)" != main ]; then
    echo "Klon $repo nie je na vetve main, nič som nezapísal." >&2
    exit 1
fi

# Zapíše výstup `zapis` (id, názov, súbory) ako commit. Nastaví id, nazov, subory.
commit_out() {
    local out="$1" autor_c="$2" msg
    id="$(sed -n 1p <<<"$out")"
    nazov="$(sed -n 2p <<<"$out")"
    subory=()
    while IFS= read -r f; do [ -n "$f" ] && subory+=("decisions/$f"); done < <(sed -n '3,$p' <<<"$out")
    git_r add -- "${subory[@]}" || return 1
    if [ "$premenuj" = 1 ]; then msg="Rozhodnutia $id: súbor $nazov"
    elif [ "$zrus" = 1 ]; then msg="Rozhodnutie $id zrušené: $nazov"; else msg="Rozhodnutie $id: $nazov"; fi
    if ! git_r -c user.name="$autor_c" commit -q -m "$msg" -- "${subory[@]}"; then
        # Hook pre-commit (check.mjs) commit odmietol: súbory sa nesmú ostať v indexe, ďalší zápis by padol na rebase.
        git_r reset -q -- "${subory[@]}"
        local f
        for f in "${subory[@]}"; do
            if git_r cat-file -e "HEAD:$f" 2>/dev/null; then git_r checkout -q -- "$f"; else rm -f "$repo/$f"; fi
        done
        id=""
        return 1
    fi
}

# Rebase padol na konflikte lokálnych nepushnutých commitov rozhodnutí
# (rovnaké číslo D z dvoch strojov, S3 a S6 úlohy 404). Keď sú všetky nepushnuté
# commity zápisy nových rozhodnutí a strom je čistý, zapíše ich znova nad
# origin/main pod novým číslom. Pri neúspechu (napr. rovnaký kľúč) vráti klon
# na pôvodný stav. Vráti 0 len keď sú všetky znova zapísané.
precisluj_lokalne() {
    local orig shas sha f tmpd st
    orig="$(git_r rev-parse HEAD)"
    [ -z "$(git_r status --porcelain --untracked-files=no)" ] || return 1
    shas="$(git_r log --reverse --format=%H origin/main..HEAD)"
    [ -n "$shas" ] || return 1
    tmpd="$(mktemp -d)"
    trap "rm -rf '$tmpd'" EXIT
    for sha in $shas; do
        git_r log -1 --format=%s "$sha" | grep -q '^Rozhodnutie D[0-9]\{4\}: ' || { rm -rf "$tmpd"; return 1; }
        st="$(git_r diff-tree --no-commit-id --name-status -r "$sha" -- decisions | grep -E $'^A\tdecisions/D[0-9]{4}\.md$' || true)"
        [ -n "$st" ] || { rm -rf "$tmpd"; return 1; }
        f="${st#*$'\t'}"
        git_r show "$sha:$f" >"$tmpd/$sha.md"
        git_r log -1 --format=%an "$sha" >"$tmpd/$sha.autor"
    done
    git_r reset -q --hard origin/main
    local o
    for sha in $shas; do
        if ! o="$(node "$lib" znovu --dir "$dir" --subor "$tmpd/$sha.md" 2>&1)" || ! commit_out "$o" "$(cat "$tmpd/$sha.autor")"; then
            echo "Prečíslovanie lokálneho záznamu zlyhalo (vrátil som klon na pôvodný stav): $o" >&2
            git_r reset -q --hard "$orig"
            rm -rf "$tmpd"
            return 1
        fi
        echo "Lokálny záznam ${id} sa po cudzom zápise prečísloval." >&2
    done
    rm -rf "$tmpd"
}

zapis_a_push() {
    git_r fetch -q origin
    if ! git_r rebase -q origin/main >/dev/null 2>&1; then
        git_r rebase --abort 2>/dev/null
        if ! precisluj_lokalne; then
            echo "Rebase na origin/main zlyhal (necommitnuté zmeny alebo konflikt s lokálnym commitom rozhodnutia), rebase som zrušil. Nepushnutý záznam zachráň: git log origin/main..HEAD, text si ulož, git reset --hard origin/main a zapíš znova (konflikt kľúča rieši --nahradza)." >&2
            return 1
        fi
    fi
    local out
    out="$(node_zapis "${args[@]}")" || return 1
    commit_out "$out" "$autor" || return 1
    git_r push -q origin HEAD:main || return 1
}

# Po odmietnutom pushi vráti vlastný commit a zmeny súborov, zvyšok klonu nechá.
vrat() {
    git_r reset -q HEAD~1
    local f
    for f in "${subory[@]}"; do
        if git_r cat-file -e "HEAD:$f" 2>/dev/null; then git_r checkout -q -- "$f"; else rm -f "$repo/$f"; fi
    done
}

id=""; nazov=""; subory=()
if ! zapis_a_push; then
    if [ -n "$id" ] && [ "$(git_r log -1 --format=%s)" != "" ] && git_r log -1 --format=%s | grep -q "^Rozhodnutie $id"; then
        echo "Push odmietnutý, skúsim raz znova s novým číslom." >&2
        vrat
        id=""; subory=()
        if ! zapis_a_push; then
            # Commit druhého pokusu ostáva v klone (offline zápis, push pri najbližšom pripojení).
            if [ -n "$id" ] && git_r log -1 --format=%s | grep -q "^Rozhodnutie $id"; then
                echo "Záznam $id je commitnutý len lokálne, nepushnutý. Po pripojení: git fetch, git rebase origin/main, git push origin HEAD:main." >&2
                exit 1
            fi
            echo "Druhý pokus zlyhal, záznam nie je zapísaný. Pozri chybu hore." >&2
            exit 1
        fi
    else
        exit 1
    fi
fi

if [ -n "${ROZHODNI_SYNC_UNIT:-}" ] && command -v systemctl >/dev/null; then
    systemctl start "$ROZHODNI_SYNC_UNIT" 2>/dev/null || echo "Sync $ROZHODNI_SYNC_UNIT sa nespustil, klon servera ho stiahne do 5 minút." >&2
fi
echo "$id"
