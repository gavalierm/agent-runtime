#!/bin/bash
# Správa medzi agentmi zo schránky na schránku, jeden skript pre server aj
# Mac. Nahradil staršie samostatné skripty servera a Macu (rozhodnutie
# z 20. 10. 2026, "Jeden skript správ").
#
# Použitie:
#   ask_agent.sh [--vedomie --dopad "<čo sa mení>"] [--k <id>] <adresát> <téma> "text"
#   ask_agent.sh [--vedomie --dopad "<čo sa mení>"] [--k <id>] <adresát> <téma> < sprava.md
#   ask_agent.sh [--vedomie --dopad "<čo sa mení>"] [--k <id>] --hlavne <adresát> "text"
# Nová správa --vedomie bez --k vyžaduje --dopad (čo sa mení v práci adresáta),
# text ide do tela ako prvý riadok `dopad: <text>`. Odpoveď --vedomie --k ho nepotrebuje.
#   ask_agent.sh --replies [<adresát>]        (predvolene ASK_DEFAULT_TO)
# Téma `-` znamená tému z ASK_TOPIC (alebo <ADRESÁT>_TOPIC), inak zo stavu
# hooku topic.mjs pre reláciu CLAUDE_CODE_SESSION_ID v TOPIC_STATE_DIR
# (predvolene .scratch/topics v CLAUDE_PROJECT_DIR), len keď zámok témy drží
# tá istá relácia. Kód 0 odoslané alebo prečítané, 1 chyba, 2 pri --replies žiadna
# odpoveď nečaká.
#
# Kam správa ide:
# - Na serveri do schránky adresáta ($AGENT_SEND_<adresát>, inak
#   /var/lib/<adresát>/inbox), zápis cez skrytý .tmp a mv. Každý agent
#   má na serveri vlastnú schránku, výnimka pre outbox neexistuje.
# - Na Macu (na stroji nie je žiadna schránka /var/lib/*/inbox, alebo je
#   nastavený ASK_HOST alebo <ADRESÁT>_HOST) cez ssh do /var/lib/<adresát>
#   na serveri (koreň /var/lib prepíše ASK_VAR_LIB). Cieľ ssh je
#   ASK_HOST, pre adresáta <ADRESÁT>_HOST, v tvare `účet@adresa`. Účet musí
#   patriť do skupín schránok adresátov. Adresáti z ASK_URGENT_ONLY (mená
#   cez čiarku) prijímajú z Macu len súrne a blokujúce správy, bez
#   ASK_URGENT=1 skript nič nepošle.
#
# Odosielateľ je AGENT_NAME, inak ASK_FROM. Meno správy je <odosielateľ>-[<téma>-]<čas>-<pid>.md.
#
# Hlavička správy (píšu ju skripty, budič ju z textu pre model odstráni):
#   odpoveď: čakám|na vedomie          čo odosielateľ od odpovede čaká
#                                       (režim nečakám nová správa nemá, 2026-10-20)
#   id: <meno súboru>                   kľúč tejto správy
#   od: <odosielateľ>
#   komu: <adresát>
#   téma: <téma>                        prázdna pre hlavné vlákno
#   k: <id pôvodnej správy>             len odpoveď (--k), budič odosielateľa
#                                       podľa neho nájde vlákno a či čaká
# Odpoveď na prijatú správu je `--k <id>` s id z hlavičky správy, meno
# súboru môže byť ľubovoľné. Na serveri odpovedá aj reply.sh.
#
# Nová správa: téma musí byť v zozname tém adresáta (topics.json vedľa jeho
# inboxu, route.mjs), inak skript vypíše platné témy a nič neodošle. Adresát
# bez zoznamu prijme každú tému. Odpoveď s --k tému v zozname
# nekontroluje, trasu odpovede obnoví budič adresáta z `k:`. Do hlavného
# vlákna adresáta ide správa s --hlavne, bez témy.
#
# Na serveri zapíše trasu (route.mjs remember z koreňa tohto repa,
# ASK_WORKFLOW), budič potom odpoveď pošle do vlákna témy, z ktorého píšem.
# Chyba trasy odoslanie nezastaví, odpoveď príde do hlavného vlákna.
#
# --replies prečíta moju vlastnú schránku na serveri (/var/lib/<odosielateľ>/
# inbox, na Macu cez ssh), s témou len správy tejto témy a bez témy, a presunie
# ich do /var/lib/<odosielateľ>/processed pod jedinečné meno, takže sa
# neprečítajú dvakrát. Argument <adresát> pri --replies nič nemení, ostal
# z čias, keď sa čítal outbox adresáta. Dočítanie starých správ
# z outboxu sa už nerobí, staré správy tam sú na ručné prečítanie.
# Premenné sa zámerne rozbaľujú lokálne pred odoslaním príkazu.
# shellcheck disable=SC2029
set -euo pipefail

