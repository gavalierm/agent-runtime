#!/bin/bash
# dokonci.sh, mechanické kroky skillu dokonci (úloha Taskera 617).
#   dokonci.sh start <úloha>
#   dokonci.sh dokaz <úloha> --popis "<čo dokazuje>" (-- <príkaz...> | --subor <cesta>)
#   dokonci.sh posudok <úloha> --kolo 1..3 --verdikt ok|zmeny --text "<text>"
#   dokonci.sh rozhodnutie <úloha> --text "<čo som rozhodol sám a prečo>"
#   dokonci.sh koniec <úloha> [--stop] --vysledok "<veta>" [--otvorene "<text>"]
#   dokonci.sh otazka <úloha> --summary "<otázka s ?, možnosti A) B) a odporúčanie>"
# Premenné: DOKONCI_TASKER (príkaz Taskera, pod rootom predvolene
# /opt/agent-rules/bin/tk, inak tasker), DOKONCI_LEDGER_DIR (priečinok
# ledgera, predvolene .scratch v koreni repa, keď ho git ignoruje, inak
# /tmp/dokonci). Každé zlyhanie: kód 1 a riadok "Správny postup:".
set -u
PROG="dokonci.sh"

fail() { # fail "<čo zlyhalo>" "<správny postup>"
    printf '%s: %s\n' "$PROG" "$1" >&2
    printf 'Správny postup: %s\n' "$2" >&2
    exit 1
}

usage() {
    cat >&2 <<'USAGE'
Použitie:
  dokonci.sh start <úloha>
  dokonci.sh dokaz <úloha> --popis "<čo dokazuje>" (-- <príkaz...> | --subor <cesta>)
  dokonci.sh posudok <úloha> --kolo 1..3 --verdikt ok|zmeny --text "<text>"
  dokonci.sh rozhodnutie <úloha> --text "<čo som rozhodol sám a prečo>"
  dokonci.sh koniec <úloha> [--stop] --vysledok "<veta>" [--otvorene "<text>"]
  dokonci.sh otazka <úloha> --summary "<otázka s ?, možnosti A) B) a odporúčanie>"
USAGE
    printf 'Správny postup: %s\n' "$1" >&2
    exit 1
}

AWKF='function f(key,  i){for(i=3;i<=NF;i++) if(index($i,key "=")==1) return substr($i,length(key)+2); return ""}'

# Spoločné nastavenie: ROOT, LEDGER, TASKER. Argument je číslo úlohy.
setup() {
    ULOHA="${1:-}"
    [[ "$ULOHA" =~ ^[0-9]+$ ]] || fail "číslo úlohy chýba alebo nie je číslo: '$ULOHA'" "dokonci.sh <podpríkaz> <číslo úlohy> ..."
    ROOT="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "aktuálny priečinok nie je git repo" "cd do repa, v ktorom pracuješ, a spusti znova"
    local dir
    if [ -n "${DOKONCI_LEDGER_DIR:-}" ]; then
        dir="$DOKONCI_LEDGER_DIR"
    elif git -C "$ROOT" check-ignore -q .scratch/dokonci 2>/dev/null; then
        dir="$ROOT/.scratch"
    else
        dir=/tmp/dokonci
    fi
    mkdir -p "$dir" || fail "ledger priečinok $dir sa nedá vytvoriť" "DOKONCI_LEDGER_DIR=<zapisovateľný priečinok>"
    LEDGER="$dir/dokonci-$ULOHA.md"
    if [ -n "${DOKONCI_TASKER:-}" ]; then
        TASKER="$DOKONCI_TASKER"
    elif [ "$(id -u)" = 0 ]; then
        TASKER=/opt/agent-rules/bin/tk
    else
        TASKER=tasker
    fi
}

g() { git -C "$ROOT" "$@"; }

# Volanie Taskera. $TASKER je príkaz, ktorý môže nésť argumenty (DOKONCI_TASKER=
# "node /opt/tasker/bin/tasker"), preto je tu zámerne bez úvodzoviek: shell ho
# rozdelí na slová (úloha 628, beh 128 Lea). Cesta s medzerou nie je podporená.
tasker_cmd() { ${TASKER} "$@"; }

