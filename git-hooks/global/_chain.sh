#!/bin/bash
# Spoločný základ globálnych git hookov (úloha Taskera 565): spustí lokálny hook
# repa "$(git rev-parse --git-common-dir)/hooks/<meno>" s rovnakými argumentmi a stdin.
# Globálny core.hooksPath by ho inak prekryl. Bez lokálneho hooku alebo bez
# práva spustenia nerobí nič. Každý hook zo zoznamu je odkaz na _chain.sh, meno
# hooku berie z názvu odkazu. Globálny core.hooksPath platí len pre repá bez
# lokálneho core.hooksPath, repá agentov s .githooks ostávajú na svojom.
name="${CHAIN_NAME:-$(basename "$0")}"
# Nie --git-path hooks/<meno>: s core.hooksPath ukáže späť na tento hook (slučka).
common="$(git rev-parse --git-common-dir 2>/dev/null)"
local_hook="${common:+$common/hooks/$name}"
if [ -n "$local_hook" ] && [ -f "$local_hook" ] && [ -x "$local_hook" ]; then
    unset CHAIN_NAME
    exec "$local_hook" "$@"
fi
exit 0
