#!/bin/bash
# Prehliadač pre agenta: Chrome so sandboxom pod používateľom AGENT_BROWSER_USER
# (alebo AGENT_TASKER_USER), snímky obrazovky, text stránky a chyby konzoly.
# Agent beží pod rootom, /root je 700 a iný používateľ doň nevidí, preto skript
# všetko, čo prehliadač potrebuje, skopíruje do dočasného priečinka a výsledky
# skopíruje späť.
#
# Použitie: browser.sh (--url <url> | --file <html>) [--width 1440,390]
#   [--height 900] [--full-page] [--text] [--gaps [px]]
#   [--steps <súbor json | pole json>] [--out <priečinok>]
# --gaps [px] nájde texty nalepené pod sebou (medzera pod px, predvolene 6),
# nález zapíše do gaps-<šírka>.txt, vypíše ho a skončí kódom 1.
# --file skopíruje aj priečinok súboru (relatívne odkazy), nesmie mať nad
# 50 MB. Kroky a výstupné súbory opisuje browser/browser.mjs. Predvolený
# --out je $AGENT_WORKDIR/.scratch/browser/<čas> (bez AGENT_WORKDIR aktuálny priečinok). Vypíše cesty k vzniknutým
# súborom, kód 0 v poriadku, 1 chyba alebo zlyhaný krok, 2 zlé použitie.
# Balík playwright-core sa nainštaluje do ~<používateľ>/.cache/agent-browser
# (npm ci), znova len keď sa zmení hash browser/package-lock.json.
#
# Používateľ a trvalý profil (osobný agent s vlastným profilom):
#   --user <meno>      Chrome beží pod týmto používateľom, predvolene
#                      AGENT_BROWSER_USER alebo AGENT_TASKER_USER. Používateľ musí existovať.
#   --profile <názov>  trvalý profil prehliadača (cookies, prihlásenie)
#                      v ~<používateľ>/.local/share/agent-browser/profiles/<názov>,
#                      práva 700. Názov má tvar [a-z0-9][a-z0-9-]*. Súčasne
#                      ho môže používať jeden beh, druhý skončí kódom 1.
#   --exec <skript.mjs> [--env NAME]... [--timeout <s>] [-- argumenty skriptu]
#                      namiesto browser.mjs spustí skript pod týmto používateľom
#                      s Chrome sandboxom. Skopíruje sa celý priečinok skriptu
#                      (nad 50 MB odmietne). Stdin, stdout, stderr a kód skriptu
#                      idú priamo cez, snímky ani --out sa nevytvárajú. Skript
#                      dostane BROWSER_PROFILE_DIR (s --profile) a BROWSER_SESSION,
#                      cestu k browser/session.mjs (openProfile). Premenné
#                      z okolia sa odovzdajú len cez --env NAME. --timeout
#                      predvolene 120 s.
set -euo pipefail

USER_B="${AGENT_BROWSER_USER:-${AGENT_TASKER_USER:-}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT=""
mjs_args=()
file="" steps="" profile="" exec_script="" exec_timeout=120
exec_args=() exec_env=()

die() { echo "browser.sh: $*" >&2; exit "${2:-1}"; }
[ "$(id -u)" -eq 0 ] || die "spúšťa sa pod rootom (runuser vyžaduje root)"