led() { # led <typ> <k=v>...
    local typ="$1"; shift
    local line="@$typ"$'\t'"$(date -Iseconds)" kv
    for kv in "$@"; do line+=$'\t'"$(printf '%s' "$kv" | tr '\t\r\n' '   ')"; done
    printf '%s\n' "$line" >> "$LEDGER"
}

# Riadky ledgera od posledného @start.
session() { [ -f "$LEDGER" ] && awk '/^@start\t/{b=""} {b=b $0 "\n"} END{printf "%s", b}' "$LEDGER"; }

sget() { session | awk -F'\t' -v key="$1" "$AWKF"' $1=="@start"{v=f(key)} END{print v}'; }

need_ledger() {
    [ -n "$(session | awk '/^@start\t/{print "x"; exit}')" ] \
        || fail "ledger $LEDGER nemá hlavičku, start nebežal" "dokonci.sh start $ULOHA"
}

head_hash() { g rev-parse HEAD; }

# Referencia na dev, z ktorej vychádza práca: origin/dev, keď je pred lokálnym dev
# (alebo lokálny dev chýba), inak dev.
dev_ref() {
    if ! g rev-parse -q --verify refs/heads/dev >/dev/null; then echo origin/dev; return; fi
    if g rev-parse -q --verify refs/remotes/origin/dev >/dev/null && g merge-base --is-ancestor dev origin/dev; then
        echo origin/dev
    else
        echo dev
    fi
}

# dev drží iný worktree (git checkout dev nejde). Nastaví vetva a zaklad: ostane
# na aktuálnej vetve, keď z dev vychádza, inak založí dokonci-<úloha> z dev.
start_vo_worktree() {
    local cur ref
    ref="$(dev_ref)"
    cur="$(g symbolic-ref --short -q HEAD || true)"
    if [ -n "$cur" ] && [ "$cur" != dev ] && g merge-base --is-ancestor "$ref" HEAD 2>/dev/null; then
        vetva="$cur"
    else
        vetva="dokonci-$ULOHA"
        if g rev-parse -q --verify "refs/heads/$vetva" >/dev/null; then
            g checkout -q "$vetva" || fail "git checkout $vetva zlyhal" "oprav stav worktree, potom dokonci.sh start $ULOHA"
            g merge-base --is-ancestor "$ref" HEAD 2>/dev/null \
                || fail "vetva $vetva nevychádza z $ref" "git branch -D $vetva, ak je zbytočná, potom dokonci.sh start $ULOHA"
        else
            g checkout -q -b "$vetva" --no-track "$ref" || fail "vetvu $vetva sa nepodarilo založiť z $ref" "git checkout -b $vetva $ref, potom dokonci.sh start $ULOHA"
        fi
    fi
    zaklad=dev
}