mode="čakám"
main=0
replies=0
k=""
dopad=""
args=()
while [ $# -gt 0 ]; do
    case "$1" in
        --hlavne) main=1 ;;
        --necakam)
            echo "Prepínač --necakam neexistuje: na odpoveď čakáš, nechaj predvolené. Hlásenie bez odpovede je --vedomie. Nič som neposlal." >&2
            exit 1 ;;
        --vedomie) mode="na vedomie" ;;
        --cakam) mode="čakám" ;;
        --replies) replies=1 ;;
        --k) k="${2:-}"; shift ;;
        --dopad) dopad="${2:-}"; shift ;;
        *) args+=("$1") ;;
    esac
    shift
done
set -- "${args[@]+"${args[@]}"}"

if [ "$mode" = "na vedomie" ] && [ -z "$k" ] && [ "$replies" = 0 ] && [ -z "${dopad//[[:space:]]/}" ]; then
    echo "Správa na vedomie bez --dopad: pošli ju len adresátovi, ktorému mení prácu, a --dopad povie čo. Nič som neposlal." >&2
    exit 1
fi

L=abcdefghijklmnopqrstuvwxyz
SNAKE="^[$L][${L}0123456789_]{0,30}$"

if [ "$replies" = 1 ]; then to="${1:-${ASK_DEFAULT_TO:-agent}}"; else to="${1:-}"; fi
if ! [[ "$to" =~ $SNAKE ]]; then
    echo "Adresát '$to' nie je snake_case, nič som neposlal." >&2
    exit 1
fi
if [ -n "$k" ] && ! [[ "$k" =~ ^[A-Za-z0-9._-]{1,160}$ ]]; then
    echo "Id pôvodnej správy '$k' má zlý tvar, nič som neposlal." >&2
    exit 1
fi

VARLIB="${ASK_VAR_LIB:-/var/lib}"
# Server alebo Mac.
host_var="$(echo "${to}" | tr '[:lower:]' '[:upper:]')_HOST"
HOST="${ASK_HOST:-${!host_var:-}}"
send_var="AGENT_SEND_${to}"
remote=0
if [ -n "$HOST" ]; then
    remote=1
elif [ -n "${!send_var:-}" ] || [ -d "$VARLIB/$to/inbox" ]; then
    remote=0
elif compgen -G "$VARLIB/*/inbox" >/dev/null; then
    remote=0   # sme na serveri, chýbajúcu schránku ohlási zápis
else
    remote=1
fi

if [ -n "${AGENT_NAME:-}" ]; then FROM="$AGENT_NAME"
elif [ -n "${ASK_FROM:-}" ]; then FROM="$ASK_FROM"
else
    echo "Chýba odosielateľ: nastav AGENT_NAME alebo ASK_FROM. Nič som neposlal." >&2
    exit 1
fi
if ! [[ "$FROM" =~ $SNAKE ]]; then
    echo "Odosielateľ '$FROM' nie je snake_case, nič som neposlal." >&2
    exit 1
fi

if [ "$remote" = 1 ]; then
    if [ -z "$HOST" ]; then
        echo "Chýba cieľ ssh: nastav ASK_HOST (účet@adresa servera). Nič som neposlal." >&2
        exit 1
    fi
    DIR="$VARLIB/$to"
    inbox="$DIR/inbox"
    if [ "$replies" = 1 ]; then
        # Vlastná schránka odosielateľa na serveri.
        inbox="$VARLIB/$FROM/inbox"
    fi
    processed="$(dirname "$inbox")/processed"
