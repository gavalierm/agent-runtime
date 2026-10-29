#!/bin/bash
# Test lib/commit_guard.sh: zopakuje chybu z 19. 10. 2026 (trailer
# Co-Authored-By, e-mail mimo účtu operátora) a čaká odmietnutie.
# Spustenie: bash lib/commit_guard.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GUARD="$HERE/commit_guard.sh"
GOOD="$(tr -d '[:space:]' < "$HERE/git_email.txt")"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
export HOME="$T"
git init -q "$T/r"
cd "$T/r" || exit 1
failures=0

# check popis očakávaný_kód e-mail správa
check() {
    printf '%b' "$4" > "$T/msg"
    GIT_AUTHOR_EMAIL="$3" GIT_AUTHOR_NAME="${NAME:-Adam (examplehost)}" bash "$GUARD" "$T/msg" >/dev/null 2>&1
    local rc=$?
    if [ "$rc" = "$2" ]; then echo "ok   $1"; else echo "FAIL $1: kód $rc, čakal som $2"; failures=$((failures + 1)); fi
}

check "čistý commit prejde" 0 "$GOOD" 'Oprava\n\nDosah lokálny.\n'
check "Co-Authored-By odmietne" 1 "$GOOD" 'Oprava\n\nCo-Authored-By: Claude Opus 5.5 <noreply@example.com>\n'
check "malé písmená odmietne" 1 "$GOOD" 'Oprava\n\nco-authored-by: x <x@y>\n'
check "Claude-Session odmietne" 1 "$GOOD" 'Oprava\n\nClaude-Session: https://claude.ai/x\n'
check "e-mail boris@examplehost odmietne" 1 "boris@examplehost" 'Oprava\n'
check "e-mail mimo účtu odmietne" 1 "oskar@example.org" 'Oprava\n'
check "zmienka v texte prejde" 0 "$GOOD" 'Zákaz traileru Co-Authored-By v texte\n'
NAME="Boris (examplehost)" check "meno Boris prejde" 0 "$GOOD" 'Oprava\n'
NAME="Cyril (mac)" check "meno Cyril (mac) prejde" 0 "$GOOD" 'Oprava\n'
NAME="example-org" check "meno operátora odmietne" 1 "$GOOD" 'Oprava\n'
NAME="Oskar (mac)" check "operátor nie je agent" 1 "$GOOD" 'Oprava\n'
NAME="root" check "meno root odmietne" 1 "$GOOD" 'Oprava\n'
NAME="Adam" check "meno bez stroja odmietne" 1 "$GOOD" 'Oprava\n'
NAME="Adam (Mac, cez Cyril)" check "meno s čiarkou odmietne" 1 "$GOOD" 'Oprava\n'

# zoznam autorov podľa repa (lib/repo_authors.txt, D0172): tasker len Dan
git -C "$T/r" remote add origin git@github.com:example-org/tasker.git
NAME="Adam (examplehost)" check "repo tasker, autor Adam odmietne" 1 "$GOOD" 'Oprava\n'
NAME="Dan (examplehost)" check "repo tasker, autor Dan prejde" 0 "$GOOD" 'Oprava\n'
git -C "$T/r" remote set-url origin git@github.com:example-org/iny.git
NAME="Adam (examplehost)" check "iné repo, autor Adam prejde" 0 "$GOOD" 'Oprava\n'
git -C "$T/r" remote remove origin
NAME="Adam (examplehost)" check "repo bez origin, autor Adam prejde" 0 "$GOOD" 'Oprava\n'

# každé odmietnutie nesie riadok "Správny postup:" (D0141)
for case in "$GOOD|Oprava\n\nCo-Authored-By: x <x@y>\n|Adam (examplehost)" "boris@examplehost|Oprava\n|Adam (examplehost)" "$GOOD|Oprava\n|root"; do
    IFS='|' read -r mail msg name <<<"$case"
    printf '%b' "$msg" > "$T/msg"
    out="$(GIT_AUTHOR_EMAIL="$mail" GIT_AUTHOR_NAME="$name" bash "$GUARD" "$T/msg" 2>&1)"
    if grep -q '^Správny postup: .\+' <<<"$out"; then echo "ok   odmietnutie nesie postup ($name, $mail)"; else echo "FAIL odmietnutie bez postupu ($name, $mail)"; failures=$((failures + 1)); fi
done

[ "$failures" = 0 ] && echo "commit_guard: všetko prešlo" || { echo "commit_guard: $failures zlyhaní"; exit 1; }