cmd_start() {
    setup "${1:-}"
    g fetch origin >/dev/null 2>&1 || fail "git fetch origin zlyhal" "skontroluj origin a kľúč repa (git remote -v, ssh), potom dokonci.sh start $ULOHA"
    [ -z "$(g status --short)" ] \
        || fail "strom nie je čistý: $(g status --short | head -n3 | tr '\n' ';')" "git commit -m '...' -- <súbory> alebo zahoď zmenu, potom dokonci.sh start $ULOHA"
    local politika=main
    if g rev-parse -q --verify refs/remotes/origin/dev >/dev/null \
        || g rev-parse -q --verify refs/heads/dev >/dev/null \
        || [[ "$ROOT" == */projekty/* ]]; then
        politika=dev
    fi
    local vetva zaklad=""
    if [ "$politika" = dev ]; then
        if ! g rev-parse -q --verify refs/heads/dev >/dev/null && ! g rev-parse -q --verify refs/remotes/origin/dev >/dev/null; then
            local from=HEAD
            g rev-parse -q --verify refs/remotes/origin/main >/dev/null && from=origin/main
            g checkout -q -b dev --no-track "$from" || fail "vetvu dev sa nepodarilo vytvoriť z $from" "git checkout -b dev <základ>, potom dokonci.sh start $ULOHA"
        else
            local cout
            if ! cout="$(LC_ALL=C g checkout -q dev 2>&1)"; then
                if printf '%s' "$cout" | grep -qE "already used by worktree|is already checked out"; then
                    start_vo_worktree
                else
                    printf '%s\n' "$cout" >&2
                    fail "git checkout dev zlyhal" "oprav stav klonu, potom dokonci.sh start $ULOHA"
                fi
            fi
        fi
        if [ -z "$zaklad" ]; then
            if g rev-parse -q --verify refs/remotes/origin/dev >/dev/null; then
                g rebase origin/dev >/dev/null 2>&1 || { g rebase --abort >/dev/null 2>&1; fail "rebase na origin/dev zlyhal" "vyrieš konflikt ručne (git rebase origin/dev), potom dokonci.sh start $ULOHA"; }
            fi
            vetva=dev
        fi
    else
        g rev-parse -q --verify refs/remotes/origin/main >/dev/null || fail "origin/main neexistuje" "skontroluj remote origin, potom dokonci.sh start $ULOHA"
        g rebase origin/main >/dev/null 2>&1 || { g rebase --abort >/dev/null 2>&1; fail "rebase na origin/main zlyhal" "vyrieš konflikt ručne (git rebase origin/main), potom dokonci.sh start $ULOHA"; }
        vetva="$(g symbolic-ref --short -q HEAD || echo HEAD)"
    fi
    local base
    base="$(head_hash)"
    if [ -n "$zaklad" ]; then
        led start "uloha=$ULOHA" "repo=$ROOT" "politika=$politika" "vetva=$vetva" "zaklad=$zaklad" "base=$base"
    else
        led start "uloha=$ULOHA" "repo=$ROOT" "politika=$politika" "vetva=$vetva" "base=$base"
    fi
    printf 'úloha: %s\nrepo: %s\npolitika: %s\nvetva: %s\n' "$ULOHA" "$ROOT" "$politika" "$vetva"
    [ -z "$zaklad" ] || printf 'základ: %s (dev drží iný worktree, dev sa zlúči pri koniec)\n' "$zaklad"
    printf 'východiskový commit: %s\nledger: %s\n' "$base" "$LEDGER"
}

cmd_dokaz() {
    setup "${1:-}"; shift
    need_ledger
    local popis="" subor=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --popis) [ $# -ge 2 ] || fail "--popis bez hodnoty" "--popis \"<čo dokazuje>\""; popis="$2"; shift 2 ;;
            --subor) [ $# -ge 2 ] || fail "--subor bez hodnoty" "--subor <cesta k snímke>"; subor="$2"; shift 2 ;;
            --) shift; break ;;
            *) fail "neznáma voľba '$1'" "dokonci.sh dokaz N --popis \"...\" -- <príkaz...> alebo --subor <cesta>" ;;
        esac
    done
    [ -n "$popis" ] || fail "chýba --popis" "--popis \"<čo dokazuje>\""
    if [ -n "$subor" ]; then
        if [ ! -s "$subor" ]; then
            fail "súbor $subor neexistuje alebo je prázdny" "vytvor snímku (/root/agent-runtime/browser.sh --gaps ...), potom dokonci.sh dokaz $ULOHA --popis \"...\" --subor <cesta>"
        fi
        led dokaz "popis=$popis" "subor=$subor" "kod=0" "head=$(head_hash)"
        printf 'dôkaz zapísaný: %s (súbor %s)\n' "$popis" "$subor"
        return 0
    fi
    [ $# -ge 1 ] || fail "chýba príkaz za --" "dokonci.sh dokaz $ULOHA --popis \"...\" -- <príkaz...>"
    local out code
    out="$("$@" 2>&1)"; code=$?
    led dokaz "popis=$popis" "prikaz=$*" "kod=$code" "head=$(head_hash)"
    if [ -n "$out" ]; then
        printf '%s\n' "$out" | tail -n 20 | sed 's/^/    /' >> "$LEDGER"
        printf '%s\n' "$out"
    fi
    printf 'dôkaz zapísaný: %s (kód %s)\n' "$popis" "$code"
    exit "$code"
}

cmd_posudok() {
    setup "${1:-}"; shift
    need_ledger
    local kolo="" verdikt="" text=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --kolo) [ $# -ge 2 ] || fail "--kolo bez hodnoty" "--kolo 1..3"; kolo="$2"; shift 2 ;;
            --verdikt) [ $# -ge 2 ] || fail "--verdikt bez hodnoty" "--verdikt ok|zmeny"; verdikt="$2"; shift 2 ;;
            --text) [ $# -ge 2 ] || fail "--text bez hodnoty" "--text \"<text posudku>\""; text="$2"; shift 2 ;;
            *) fail "neznáma voľba '$1'" "dokonci.sh posudok N --kolo 1..3 --verdikt ok|zmeny --text \"...\"" ;;
        esac
    done
    [[ "$kolo" =~ ^[0-9]+$ ]] || fail "--kolo chýba alebo nie je číslo" "--kolo 1..3"
    if [ "$kolo" -gt 3 ]; then
        fail "rozpočet posudkov vyčerpaný (najviac 3 kolá)" "dokonci.sh otazka $ULOHA --summary \"<otázka s ?, možnosti A) B) a odporúčanie>\" (ledger $LEDGER)"
    fi
    [ "$kolo" -ge 1 ] || fail "--kolo musí byť 1 až 3" "--kolo 1..3"
    case "$verdikt" in ok|zmeny) ;; *) fail "--verdikt musí byť ok alebo zmeny" "--verdikt ok|zmeny" ;; esac
    [ -n "$text" ] || fail "chýba --text" "--text \"<text posudku>\""
    led posudok "kolo=$kolo" "verdikt=$verdikt" "head=$(head_hash)" "text=$text"
    printf 'posudok zapísaný: kolo %s, %s\n' "$kolo" "$verdikt"
}

cmd_rozhodnutie() {
    setup "${1:-}"; shift
    need_ledger
    { [ "${1:-}" = "--text" ] && [ -n "${2:-}" ]; } || fail "chýba --text" "dokonci.sh rozhodnutie N --text \"<čo som rozhodol sám a prečo>\""
    led rozhodnutie "text=$2"
    printf 'rozhodnutie zapísané\n'
}

# pub_merge <cieľová vetva> <štart> <čo zlúčiť> <správa>: v dočasnom worktree
# (detached zo <štart>) git merge --no-ff <čo zlúčiť> a push HEAD:<cieľ>. Pri
# odmietnutom pushi fetch, nový štart z origin/<cieľ> a merge znova (3 pokusy).
# Dočasný worktree sa vždy odstráni.
pub_merge() {
    local ciel="$1" start="$2" co="$3" sprava="$4" tmp i=0 rc=1
    tmp="$(mktemp -d /tmp/dokonci-wt-XXXXXX)" || return 1
    if ! g worktree add -q --detach "$tmp" "$start" >/dev/null 2>&1; then
        rm -rf "$tmp"; return 1
    fi
    while [ "$i" -lt 3 ]; do
        i=$((i+1))
        if ! git -C "$tmp" merge -q --no-ff "$co" -m "$sprava" >/dev/null 2>&1; then
            git -C "$tmp" merge --abort >/dev/null 2>&1
            break
        fi
        if git -C "$tmp" push origin "HEAD:refs/heads/$ciel" >/dev/null 2>&1; then rc=0; break; fi
        g fetch origin >/dev/null 2>&1 || break
        git -C "$tmp" reset -q --hard "origin/$ciel" >/dev/null 2>&1 || break
    done
    g worktree remove --force "$tmp" >/dev/null 2>&1 || rm -rf "$tmp"
    g worktree prune >/dev/null 2>&1
    return "$rc"
}

# Otázka na človeka: zapíše @otazka (hook dokonci_open tým pustí koniec ťahu)
# a zavolá tasker result needs_human, beh sa tým uzavrie.
cmd_otazka() {
    setup "${1:-}"; shift
    need_ledger
    local summary=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --summary) [ $# -ge 2 ] || fail "--summary bez hodnoty" "--summary \"<otázka s ?, možnosti A) B) a odporúčanie>\""; summary="$2"; shift 2 ;;
            *) fail "neznáma voľba '$1'" "dokonci.sh otazka N --summary \"<otázka s ?, možnosti A) B) a odporúčanie>\"" ;;
        esac
    done
    [ -n "$summary" ] || fail "chýba --summary" "dokonci.sh otazka $ULOHA --summary \"<otázka s ?, možnosti A) B) a odporúčanie>\""
    led otazka "summary=$summary"
    tasker_cmd result needs_human --summary "$summary" >/dev/null \
        || fail "otázka je zapísaná v ledgeri $LEDGER, ale tasker result needs_human zlyhal" "$TASKER result needs_human --summary \"$summary\" (beh musí mať TASKER_RUN_ID a TASKER_RUN_TOKEN, ťah nesmie byť skončený)"
    printf 'otázka odoslaná: %s\n' "$summary"
    exit 0
}

cmd_koniec() {
    setup "${1:-}"; shift
    need_ledger
    local stop=0 vysledok="" otvorene=""
    while [ $# -gt 0 ]; do
        case "$1" in
            --stop) stop=1; shift ;;
            --vysledok) [ $# -ge 2 ] || fail "--vysledok bez hodnoty" "--vysledok \"<veta>\""; vysledok="$2"; shift 2 ;;
            --otvorene) [ $# -ge 2 ] || fail "--otvorene bez hodnoty" "--otvorene \"<text>\""; otvorene="$2"; shift 2 ;;
            *) fail "neznáma voľba '$1'" "dokonci.sh koniec N [--stop] --vysledok \"<veta>\" [--otvorene \"<text>\"]" ;;
        esac
    done
    [ -n "$vysledok" ] || fail "chýba --vysledok" "dokonci.sh koniec $ULOHA --vysledok \"<veta o výsledku>\""
    local politika vetva base head cur
    politika="$(sget politika)"; vetva="$(sget vetva)"; base="$(sget base)"
    if [ "$stop" = 1 ] && [ "$politika" != dev ]; then
        fail "--stop platí len pre politiku dev, tento repo má main" "dokonci.sh koniec $ULOHA --vysledok \"...\" bez --stop"
    fi
    [ -z "$(g status --short)" ] \
        || fail "strom nie je čistý: $(g status --short | head -n3 | tr '\n' ';')" "git commit -m '...' -- <súbory>, potom dokaz a posudok na nový commit"
    cur="$(g symbolic-ref --short -q HEAD || echo HEAD)"
    [ "$cur" = "$vetva" ] || fail "si na vetve $cur, ledger má $vetva" "git checkout $vetva"
    [ "$(g rev-list --count "$base..HEAD")" -gt 0 ] \
        || fail "žiadny commit nad východiskovým $base" "urob najmenšiu zmenu a commitni ju (git commit -m '...' -- <súbory>)"
    head="$(head_hash)"
    local proofs
    proofs="$(session | awk -F'\t' -v head="$head" "$AWKF"' $1=="@dokaz" && f("kod")=="0" && (f("head")==head || f("subor")!="") {n++} END{print n+0}')"
    [ "$proofs" -gt 0 ] \
        || fail "žiadny dôkaz s kódom 0 po poslednom commite $head" "dokonci.sh dokaz $ULOHA --popis \"...\" -- <príkaz>, alebo --subor <snímka>"
    local verdikt
    verdikt="$(session | awk -F'\t' "$AWKF"' $1=="@posudok"{v=f("verdikt")} END{print v}')"
    case "$verdikt" in
        ok) ;;
        "") fail "chýba posudok druhým modelom" "posudok cez Agent, potom dokonci.sh posudok $ULOHA --kolo 1 --verdikt ok|zmeny --text \"...\"" ;;
        *) fail "posledný posudok žiada zmeny" "oprav, commit, dokaz, dokonci.sh posudok $ULOHA --kolo <ďalšie> ...; po 3. kole dokonci.sh otazka $ULOHA --summary \"<otázka s ?, možnosti A) B) a odporúčanie>\" (ledger $LEDGER)" ;;
    esac

    # Publikácia. Politika dev nikdy nerobí checkout dev ani main v klone behu
    # (dev môže držať iný worktree, hook hlavného klonu checkout zamieta): merge
    # ide v dočasnom worktree.
    local merged=""
    if [ "$politika" = dev ]; then
        g fetch origin >/dev/null 2>&1 || fail "git fetch origin zlyhal" "skontroluj origin, potom dokonci.sh koniec $ULOHA ..."
        if [ "$vetva" = dev ]; then
            g push origin dev >/dev/null 2>&1 \
                || fail "push dev zlyhal" "git fetch origin, git rebase origin/dev, nový dôkaz a posudok, potom dokonci.sh koniec $ULOHA$([ "$stop" = 1 ] && echo " --stop") ..."
        else
            pub_merge dev "$(dev_ref)" "$vetva" "Merge $vetva do dev: $vysledok (úloha $ULOHA)" \
                || fail "merge $vetva do dev zlyhal (konflikt, hook alebo push)" "git fetch origin, git merge origin/dev do $vetva, nový dôkaz a posudok, potom dokonci.sh koniec $ULOHA ..."
        fi
        if [ "$stop" = 0 ]; then
            pub_merge main origin/main origin/dev "Merge dev: $vysledok (úloha $ULOHA)" \
                || fail "merge dev do main zlyhal (konflikt, hook alebo push), dev je už pushnutý" "git fetch origin, git merge origin/main do $vetva, nový dôkaz a posudok, potom dokonci.sh koniec $ULOHA ..."
            merged=1
            # Lokálny main a dev dohoň, keď ich nič nedrží (nepovinné).
            g fetch -q origin main:refs/heads/main >/dev/null 2>&1 || true
        fi
        g fetch -q origin dev:refs/heads/dev >/dev/null 2>&1 || true
    else
        g push origin HEAD:refs/heads/main >/dev/null 2>&1 \
            || fail "push main zlyhal" "git fetch origin, git rebase origin/main, nový dôkaz a posudok, potom dokonci.sh koniec $ULOHA ..."
    fi

    # Hlásenie do úlohy.
    local dokazy rozh pos otv body
    dokazy="$(session | awk -F'\t' "$AWKF"' $1=="@dokaz"{d=f("popis"); if(f("subor")!="") d=d " (súbor " f("subor") ", kód " f("kod") ")"; else d=d " (kód " f("kod") ")"; s=(s==""?d:s "; " d)} END{print s}')"
    rozh="$(session | awk -F'\t' "$AWKF"' $1=="@rozhodnutie"{print "Rozhodnutia: " f("text")}')"
    pos="$(session | awk -F'\t' "$AWKF"' $1=="@posudok"{print "Posudok: kolo " f("kolo") " " f("verdikt")}')"
    otv="${otvorene:-nič}"
    if [ "$stop" = 1 ]; then
        if [ -n "$otvorene" ]; then otv="$otvorene; merge dev do main"; else otv="merge dev do main"; fi
    fi
    body="Výsledok: $vysledok"$'\n'"Dôkaz: $dokazy"$'\n'"Otvorené: $otv"
    [ -n "$rozh" ] && body+=$'\n'"$rozh"
    [ -n "$pos" ] && body+=$'\n'"$pos"
    led koniec "head=$head" "stop=$stop" "vysledok=$vysledok"
    tasker_cmd comment "$ULOHA" --body "$body" >/dev/null \
        || fail "zmena je pushnutá, ale komentár do úlohy $ULOHA zlyhal" "$TASKER comment $ULOHA --body \"<telo z ledgera $LEDGER>\", potom $TASKER result done --summary \"$vysledok\""
    tasker_cmd result done --summary "$vysledok" >/dev/null \
        || fail "komentár je zapísaný, ale tasker result done zlyhal" "$TASKER result done --summary \"$vysledok\" (beh musí mať TASKER_RUN_ID a TASKER_RUN_TOKEN)"
    printf 'hotovo: %s\n%s\n' "$vysledok" "$body"
    [ -n "$merged" ] && printf 'main aj dev sú pushnuté\n'
    exit 0
}

[ $# -ge 1 ] || usage "dokonci.sh start <číslo úlohy> na začiatku behu, ďalej dokaz, posudok, rozhodnutie a koniec"
sub="$1"; shift
case "$sub" in
    start) cmd_start "$@" ;;
    dokaz) cmd_dokaz "$@" ;;
    posudok) cmd_posudok "$@" ;;
    rozhodnutie) cmd_rozhodnutie "$@" ;;
    koniec) cmd_koniec "$@" ;;
    otazka) cmd_otazka "$@" ;;
    *) usage "podpríkaz '$sub' neexistuje, použi start, dokaz, posudok, rozhodnutie, koniec alebo otazka" ;;
esac
