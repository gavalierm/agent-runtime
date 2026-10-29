#!/bin/bash
# Test lib/frozen_log_guard.sh: v dočasnom repe zmrazí DECISIONS.md
# hlavičkou archívu a čaká, že commit so zmenou pod hlavičkou padne, kým
# pridanie hlavičky a zmena nezmrazeného logu prejdú. Nakoniec overí zapojenie
# cez open_branch_guard.sh. Spustenie: bash lib/frozen_log_guard.test.sh
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$HERE/frozen_log_guard.sh"
OBG="$HERE/open_branch_guard.sh"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX OPEN_BRANCH_GUARD_SKIP
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
export HOME="$T/home"
mkdir -p "$HOME"
failures=0

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

contains() {
    if grep -qF -- "$2" <<<"$out"; then
        echo "ok   $1"
    else
        echo "FAIL $1: výstup neobsahuje '$2'"
        printf '%s\n' "$out" | sed 's/^/     /'
        failures=$((failures + 1))
    fi
}

HEADER='Archív do 2026-10-23, nie je zdroj. Platné rozhodnutia sú v `rozhodnutia/` repa agentic-workflow.'

# Repo s hookom, ktorý volá zábranu, a nezmrazeným logom.
git init -q -b main "$T/r"
cd "$T/r" || exit 1
mkdir -p "$T/hooks"
printf '#!/bin/bash\nexec bash %q\n' "$GUARD" > "$T/hooks/pre-commit"
chmod +x "$T/hooks/pre-commit"
git config core.hooksPath "$T/hooks"
printf '# Rozhodnutia\n\n## 2026-10-20, a\n\ntext\n' > DECISIONS.md
printf '# Schválené\n\nriadok\n' > SCHVALENE.md
echo x > ine.md
git add DECISIONS.md SCHVALENE.md ine.md
check "pred zmrazením commit logu prejde" 0 git commit -q -m "Prvý" -- DECISIONS.md SCHVALENE.md ine.md

printf '# Rozhodnutia\n\n## 2026-10-20, a\n\ntext\n\n## 2026-10-21, b\n\nďalší\n' > DECISIONS.md
git add DECISIONS.md
check "nezmrazený log sa smie meniť" 0 git commit -q -m "Pridanie záznamu" -- DECISIONS.md

# Hlavička spolu s inou zmenou: odmietnuté, samotná hlavička prejde.
{ printf '%s\n<!-- doc_paths: off -->\n\n' "$HEADER"; sed 's/ďalší/zmenený/' DECISIONS.md; } > DECISIONS.md.new
mv DECISIONS.md.new DECISIONS.md
git add DECISIONS.md
check "hlavička spolu s inou zmenou je odmietnutá" 1 git commit -q -m "Hlavička a zmena" -- DECISIONS.md
contains "hláška žiada samostatný commit" "Správny postup: hlavičku archívu pridaj samostatným commitom"
git checkout -q -- DECISIONS.md
git reset -q DECISIONS.md
git checkout -q -- DECISIONS.md
{ printf '%s\n<!-- doc_paths: off -->\n\n' "$HEADER"; cat DECISIONS.md; } > DECISIONS.md.new
mv DECISIONS.md.new DECISIONS.md
git add DECISIONS.md
check "samotné pridanie hlavičky prejde" 0 git commit -q -m "Hlavička archívu" -- DECISIONS.md

# Zmena pod hlavičkou padne.
printf '\n## 2026-10-24, c\n\nnový záznam\n' >> DECISIONS.md
git add DECISIONS.md
check "pridanie záznamu pod hlavičku je odmietnuté" 1 git commit -q -m "Záznam do archívu" -- DECISIONS.md
contains "hláška menuje súbor" "DECISIONS.md je zmrazený archív"
contains "hláška posiela na rozhodni.sh" "bin/rozhodni.sh"
git reset -q DECISIONS.md
git checkout -q -- DECISIONS.md

