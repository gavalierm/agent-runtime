#!/bin/bash
# Zrušené meno nesmie ostať v gite. Prejde súbory indexu repa (git grep
# --cached) podľa vzorov v lib/retired_names.txt a pri náleze vypíše
# súbor:riadok a skončí kódom 1.
#
#   bash lib/retired_names.sh [repo ...]   bez argumentu repo z cwd
#
# Volá ju open_branch_guard.sh v hooku pre-commit každého repa a check.mjs
# pre repo kódu a repá agentov. Výnimka je len tento súbor, zoznam
# vzorov a test, inde sa zrušené meno nepíše ani v histórii rozhodnutí.
set -u

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=deny.sh
source "$here/deny.sh"
list="${RETIRED_NAMES_LIST:-$here/retired_names.txt}"
if [ ! -f "$list" ]; then
    deny_postup "retired_names: chýba $list" \
        "obnov lib/retired_names.txt z repa kódu (git -C $here/.. show HEAD:lib/retired_names.txt > $list)"
    exit 2
fi

args=()
while IFS= read -r enc; do
    [ -z "$enc" ] || [ "${enc:0:1}" = "#" ] && continue
    args+=(-e "$(printf '%s' "$enc" | base64 -d)")
done < "$list"
[ "${#args[@]}" -gt 0 ] || exit 0

[ "$#" -gt 0 ] || set -- "$(git rev-parse --show-toplevel)"
bad=0
for repo in "$@"; do
    hits="$(git -C "$repo" grep --cached -n -I -i -E "${args[@]}" -- . \
        ':!lib/retired_names.txt' ':!lib/retired_names.sh' ':!lib/retired_names.test.sh' 2>/dev/null)"
    if [ -n "$hits" ]; then
        printf '%s\n' "$hits" | sed "s|^|$repo/|" | head -50 >&2 # info
        deny_postup "retired_names: $repo má $(printf '%s\n' "$hits" | wc -l) riadkov so zrušeným menom (lib/retired_names.txt)." \
            "zmaž alebo prepíš vypísané riadky (súbor:riadok vyššie) na aktuálne meno a commit zopakuj."
        bad=1
    fi
done
exit "$bad"
