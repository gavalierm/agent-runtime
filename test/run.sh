#!/usr/bin/env bash
# Jeden spúšťač testov repa: node testy v test/, hooks/, lib/, env/, koreňový
# check.test.mjs, git-hooks/global.test.mjs, shellové testy lib/*.test.sh,
# env/mac/install.test.sh, test/brain/run.sh a env/server/tests/run.sh
# (install.sh a sync.sh servera, cesty cez AR_* do tmp). Skončí kódom 1 pri prvom zlyhaní a vypíše, ktorý test
# padol. Žiadny test sa nedotkne živého systému. Každý test dostane vlastný
# TMPDIR a po ňom zlyhá, ak v ňom ostala nejaká položka (únik dočasných súborov).
#   ./test/run.sh            všetko
#   ./test/run.sh <súbor>... len dané súbory (.test.mjs, .test.sh alebo run.sh)
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$ROOT" || exit 1

# Spoločný TMPDIR behu, node os.tmpdir() aj mktemp -d ho rešpektujú.
TMPDIR=$(mktemp -d "${TMPDIR:-/tmp}/agentic-tests.XXXXXX") || exit 1
export TMPDIR
trap 'rm -rf "$TMPDIR"' EXIT

run_test() {
  local t="$1"
  echo "== $t"
  case "$t" in
    *.test.mjs) node --test "$t" ;;
    *.test.sh | */run.sh) bash "$t" ;;
    *) echo "neznámy typ testu: $t" >&2; return 1 ;;
  esac
}

# Po teste v TMPDIR nesmie nič ostať, inak je to únik a test zlyhá.
run_one() {
  local t="$1" n
  run_test "$t" || return 1
  n=$(find "$TMPDIR" -mindepth 1 -maxdepth 1 | wc -l | tr -d ' ')
  if [ "$n" -ne 0 ]; then
    echo "ÚNIK TMP: $t nechal $n položiek v $TMPDIR" >&2
    find "$TMPDIR" -mindepth 1 -maxdepth 1 | head -20 >&2
    return 1
  fi
}

if [ "$#" -gt 0 ]; then
  tests=("$@")
else
  shopt -s nullglob
  tests=(test/*.test.mjs hooks/*.test.mjs lib/*.test.mjs env/*.test.mjs check.test.mjs git-hooks/global.test.mjs lib/*.test.sh env/mac/*.test.sh test/brain/run.sh env/server/tests/run.sh)
fi

for t in "${tests[@]}"; do
  if ! run_one "$t"; then
    echo "FAILED: $t" >&2
    exit 1
  fi
done

echo
echo "All tests passed (${#tests[@]} files)."