sed -i 's/ďalší/prepísaný/' DECISIONS.md
git add DECISIONS.md
check "prepísanie textu pod hlavičkou je odmietnuté" 1 git commit -q -m "Prepis" -- DECISIONS.md
git reset -q DECISIONS.md
git checkout -q -- DECISIONS.md

sed -i '1d' DECISIONS.md
git add DECISIONS.md
check "zmazanie hlavičky je odmietnuté" 1 git commit -q -m "Bez hlavičky" -- DECISIONS.md
git reset -q DECISIONS.md
git checkout -q -- DECISIONS.md

git rm -q --cached DECISIONS.md
check "zmazanie zmrazeného logu je odmietnuté" 1 git commit -q -m "Zmazanie" -- DECISIONS.md
git reset -q DECISIONS.md
git checkout -q -- DECISIONS.md

git mv DECISIONS.md PRESUN.md
check "premenovanie zmrazeného logu je odmietnuté" 1 bash "$GUARD"
git reset -q
git checkout -q -- DECISIONS.md 2>/dev/null
rm -f PRESUN.md

# Iné súbory a nezmrazený SCHVALENE.md prejdú, aj keď je zmrazený DECISIONS.md.
echo y > ine.md
git add ine.md
check "iný súbor prejde" 0 git commit -q -m "Iný súbor" -- ine.md
printf 'ďalší riadok\n' >> SCHVALENE.md
git add SCHVALENE.md
check "nezmrazený SCHVALENE.md prejde" 0 git commit -q -m "Schválené" -- SCHVALENE.md

# SCHVALENE.md zmrazený značkou hooku rozhodnutia_guard.
{ printf '<!-- rozhodnutia: zmrazene -->\n'; cat SCHVALENE.md; } > SCHVALENE.md.new
mv SCHVALENE.md.new SCHVALENE.md
git add SCHVALENE.md
check "značka zmrazenia pridaná samostatne prejde" 0 git commit -q -m "Značka" -- SCHVALENE.md
printf 'ďalší\n' >> SCHVALENE.md
git add SCHVALENE.md
check "zmena SCHVALENE.md so značkou je odmietnutá" 1 git commit -q -m "Zmena" -- SCHVALENE.md
git reset -q SCHVALENE.md
git checkout -q -- SCHVALENE.md

# Súbor v podpriečinku (DECISIONS.md projektu) sa kontroluje rovnako.
mkdir -p pod
printf '%s\n\nstary\n' "$HEADER" > pod/DECISIONS.md
git add pod/DECISIONS.md
check "nový zmrazený log vznikne" 0 git commit -q -m "Nový archív" -- pod/DECISIONS.md
echo nove >> pod/DECISIONS.md
git add pod/DECISIONS.md
check "zmena zmrazeného logu v podpriečinku je odmietnutá" 1 git commit -q -m "Zmena pod" -- pod/DECISIONS.md
git reset -q pod/DECISIONS.md
git checkout -q -- pod/DECISIONS.md

# Zapojenie: open_branch_guard.sh zábranu volá, výnimka ju nevypne.
git init -q -b main "$T/w"
cd "$T/w" || exit 1
printf '%s\n\nstary\n' "$HEADER" > DECISIONS.md
git add DECISIONS.md
git commit -q -m "Archív" -- DECISIONS.md
echo nove >> DECISIONS.md
git add DECISIONS.md
check "open_branch_guard odmietne zmenu zmrazeného logu" 1 bash "$OBG"
contains "hláška je zo zábrany" "zmrazený archív"
check "výnimka OPEN_BRANCH_GUARD_SKIP zábranu nevypne" 1 env OPEN_BRANCH_GUARD_SKIP="skúška" bash "$OBG"
git reset -q DECISIONS.md
git checkout -q -- DECISIONS.md
echo y > ine.md
git add ine.md
check "open_branch_guard pustí iný súbor" 0 bash "$OBG"

if [ "$failures" -eq 0 ]; then
    echo "frozen_log_guard: všetko prešlo."
else
    echo "frozen_log_guard: $failures zlyhaní." >&2
    exit 1
fi