while [ $# -gt 0 ]; do
  case "$1" in
    --url) [ $# -ge 2 ] || die "--url chce hodnotu" 2; mjs_args+=(--url "$2"); shift 2 ;;
    --file) [ $# -ge 2 ] || die "--file chce hodnotu" 2; file="$2"; shift 2 ;;
    --width|--height) [ $# -ge 2 ] || die "$1 chce hodnotu" 2; mjs_args+=("$1" "$2"); shift 2 ;;
    --steps) [ $# -ge 2 ] || die "--steps chce hodnotu" 2; steps="$2"; shift 2 ;;
    --out) [ $# -ge 2 ] || die "--out chce hodnotu" 2; OUT="$2"; shift 2 ;;
    --user) [ $# -ge 2 ] || die "--user chce hodnotu" 2; USER_B="$2"; shift 2 ;;
    --profile) [ $# -ge 2 ] || die "--profile chce hodnotu" 2; profile="$2"; shift 2 ;;
    --exec) [ $# -ge 2 ] || die "--exec chce hodnotu" 2; exec_script="$2"; shift 2 ;;
    --env) [ $# -ge 2 ] || die "--env chce hodnotu" 2
      [[ "$2" =~ ^[A-Z][A-Z0-9_]*$ ]] || die "--env chce názov premennej veľkými písmenami" 2
      exec_env+=("$2"); shift 2 ;;
    --timeout) [ $# -ge 2 ] || die "--timeout chce hodnotu" 2
      [[ "$2" =~ ^[0-9]+$ ]] && [ "$2" -ge 1 ] || die "--timeout chce celé číslo sekúnd" 2
      exec_timeout="$2"; shift 2 ;;
    --) shift; exec_args=("$@"); break ;;
    --full-page|--text) mjs_args+=("$1"); shift ;;
    --gaps) mjs_args+=(--gaps); shift
      if [ $# -gt 0 ] && [[ "$1" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then mjs_args+=("$1"); shift; fi ;;
    *) die "neznámy argument $1" 2 ;;
  esac
