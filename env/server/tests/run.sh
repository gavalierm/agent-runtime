#!/bin/bash
# Spustí shellcheck na skripty env/server a všetky testy env/server/tests/test_*.sh.
# Kód 0 len vtedy, keď prejde všetko. Volá ho check.mjs na serveri, ručne:
#   env/server/tests/run.sh
set -u
cd "$(dirname "$0")/../../.." || exit 1
status=0
if command -v shellcheck >/dev/null; then
    shellcheck -x -P SCRIPTDIR env/server/*.sh env/server/tests/*.sh || status=1
else
    echo "shellcheck nie je nainštalovaný, preskočený" >&2
fi
for t in env/server/tests/test_*.sh; do
    echo "== $t"
    bash "$t" || status=1
done
[ "$status" -eq 0 ] && echo "Všetko prešlo." || echo "Niečo zlyhalo, pozri FAIL vyššie." >&2
exit "$status"