else
    ENV_FILE="${AGENT_ENV_FILE:-$HOME/.config/$FROM/runtime.env}"
    # shellcheck disable=SC1090
    if [ -f "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
    inbox="${!send_var:-$VARLIB/$to/inbox}"
    processed="$(dirname "$inbox")/processed"
    if [ "$replies" = 1 ]; then
        echo "Na serveri odpovede doručuje budič, --replies je pre Mac." >&2
        exit 1
    fi
fi

# Príkaz na strane schránky: ssh na Macu, bash na serveri.
on() {
    if [ "$remote" = 1 ]; then ssh "$HOST" "$1"; else bash -c "$1"; fi
}

# Téma. `-` (a pri --replies chýbajúca) = z prostredia alebo zo stavu
# relácie.
topic=""
if [ "$main" = 0 ]; then
    topic="${2:-}"
    if [ "$replies" = 0 ] && [ -z "$topic" ]; then
        echo "Chýba téma (alebo --hlavne), nič som neposlal." >&2
        exit 1
    fi
    if [ -z "$topic" ] || [ "$topic" = "-" ]; then
        topic=""
        tv="$(echo "$to" | tr '[:lower:]' '[:upper:]')_TOPIC"
        topic="${ASK_TOPIC:-${!tv:-}}"
        TOPICS="${TOPIC_STATE_DIR:-${CLAUDE_PROJECT_DIR:-$PWD}/.scratch/topics}"
        if [ -z "$topic" ] && [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then
            case "$CLAUDE_CODE_SESSION_ID" in
                *[!A-Za-z0-9-]*) ;;
                *) topic="$(cat "$TOPICS/sessions/$CLAUDE_CODE_SESSION_ID" 2>/dev/null || true)"
                   if [ -n "$topic" ]; then
                       holder="$(cat "$TOPICS/locks/$topic" 2>/dev/null || true)"
                       if [ "$holder" != "$CLAUDE_CODE_SESSION_ID" ]; then
                           echo "Tému '$topic' drží iná relácia (${holder:-bez zámku}), nič som neposlal ani neprečítal." >&2
                           exit 1
                       fi
                   fi ;;
            esac
        fi
    fi
    if [ -n "$topic" ] && ! [[ "$topic" =~ ^[$L][${L}0123456789_]{1,40}$ ]]; then
        echo "Téma '$topic' nie je snake_case, nič som neposlal ani neprečítal." >&2
        exit 1
    fi
fi

if [ "$replies" = 1 ]; then
    # Odpoveď sa najprv presunie do processed pod jedinečné meno a až potom
    # vypíše, z dvoch súbežných behov ju vypíše len jeden.
    rc=0
    on "cd $inbox && found=0 && for f in *; do [ -f \"\$f\" ] || continue; case \"\$f\" in *.tmp) continue;; esac; if [ -n \"$topic\" ]; then t=\"\$(sed -n 's/^téma: *//p;/^\$/q' \"\$f\" | head -n1)\"; if [ -n \"\$t\" ] && [ \"\$t\" != \"$topic\" ]; then continue; fi; fi; d=$processed/\"\$f\".\$(date +%H%M%S).\$\$.reply; mv \"\$f\" \"\$d\" 2>/dev/null || continue; found=1; echo \"=== \$f\"; cat \"\$d\"; echo; done; [ \$found = 1 ] || exit 3" || rc=$?
    case "$rc" in
        0) exit 0 ;;
        3) echo "Žiadna neprečítaná odpoveď nečaká." >&2; exit 2 ;;
        *) echo "Schránku adresáta $to sa nepodarilo prečítať, kód $rc." >&2; exit 1 ;;
    esac
fi

