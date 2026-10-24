#!/bin/sh
# Zobudí agenta na Macu pri novej správe "odpoveď: čakám" v jeho schránke
# na serveri. Spúšťa ho mac-wake.path pri zmene schránky, model sa nevolá.
# Webhook je plánovaná úloha T3 na Macu viazaná na vlákno agenta, URL s tokenom
# je v /home/<agent>/mac_webhook_url (600, vlastník agent), curl beží ako
# agent. Správa sa zapíše do stavu až po úspešnom volaní, Mac v spánku teda
# zobudí najbližšia zmena schránky alebo správa od operátora.
# Premenné: MAC_WAKE_AGENT (meno agenta na Macu, povinné), MAC_WAKE_INBOX,
# MAC_WAKE_STATE, MAC_WAKE_CMD.
set -u
AG=${MAC_WAKE_AGENT:?MAC_WAKE_AGENT}
INBOX=${MAC_WAKE_INBOX:-/var/lib/$AG/inbox}
STATE=${MAC_WAKE_STATE:-/var/lib/$AG-wake/notified}
# Predvolený príkaz mimo ${:-}, tam by sa jednoduché úvodzovky odstránili.
DEFAULT_CMD='runuser -u '"$AG"' -- sh -c '"'"'curl -s -S -f -m 10 -X POST -o /dev/null "$(cat /home/'"$AG"'/mac_webhook_url)"'"'"
CMD=${MAC_WAKE_CMD:-$DEFAULT_CMD}

mkdir -p "$(dirname "$STATE")"
touch "$STATE"
new=""
for f in "$INBOX"/*; do
  [ -f "$f" ] || continue
  id=$(basename "$f")
  head -n 1 "$f" | grep -q '^odpoveď: čakám' || continue
  grep -qxF "$id" "$STATE" && continue
  new="$new$id
"
done
[ -n "$new" ] || exit 0
if sh -c "$CMD"; then
  # Stav drží len správy, ktoré v schránke ešte ležia.
  tmp="$STATE.tmp"
  { cat "$STATE"; printf '%s' "$new"; } | while read -r id; do
    [ -n "$id" ] && [ -f "$INBOX/$id" ] && echo "$id"
  done | sort -u > "$tmp"
  mv "$tmp" "$STATE"
  echo "mac-wake: webhook zavolaný pre $(printf '%s' "$new" | wc -l) správ"
else
  echo "mac-wake: webhook zlyhal (Mac spí?), správy ostávajú na ďalšiu zmenu" >&2
fi
