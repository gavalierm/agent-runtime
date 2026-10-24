#!/usr/bin/env bash
# Jednorazová stránka, cez ktorú operátor odovzdá tajomstvo do súboru s právami 600
# pod používateľom agenta. Hodnota neprejde prepisom vlákna T3, databázou T3,
# argumentom ani výpisom. Server stránky je runtime/secret_drop.mjs, tu je len
# spúšťač pod používateľom a sprístupnenie v tailnete.
#
# Použitie: runtime/secret_drop.sh --user <meno> --dir <priečinok>
#   --field <súbor[:druh[:popis]]> ... [--serve] [--port 8804] [--ttl 900]
# --serve  na čas behu pridá cestu `tailscale serve --https=<port>` na stránku
#          a po skončení ju zruší. Bez neho stránka beží len na 127.0.0.1
#          (skúšky). Prvý riadok výstupu je odkaz pre operátora, spúšťaj preto
#          na pozadí a odkaz prečítaj z výstupu. Posledný riadok pri kóde 0 je
#          {"saved":[...]}. Kód 3 vypršal čas (--ttl, predvolene 900 s).
# Druhy polí: secret (heslo), text (kód), textarea, json. Podrobnosti sú
# v hlavičke secret_drop.mjs. Do výpisu a argumentov sa hodnota nedostane.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
die() { echo "secret_drop.sh: $*" >&2; exit "${2:-1}"; }
user="" dir="" serve=0 port=8804 ttl=900 fields=()
while [ $# -gt 0 ]; do
  case "$1" in
    --user) [ $# -ge 2 ] || die "--user chce hodnotu" 2; user="$2"; shift 2 ;;
    --dir) [ $# -ge 2 ] || die "--dir chce hodnotu" 2; dir="$2"; shift 2 ;;
    --field) [ $# -ge 2 ] || die "--field chce hodnotu" 2; fields+=(--field "$2"); shift 2 ;;
    --port) [ $# -ge 2 ] || die "--port chce hodnotu" 2; port="$2"; shift 2 ;;
    --ttl) [ $# -ge 2 ] || die "--ttl chce hodnotu" 2; ttl="$2"; shift 2 ;;
    --serve) serve=1; shift ;;
    *) die "neznámy argument $1" 2 ;;
  esac
done
[ "$(id -u)" -eq 0 ] || die "spúšťa sa pod rootom (runuser vyžaduje root)" 2
[ -n "$user" ] && [ -n "$dir" ] && [ "${#fields[@]}" -gt 0 ] || die "chýba --user, --dir alebo --field" 2
id "$user" >/dev/null 2>&1 || die "používateľ $user neexistuje" 2
[ "$user" != root ] || die "tajomstvá agenta nepatria rootovi" 2
[[ "$port" =~ ^[0-9]+$ ]] && [[ "$ttl" =~ ^[0-9]+$ ]] || die "--port a --ttl chcú číslo" 2
# Priečinok ani súbory nevytvára root, vlastníkom ostáva používateľ.
[ "$(stat -c %U "$dir")" = "$user" ] || die "$dir nepatrí používateľovi $user" 2

tmp="$(mktemp -d /tmp/secret-drop.XXXXXX)"
served=0
cleanup() {
  [ "$served" -eq 1 ] && tailscale serve --https="$port" off >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
cp "$HERE/secret_drop.mjs" "$tmp/"
chown -R "$user":"$user" "$tmp"
chmod 700 "$tmp"

pub=()
if [ "$serve" -eq 1 ]; then
  dns="$(tailscale status --json | python3 -I -c 'import json,sys;print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')"
  [ -n "$dns" ] || die "nezistil som názov stroja v tailnete"
  tailscale serve --bg --https="$port" "http://127.0.0.1:$port" >/dev/null
  served=1
  pub=(--public-base "https://$dns:$port")
fi

rc=0
runuser -u "$user" -- env -i HOME="$(getent passwd "$user" | cut -d: -f6)" PATH="$PATH" LANG="${LANG:-C.UTF-8}" \
  node "$tmp/secret_drop.mjs" --dir "$dir" --port "$port" --ttl "$ttl" "${pub[@]}" "${fields[@]}" || rc=$?
exit "$rc"