done
[ -n "$USER_B" ] || die "chýba používateľ: --user alebo AGENT_BROWSER_USER" 2
[[ "$USER_B" =~ ^[a-z_][a-z0-9_-]*$ ]] || die "zlé meno používateľa $USER_B" 2
HOME_B="$(getent passwd "$USER_B" | cut -d: -f6)"
[ -n "$HOME_B" ] && [ -d "$HOME_B" ] || die "používateľ $USER_B neexistuje" 2
[ "$USER_B" != root ] || die "Chrome so sandboxom pod rootom nebeží, zvoľ iného používateľa" 2
INST="${AGENT_BROWSER_INST:-$HOME_B/.cache/agent-browser}"
[ -z "$profile" ] || [[ "$profile" =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "názov profilu má tvar [a-z0-9][a-z0-9-]*" 2
[ -z "$exec_script" ] || [ -f "$exec_script" ] || die "skript $exec_script neexistuje" 2
if [ -n "$exec_script" ]; then
  [ -z "$file" ] && [ "${#mjs_args[@]}" -eq 0 ] || die "--exec sa nespája s --url, --file ani voľbami snímok" 2
else
  [ "${#exec_args[@]}" -eq 0 ] || die "argumenty za -- patria len k --exec" 2
  [ -z "$file" ] || [ -f "$file" ] || die "súbor $file neexistuje" 2
  [ "${#mjs_args[@]}" -gt 0 ] || [ -n "$file" ] || die "chýba --url alebo --file" 2
fi
OUT="${OUT:-${AGENT_WORKDIR:-$PWD}/.scratch/browser/$(date +%Y%m%d-%H%M%S)}"

# env -i: prostredie roota (tokeny, cesty) sa nesmie dostať k používateľovi.
as_b() { runuser -u "$USER_B" -- env -i HOME="$HOME_B" USER="$USER_B" PATH="$PATH" LANG="${LANG:-C.UTF-8}" "$@"; }

tmp="$(mktemp -d /tmp/agent-browser.XXXXXX)"
trap 'rm -rf "$tmp"' EXIT
chown "$USER_B":"$USER_B" "$tmp"
chmod 700 "$tmp"

# Inštalácia balíka, len keď sa hash zámku líši od uloženého.
want="$(sha256sum "$HERE/browser/package-lock.json" | cut -d' ' -f1)"
(
  flock 9
  if [ ! -d "$INST/node_modules/playwright-core" ] || [ "$(cat "$INST/.lock.sha256" 2>/dev/null)" != "$want" ]; then
    as_b mkdir -p "$INST"
    cp "$HERE/browser/package.json" "$HERE/browser/package-lock.json" "$INST/"
    chown "$USER_B":"$USER_B" "$INST/package.json" "$INST/package-lock.json"
    as_b sh -c 'cd "$1" && rm -rf node_modules && npm ci --ignore-scripts --no-audit --no-fund' _ "$INST" >&2
    echo "$want" | as_b tee "$INST/.lock.sha256" >/dev/null
  fi
) 9>/run/lock/agent-browser-install.lock

pdir=""
if [ -n "$profile" ]; then
  pbase="$HOME_B/.local/share/agent-browser"
  pdir="$pbase/profiles/$profile"
  as_b mkdir -p "$pbase/profiles"
  as_b chmod 700 "$pbase" "$pbase/profiles"
  as_b install -d -m 700 "$pdir"
  as_b chmod 700 "$pdir"
  # Chrome nepustí dva behy do jedného profilu, druhý beh preto hneď skončí.
  exec 8>"/run/lock/agent-browser-profile-$USER_B-$profile.lock"
  flock -n 8 || die "profil $profile sa práve používa"
fi

if [ -n "$exec_script" ]; then
  cp "$HERE/browser/session.mjs" "$tmp/"
  edir="$(dirname "$(readlink -f "$exec_script")")"
  kb="$(du -sk "$edir" | cut -f1)"
  [ "$kb" -le 51200 ] || die "priečinok $edir má $((kb / 1024)) MB, nad 50 MB ho nekopírujem" 2
  mkdir "$tmp/exec"
  cp -r --no-dereference "$edir/." "$tmp/exec/"
  chown -R "$USER_B":"$USER_B" "$tmp"
  envargs=(BROWSER_SESSION="$tmp/session.mjs")
  [ -z "$pdir" ] || envargs+=(BROWSER_PROFILE_DIR="$pdir")
  for n in "${exec_env[@]}"; do
    [ -z "${!n+x}" ] || envargs+=("$n=${!n}")
  done
  rc=0
  # sh -c: $0 = INST, $1 = priečinok skriptu, $2 = limit v s, $3 = skript, ďalej jeho argumenty
  as_b env "${envargs[@]}" sh -c 'cd "$1" && t="$2" && s="$3" && shift 3 && NODE_PATH="$0/node_modules" exec timeout -k 5 "$t" node "$s" "$@"' \
    "$INST" "$tmp/exec" "$exec_timeout" "$(basename "$exec_script")" "${exec_args[@]}" || rc=$?
  exit "$rc"
fi

[ -z "$pdir" ] || mjs_args+=(--profile-dir "$pdir")
cp "$HERE/browser/browser.mjs" "$HERE/browser/gaps.mjs" "$HERE/browser/session.mjs" "$tmp/"
if [ -n "$file" ]; then
  dir="$(dirname "$(readlink -f "$file")")"
  kb="$(du -sk "$dir" | cut -f1)"
  [ "$kb" -le 51200 ] || die "priečinok $dir má $((kb / 1024)) MB, nad 50 MB ho nekopírujem" 2
  mkdir "$tmp/in"
  cp -r --no-dereference "$dir/." "$tmp/in/"
  mjs_args+=(--file "in/$(basename "$file")")
fi
if [ -n "$steps" ]; then
  if [ -f "$steps" ]; then cp "$steps" "$tmp/steps.json"; else printf '%s' "$steps" > "$tmp/steps.json"; fi
  mjs_args+=(--steps steps.json)
fi
chown -R "$USER_B":"$USER_B" "$tmp"

rc=0
# sh -c: $0 = INST, $1 = tmp, ďalej argumenty browser.mjs
as_b sh -c 'cd "$1" && shift && NODE_PATH="$0/node_modules" exec timeout -k 5 120 node browser.mjs "$@"' \
  "$INST" "$tmp" --out res "${mjs_args[@]}" > "$tmp/list.txt" || rc=$?
mkdir -p "$OUT"
[ -d "$tmp/res" ] && cp -r --no-dereference "$tmp/res/." "$OUT/"
while IFS= read -r f; do echo "$OUT/$f"; done < "$tmp/list.txt"
for f in "$OUT"/gaps-*.txt; do [ -s "$f" ] && { echo "--- $(basename "$f")"; cat "$f"; }; done 2>/dev/null || true
exit "$rc"
