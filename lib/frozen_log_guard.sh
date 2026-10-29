#!/bin/bash
# Zábrana zmeny zmrazeného logu rozhodnutí (návrh úlohy 390, kontrola K6).
# Volá ju open_branch_guard.sh v hooku pre-commit každého repa, z nasadeného
# klonu kódu (workflow_dir v lib/paths.sh). Kód 0 commit pustí, 1 odmietne.
#
# Zmrazený log je DECISIONS.md alebo SCHVALENE.md, ktorý má v prvých 10
# riadkoch hlavičku archívu "Archív do RRRR-MM-DD, nie je zdroj" alebo značku
# `<!-- rozhodnutia: zmrazene -->` (tú číta hook rozhodnutia_guard.mjs).
# Platné rozhodnutia sú v decisions/ spoločného mozgu, zapisuje ich
# bin/rozhodni.sh.
#
# Odmietne každý commit, ktorý mení, maže alebo premenúva log, ktorý je
# zmrazený v HEAD. Log, ktorý ešte zmrazený nie, prejde. Hlavičku mu pridá
# commit, ktorý len pridáva riadky v prvých 10 riadkoch, nič iné nemení.
# Výnimka neexistuje: OPEN_BRANCH_GUARD_SKIP túto kontrolu nevypne.
#
# Súbor zmrazí len commit s hlavičkou, odvtedy ho nikto neprepíše. Záznamy
# po zmrazení patria do decisions/, nie do archívu.
set -u

cd "$(git rev-parse --show-toplevel)" || exit 1
# shellcheck source=deny.sh
source "$(dirname "${BASH_SOURCE[0]}")/deny.sh"

LOG='(^|/)(DECISIONS|SCHVALENE)\.md$'
HDR='^Archív do [0-9]{4}-[0-9]{2}-[0-9]{2}, nie je zdroj|^<!-- rozhodnutia: zmrazene -->'

# frozen <objekt>: prvých 10 riadkov objektu nesie hlavičku archívu.
frozen() {
    git cat-file -e "$1" 2>/dev/null && git show "$1" 2>/dev/null | head -n 10 | grep -qE "$HDR"
}

status=0
while IFS= read -r f; do
    [ -z "$f" ] && continue
    grep -qE "$LOG" <<<"$f" || continue
    if frozen "HEAD:$f"; then
        deny_postup "Commit odmietnutý: $f je zmrazený archív (hlavička \"Archív do ...\"), nikto ho nemení." \
            "vyrad $f z commitu (git restore --staged $f) a rozhodnutie zapíš skriptom bin/rozhodni.sh, záznamy sú v decisions/."
        status=1
        continue
    fi
    # Ešte nezmrazený log: s hlavičkou v indexe smie byť zmena len pridaním
    # riadkov na začiatok súboru.
    if frozen ":$f"; then
        diff="$(git diff --cached --no-renames -U0 -- "$f")"
        removed="$(grep -c '^-[^-]' <<<"$diff")"
        late="$(sed -n 's/^@@ -[0-9,]* +\([0-9]*\).*/\1/p' <<<"$diff" | awk '$1 > 10' | wc -l)"
        if git cat-file -e "HEAD:$f" 2>/dev/null && { [ "$removed" -gt 0 ] || [ "$late" -gt 0 ]; }; then
            deny_postup "Commit odmietnutý: $f dostáva hlavičku archívu a zároveň iné zmeny." \
                "hlavičku archívu pridaj samostatným commitom, ktorý v $f nič iné nemení, ostatné zmeny daj do ďalšieho commitu."
            status=1
        fi
    fi
done < <(git diff --cached --no-renames --name-only)

exit "$status"
