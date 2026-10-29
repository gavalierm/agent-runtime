#!/bin/bash
# Test lib/open_branch_guard.sh: zopakuje chybu z 19. 10. 2026 v dočasnom
# repe (vetva mení súbor, commit na main do toho istého súboru) a čaká, že
# hook commit odmietne. Spustenie: bash lib/open_branch_guard.test.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$HERE/open_branch_guard.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX OPEN_BRANCH_GUARD_SKIP
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
export HOME="$T/home"
mkdir -p "$HOME"
failures=0

# check popis očakávaný_kód príkaz...: spustí príkaz, výstup uloží do $out
check() {
    local name="$1" want="$2"
    shift 2
    out="$("$@" 2>&1)"
    local rc=$?
    if [ "$rc" = "$want" ]; then
        echo "ok   $name"
    else
        echo "FAIL $name: kód $rc, čakal som $want"
        printf '%s\n' "$out" | sed 's/^/     /'
        failures=$((failures + 1))
    fi
}

# contains popis text: posledný výstup z check obsahuje text
contains() {
    if grep -qF -- "$2" <<<"$out"; then
        echo "ok   $1"
    else
        echo "FAIL $1: výstup neobsahuje '$2'"
        printf '%s\n' "$out" | sed 's/^/     /'
        failures=$((failures + 1))
    fi
}

# Bare repo origin, klon A (vetva) a klon B (main), ako dve relácie.
git init -q --bare -b main "$T/origin.git"
git clone -q "$T/origin.git" "$T/a" 2>/dev/null
cd "$T/a" || exit 1
printf 'odsek 1\n\nodsek 2\n' > CLAUDE.md
echo x > ine.md
git add CLAUDE.md ine.md
git commit -q -m "Prvý"
git push -q origin main
git clone -q "$T/origin.git" "$T/b"

# Vetva v A mení CLAUDE.md a je na origin.
git checkout -q -b refaktor
printf 'odsek 1 z vetvy\n\nodsek 2\n' > CLAUDE.md
git commit -q -m "Vetva mení CLAUDE.md" -- CLAUDE.md
git push -q -u origin refaktor

# B commituje na main do toho istého súboru: odmietnuté.
cd "$T/b" || exit 1
git config core.hooksPath "$T/hooks"
mkdir -p "$T/hooks"
printf '#!/bin/bash\nexec bash %q\n' "$GUARD" > "$T/hooks/pre-commit"
chmod +x "$T/hooks/pre-commit"
printf 'odsek 1\n\nodsek 2 z main\n' > CLAUDE.md
git add CLAUDE.md
check "commit na main do súboru otvorenej vetvy odmietnutý" 1 git commit -q -m "Main mení CLAUDE.md" -- CLAUDE.md
contains "hláška menuje súbor a vetvu" "súbor CLAUDE.md mení otvorená vetva refaktor."
contains "hláška nesie správny postup" "Správny postup: zmenu súboru CLAUDE.md urob na vetve refaktor"
git checkout -q -- CLAUDE.md

# Iný súbor na main prejde.
echo y > ine.md
git add ine.md
check "commit na main do iného súboru prejde" 0 git commit -q -m "Main mení ine.md" -- ine.md
git push -q origin main

# Výnimka s dôvodom prejde, bez dôvodu nie.
printf 'odsek 1\n\nodsek 2 z main\n' > CLAUDE.md
git add CLAUDE.md
check "prázdna výnimka commit nepustí" 1 env OPEN_BRANCH_GUARD_SKIP= git commit -q -m "Main mení CLAUDE.md" -- CLAUDE.md
check "výnimka s dôvodom commit pustí" 0 env OPEN_BRANCH_GUARD_SKIP="skúška testu" git commit -q -m "Main mení CLAUDE.md" -- CLAUDE.md
contains "dôvod výnimky je vo výstupe" "dôvod: skúška testu"
git push -q origin main

# Vetva v A je teraz za origin/main: commit na nej odmietnutý, po rebase prejde.
cd "$T/a" || exit 1
git config core.hooksPath "$T/hooks"
echo z > nove.md
git add nove.md
check "commit na nerebasnutej vetve odmietnutý" 1 git commit -q -m "Vetva pridáva nove.md" -- nove.md
contains "hláška nesie príkaz na rebase" "git fetch origin && git rebase origin/main"
git stash -q
check "rebase vetvy" 0 git rebase -q origin/main
git stash pop -q
git add nove.md
check "commit na rebasnutej vetve prejde" 0 git commit -q -m "Vetva pridáva nove.md" -- nove.md
git push -q --force-with-lease origin refaktor

# Zlúčená vetva už main neblokuje.
cd "$T/b" || exit 1
git fetch -q origin
git merge -q --no-edit origin/refaktor
git push -q origin main
printf 'odsek 1 z vetvy\n\nodsek 2 po zlúčení\n' > CLAUDE.md
git add CLAUDE.md
check "po zlúčení vetvy commit na main prejde" 0 git commit -q -m "Main po zlúčení" -- CLAUDE.md

# Bez remote sa kontrola preskočí.
git init -q -b main "$T/solo"
cd "$T/solo" || exit 1
git config core.hooksPath "$T/hooks"
echo s > s.md
git add s.md
check "repo bez remote prejde" 0 git commit -q -m "Solo" -- s.md

# Zrušené meno v indexe commit odmietne, aj s výnimkou.
printf '%s\n' "$(printf 'zrusene-meno' | base64)" > "$T/retired.txt"
echo 'tu je zrusene-meno' > r.md
git add r.md
check "zrušené meno commit odmietne" 1 env RETIRED_NAMES_LIST="$T/retired.txt" git commit -q -m "Zrušené" -- r.md
contains "hláška menuje súbor" "r.md:1"
check "výnimka zrušené meno nepustí" 1 env RETIRED_NAMES_LIST="$T/retired.txt" OPEN_BRANCH_GUARD_SKIP="skúška" git commit -q -m "Zrušené" -- r.md
echo 'tu je nové meno' > r.md
git add r.md
check "po oprave commit prejde" 0 env RETIRED_NAMES_LIST="$T/retired.txt" git commit -q -m "Opravené" -- r.md

if [ "$failures" -eq 0 ]; then
    echo "open_branch_guard: všetko prešlo."
else
    echo "open_branch_guard: $failures zlyhaní." >&2
    exit 1
fi
