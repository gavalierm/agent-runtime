#!/bin/bash
# Stiahne klony kódu a spoločného mozgu agentov. Keď pull posunie HEAD a zmení
# RULES.md klonu kódu, RULES.md alebo env/server/ spoločného mozgu, zapíše
# správu pravidla-* do schránok z AR_INBOXES. Služba má AR_INBOXES prázdne,
# zmenu vloží do ťahu relácie hook rules_delta.mjs. Spúšťa ho
# agentic-workflow-sync.service. Zlyhanie zápisu do schránky pull nezastaví,
# ide len do journalu.
#
# Správa má prvý riadok `odpoveď: na vedomie`: budič agenta ju nebudí, drží ju
# do najbližšej budiacej dávky (README.md, časť Budenie). Keď v schránke ešte
# leží neodoslaná pravidla-*, skript ju zmaže a napíše jednu s rozsahom od jej
# starého HEAD po nový, diff sa nezdvojí. Riadok `Zmena <klon> <od>..<do>`
# nesie rozsah každého klonu: `workflow` (klon kódu) a `brain` (mozog).
#
# AR_CLONES (dve cesty oddelené medzerou: klon kódu, klon mozgu) a AR_INBOXES
# (cesty oddelené medzerou) menia cesty, používa ich test. Bez AR_CLONES sú
# to workflow_dir a brain_global_dir z lib/paths.sh. Bez AR_INBOXES skript
# nepíše nikam. Predvolená cesta do živej schránky tu nie je, test by do nej
# zapísal.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../../lib/paths.sh
. "$HERE/../../lib/paths.sh"
if [ -n "${AR_CLONES:-}" ]; then
    read -r -a CLONES <<< "$AR_CLONES"
else
    CLONES=("$(workflow_dir)" "$(brain_global_dir)")
fi
if [ "${#CLONES[@]}" -ne 2 ]; then
    echo "AR_CLONES musí mať dve cesty: klon kódu a klon mozgu." >&2
    exit 1
fi
LABELS=(workflow brain)
# Sledované cesty: RULES.md kódu, RULES.md a env/server/ mozgu.
WATCH=("RULES.md" "RULES.md env/server/")
read -r -a INBOXES <<< "${AR_INBOXES:-}"

# changed klon-index od do: je v sledovaných cestách klonu rozdiel?
changed() {
    # shellcheck disable=SC2086
    [ -n "$(git -C "${CLONES[$1]}" diff --stat "$2..$3" -- ${WATCH[$1]})" ]
}

OLD=() NEW=()
any=0
for i in 0 1; do
    c="${CLONES[$i]}"
    old="$(git -C "$c" rev-parse --short HEAD)" || exit 1
    git -C "$c" pull --ff-only -q || exit 1
    new="$(git -C "$c" rev-parse --short HEAD)"
    OLD[i]="$old"
    NEW[i]="$new"
    if [ "$old" != "$new" ] && changed "$i" "$old" "$new"; then any=1; fi
done
[ "$any" = 0 ] && exit 0

name="pravidla-$(date +%Y%m%d-%H%M%S)-$$.md"
# message <od-workflow> <od-brain>: text správy, rozsah od zadaného HEAD po nový
message() {
    local from=("$1" "$2") i c
    echo "odpoveď: na vedomie"
    echo "[pravidlá] Zmena pravidiel. Platí hneď a nahrádza znenie z načítaného RULES.md. Odpoveď sa nepíše."
    for i in 0 1; do
        c="${CLONES[$i]}"
        changed "$i" "${from[$i]}" "${NEW[$i]}" || continue
        echo
        echo "Zmena ${LABELS[$i]} ${from[$i]}..${NEW[$i]}"
        # shellcheck disable=SC2086
        git -C "$c" log --format='%h %s' "${from[$i]}..${NEW[$i]}" -- ${WATCH[$i]}
        echo
        # shellcheck disable=SC2086
        git -C "$c" diff "${from[$i]}..${NEW[$i]}" -- ${WATCH[$i]}
    done
}
for box in "${INBOXES[@]}"; do
    from=("${OLD[0]}" "${OLD[1]}")
    # Neodoslaná správa v schránke: jej začiatok je začiatok novej, stará sa zmaže.
    for prev in "$box"/pravidla-*.md; do
        [ -f "$prev" ] || continue
        for i in 0 1; do
            start="$(grep -m1 -oE "^Zmena ${LABELS[$i]} [0-9a-f]+\.\." "$prev" | sed -E "s/^Zmena ${LABELS[$i]} ([0-9a-f]+)\.\./\1/")"
            if [ -n "$start" ] && git -C "${CLONES[$i]}" cat-file -e "$start^{commit}" 2>/dev/null; then
                from[i]="$start"
            fi
        done
        rm -f "$prev"
    done
    if ! { message "${from[0]}" "${from[1]}" > "$box/.$name.tmp" && mv "$box/.$name.tmp" "$box/$name"; }; then
        echo "Zápis správy $name do $box zlyhal." >&2
        rm -f "$box/.$name.tmp"
    fi
done
exit 0
