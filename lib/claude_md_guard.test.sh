#!/bin/bash
# Test lib/claude_md_guard.sh v dočasnom repe (živé repo sa nedotkne):
# 201 riadkov zlyhá, 200 prejde, odsek s chybou a dátumom v PERSONA.md zlyhá,
# značka konfliktu zlyhá, výnimka s dôvodom prejde, čistý commit prejde.
# Spustenie: bash lib/claude_md_guard.test.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$HERE/claude_md_guard.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX CLAUDE_MD_GUARD_SKIP CLAUDE_MD_GUARD_MAX_LINES
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

# lines N: vypíše N riadkov pravidla.
lines() { seq 1 "$1" | sed 's/^/pravidlo /'; }

# Slovo "Chyba" ako premenná, aby test nebol odsek s chybou a dátumom.
CH="Chyba"

git init -q -b main "$T/r"
cd "$T/r" || exit 1
git config core.hooksPath "$T/hooks"
mkdir -p "$T/hooks" sub
printf '#!/bin/bash\nexec bash %q\n' "$GUARD" > "$T/hooks/pre-commit"
chmod +x "$T/hooks/pre-commit"
echo zaklad > zaklad.md
git add zaklad.md
git commit -q -m "Základ" -- zaklad.md

lines 201 > CLAUDE.md
git add CLAUDE.md
check "CLAUDE.md s 201 riadkami zlyhá" 1 git commit -q -m "201" -- CLAUDE.md
contains "hláška menuje súbor a počet" "CLAUDE.md má 201 riadkov, strop je 200."
contains "hláška nesie správny postup" "Správny postup: skráť CLAUDE.md pod 200 riadkov"

lines 200 > CLAUDE.md
git add CLAUDE.md
check "CLAUDE.md s 200 riadkami prejde" 0 git commit -q -m "200" -- CLAUDE.md

lines 201 > sub/CLAUDE.md
git add sub/CLAUDE.md
check "CLAUDE.md v podpriečinku s 201 riadkami zlyhá" 1 git commit -q -m "sub 201" -- sub/CLAUDE.md
git reset -q -- sub/CLAUDE.md
rm sub/CLAUDE.md

lines 201 > dlhy.md
git add dlhy.md
check "iný súbor nad 200 riadkov prejde" 0 git commit -q -m "dlhy" -- dlhy.md

printf 'Pravidlo.\n\n%s 27. 10. 2026: x\n' "$CH" > PERSONA.md
git add PERSONA.md
check "odsek s chybou a dátumom v PERSONA.md zlyhá" 1 git commit -q -m "chyba" -- PERSONA.md
contains "hláška menuje riadok" "PERSONA.md nesie chybu s dátumom (riadok 3)"
contains "hláška posiela na chyba.sh" "Správny postup: chybu zapíš skriptom bin/chyba.sh"

printf 'Pravidlo, ktoré vzniklo ako %s 23. 10. 2026, úloha 404.\n' "${CH,,}" > PERSONA.md
git add PERSONA.md
check "malá chyba s dátumom v zátvorke zlyhá" 1 git commit -q -m "chyba malá" -- PERSONA.md

printf '%s 27. 10. 2026: x\n' "$CH" > poznamka.md
git add poznamka.md
check "chyba s dátumom v inom súbore prejde" 0 git commit -q -m "poznamka" -- poznamka.md

printf 'Pravidlo bez príbehu.\n' > PERSONA.md
git add PERSONA.md
check "PERSONA.md bez chyby prejde" 0 git commit -q -m "persona" -- PERSONA.md

printf 'a\n<<<<<<< HEAD\nb\n=======\nc\n>>>>>>> vetva\n' > konflikt.md
git add konflikt.md
check "značka konfliktu zlyhá" 1 git commit -q -m "konflikt" -- konflikt.md
contains "hláška menuje súbor" "konflikt.md nesie značku konfliktu."
contains "hláška nesie správny postup" "Správny postup: vyrieš konflikt v konflikt.md"

check "prázdna výnimka commit nepustí" 1 env CLAUDE_MD_GUARD_SKIP= git commit -q -m "konflikt" -- konflikt.md
check "výnimka s dôvodom commit pustí" 0 env CLAUDE_MD_GUARD_SKIP="skúška testu" git commit -q -m "konflikt" -- konflikt.md
contains "dôvod výnimky je vo výstupe" "dôvod: skúška testu"

printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x01' > obrazok.png
git add obrazok.png
check "binárny súbor prejde" 0 git commit -q -m "png" -- obrazok.png
if printf '%s' "$out" | grep -q 'null byte'; then
    echo "FAIL: binárny súbor vypísal varovanie o null byte"
    printf '%s\n' "$out" | sed 's/^/     /'
    failures=$((failures + 1))
else
    echo "ok   binárny súbor bez varovania"
fi

printf 'riadok\nriadok\n' > cisty.md
git add cisty.md
check "čistý commit prejde" 0 git commit -q -m "čistý" -- cisty.md

if [ "$failures" -eq 0 ]; then
    echo "claude_md_guard: všetko prešlo."
else
    echo "claude_md_guard: $failures zlyhaní." >&2
    exit 1
fi
