#!/bin/bash
# Zábrana proti konfliktu medzi main a otvorenou vetvou. Volá ju hook
# pre-commit repa, z nasadeného klonu kódu (workflow_dir v lib/paths.sh).
# Kód 0 commit pustí, 1 odmietne.
#
# Na main: stiahne origin, nájde vetvy origin/*, ktoré nie sú zlúčené do
# main, a keď niektorá mení súbor z indexu commitu, commit odmietne.
# Zmena patrí na tú vetvu, alebo sa vetva najprv zlúči.
# Na inej vetve: vetva musí mať origin/main za sebou (rebase), inak commit
# odmietne s príkazom na rebase.
#
# Výnimka len s dôvodom: OPEN_BRANCH_GUARD_SKIP="<dôvod>" git commit ...
# Kontrolu zrušených mien (lib/retired_names.sh) výnimka nevypne.
# Dôvod sa vypíše, prázdna hodnota výnimkou nie je.
#
# Chyba 19. 10. 2026: vetva refaktoru pravidiel v repe agenta bola otvorená
# hodiny, iné vlákno commitlo na main ten istý odsek CLAUDE.md, zlúčenie
# skončilo konfliktom. Druhý výskyt 18. 10. 2026.
#
# Premenné testu: OPEN_BRANCH_GUARD_REMOTE (predvolené origin),
# OPEN_BRANCH_GUARD_MAIN (predvolené main), OPEN_BRANCH_GUARD_FETCH_TIMEOUT
# (sekundy, predvolené 10).
set -u

# shellcheck source=deny.sh
source "$(dirname "${BASH_SOURCE[0]}")/deny.sh"
remote="${OPEN_BRANCH_GUARD_REMOTE:-origin}"
main="${OPEN_BRANCH_GUARD_MAIN:-main}"
fetch_timeout="${OPEN_BRANCH_GUARD_FETCH_TIMEOUT:-10}"

# Zrušené meno v indexe commit odmietne vždy, aj s výnimkou nižšie
# (lib/retired_names.sh, 19. 10. 2026).
bash "$(dirname "${BASH_SOURCE[0]}")/retired_names.sh" || exit 1

# Zmrazený log (DECISIONS.md, SCHVALENE.md s hlavičkou archívu) commit
# odmietne tiež vždy, aj s výnimkou (lib/frozen_log_guard.sh, úloha 390).
bash "$(dirname "${BASH_SOURCE[0]}")/frozen_log_guard.sh" || exit 1

if [ -n "${OPEN_BRANCH_GUARD_SKIP:-}" ]; then
    echo "open_branch_guard: výnimka, dôvod: $OPEN_BRANCH_GUARD_SKIP" >&2 # info
    exit 0
fi

cd "$(git rev-parse --show-toplevel)" || exit 1

branch="$(git symbolic-ref --short -q HEAD || true)"
if [ -z "$branch" ]; then
    echo "open_branch_guard: HEAD nie je na vetve (rebase alebo detached), kontrola preskočená." >&2 # info
    exit 0
fi

if ! git remote get-url "$remote" >/dev/null 2>&1; then
    echo "open_branch_guard: repo nemá remote $remote, kontrola preskočená." >&2 # info
    exit 0
fi

fetch=(git fetch --quiet --prune "$remote")
if command -v timeout >/dev/null; then
    fetch=(timeout "$fetch_timeout" "${fetch[@]}")
fi
if ! "${fetch[@]}" 2>/dev/null; then
    echo "open_branch_guard: git fetch $remote zlyhal, kontrola beží nad posledným známym stavom $remote." >&2 # info
fi

if ! git rev-parse --verify -q "refs/remotes/$remote/$main" >/dev/null; then
    echo "open_branch_guard: $remote/$main neexistuje, kontrola preskočená." >&2 # info
    exit 0
fi

if [ "$branch" != "$main" ]; then
    if git merge-base --is-ancestor "refs/remotes/$remote/$main" HEAD; then
        exit 0
    fi
    deny_postup "Commit odmietnutý, vetva $branch nie je rebasnutá na $remote/$main." \
        "git fetch $remote && git rebase $remote/$main; výnimka len s dôvodom: OPEN_BRANCH_GUARD_SKIP=\"<dôvod>\" git commit ..."
    exit 1
fi

staged="$(git diff --cached --name-only)"
[ -z "$staged" ] && exit 0

status=0
while IFS= read -r ref; do
    [ -z "$ref" ] && continue
    name="${ref#"$remote/"}"
    [ "$name" = "HEAD" ] || [ "$name" = "$main" ] && continue
    base="$(git merge-base "refs/remotes/$remote/$main" "refs/remotes/$ref" 2>/dev/null)" || continue
    # Zlúčená vetva nemení nič, diff od merge-base je prázdny.
    changed="$(git diff --name-only "$base" "refs/remotes/$ref")"
    [ -z "$changed" ] && continue
    while IFS= read -r f; do
        if grep -qxF -- "$f" <<<"$changed"; then
            deny_postup "súbor $f mení otvorená vetva $name." \
                "zmenu súboru $f urob na vetve $name, alebo vetvu najprv zlúč (git merge origin/$name)."
            status=1
        fi
    done <<<"$staged"
done < <(git for-each-ref --format='%(refname:short)' "refs/remotes/$remote/")

if [ "$status" -ne 0 ]; then
    deny_postup "Commit na $main odmietnutý, súbor mení otvorená vetva." \
        "zmenu urob na otvorenej vetve alebo ju najprv zlúč; výnimka len s dôvodom: OPEN_BRANCH_GUARD_SKIP=\"<dôvod>\" git commit ..."
fi
exit "$status"