if [ "$main" = 1 ]; then shift 1; else shift 2; fi
if [ $# -gt 0 ]; then text="$*"; else text="$(cat)"; fi
if [ -z "$text" ]; then
    echo "Prázdna správa, nič som neposlal." >&2
    exit 1
fi

# Adresát z ASK_URGENT_ONLY prijíma z Macu len súrne a blokujúce správy
# (nesmie byť zahltený priamymi správami).
if [ "$remote" = 1 ] && [[ ",${ASK_URGENT_ONLY:-}," == *",$to,"* ]] && [ "${ASK_URGENT:-}" != 1 ]; then
    echo "Kanál adresáta $to je len pre súrne a blokujúce správy. Ostatné pošli správcovi agentov. Súrnu pošli s ASK_URGENT=1." >&2
    exit 1
fi

# Zoznam tém adresáta leží vedľa jeho inboxu, adresát bez neho prijme každú tému.
# Riadok témy v topics.json je ` "<téma>": {` (route.mjs).
topics_file="$(dirname "$inbox")/topics.json"
check=""
if [ -n "$topic" ] && [ -z "$k" ]; then
    check="if [ -f $topics_file ] && ! grep -q '^ \"$topic\": {' $topics_file; then sed -n 's/^ \"\\([a-z0-9_]*\\)\": {.*/\\1/p' $topics_file | paste -sd, -; exit 4; fi"
    rc=0
    out="$(on "$check")" || rc=$?
    if [ "$rc" = 4 ]; then
        echo "Téma '$topic' nie je v zozname tém adresáta $to, nič som neposlal. Platné témy: ${out:-žiadna}. Do hlavného vlákna pošli s --hlavne." >&2
        exit 1
    elif [ "$rc" != 0 ]; then
        echo "Zoznam tém adresáta $to sa nepodarilo overiť, kód $rc, nič som neposlal." >&2
        exit 1
    fi
fi

name="$FROM-${topic:+$topic-}$(date +%Y%m%d-%H%M%S)-$$.md"
payload="$(printf 'odpoveď: %s\nid: %s\nod: %s\nkomu: %s\ntéma: %s\n' "$mode" "$name" "$FROM" "$to" "$topic")"
[ -n "$k" ] && payload="$payload"$'\n'"k: $k"
[ -n "$dopad" ] && payload="$payload"$'\n'"dopad: $dopad"
payload="$payload"$'\n'"$text"

if [ "$remote" = 1 ]; then
    # Dočasný súbor s bodkou budič ignoruje, mv ho zverejní naraz.
    rc=0
    printf '%s\n' "$payload" | ssh "$HOST" "umask 007; cat > $inbox/.$name.tmp && mv $inbox/.$name.tmp $inbox/$name" || rc=$?
    if [ "$rc" != 0 ]; then
        echo "Správu na $HOST sa nepodarilo zapísať, ssh skončilo kódom $rc." >&2
        exit 1
    fi
    echo "Odoslané ako $name (odpoveď: $mode). Odpovede: $0 --replies $to" >&2
    exit 0
fi

if [ ! -d "$inbox" ]; then
    echo "Schránka adresáta $inbox neexistuje, nič som neposlal." >&2
    exit 1
fi
umask 007
printf '%s\n' "$payload" > "$inbox/.$name.tmp"
# Skupina schránky, keď ju priečinok nededí (setgid), inak ju budič nečíta.
chgrp --reference="$inbox" "$inbox/.$name.tmp" 2>/dev/null || true
mv "$inbox/.$name.tmp" "$inbox/$name"
echo "Odoslané $inbox/$name (odpoveď: $mode)" >&2
WORKFLOW="${ASK_WORKFLOW:-$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)}"
if [ -f "$WORKFLOW/route.mjs" ]; then
    # Odpoveď (--k) obnoví trasu pôvodnej správy, nová správa zapíše vlastnú.
    if [ -n "$k" ]; then
        node "$WORKFLOW/route.mjs" remember "$k" --mode "$mode" >&2 || true
    else
        node "$WORKFLOW/route.mjs" remember "$name" --peer "$to" --mode "$mode" >&2 || true
    fi
else
    echo "route: $WORKFLOW/route.mjs chýba, trasa sa nezapísala, odpoveď príde do hlavného vlákna" >&2
fi
