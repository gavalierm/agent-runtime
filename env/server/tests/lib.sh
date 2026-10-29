#!/bin/bash
# Spoločné funkcie testov env/server. Každý test_*.sh ho načíta, dostane
# premennú REPO, dočasný priečinok T a falošné príkazy v $T/bin pred PATH.
# Testy nesmú siahnuť na skutočné schránky agentov, /root/.claude ani sieť.
# Premenné ako REPO používajú testy, ktoré lib.sh načítajú.
# shellcheck disable=SC2034
set -u

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin"
PATH="$T/bin:$PATH"
failures=0
# Hook pre-commit beží s premennými gitu skutočného repozitára. Testy s
# dočasnými repozitármi by inak zapisovali do jeho indexu.
unset GIT_DIR GIT_INDEX_FILE GIT_WORK_TREE GIT_PREFIX GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT
# Globálny git config roota (core.hooksPath) nesmie ovplyvniť commity v dočasných repách (úloha 570).
: > "$T/gitconfig"
export GIT_CONFIG_GLOBAL="$T/gitconfig" GIT_CONFIG_NOSYSTEM=1

# fake meno obsah: vytvorí falošný príkaz v $T/bin
fake() {
    printf '#!/bin/bash\n%s\n' "$2" > "$T/bin/$1"
    chmod +x "$T/bin/$1"
}

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

# lacks popis text: posledný výstup z check text neobsahuje
lacks() {
    if grep -qF -- "$2" <<<"$out"; then
        echo "FAIL $1: výstup obsahuje '$2'"
        failures=$((failures + 1))
    else
        echo "ok   $1"
    fi
}

finish() {
    [ "$failures" -eq 0 ]
}
