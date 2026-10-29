#!/usr/bin/env bash
# Jeden spúšťač testov repa: node testy v test/, hooks/, lib/, koreňový check.test.mjs,
# git-hooks/global.test.mjs, shellové testy lib/*.test.sh a test/brain/run.sh.
# Testy env/server/tests pridá dávka s adaptérmi prostredia. Skončí kódom 1 pri
# prvom zlyhaní a vypíše, ktorý test padol. Žiadny test sa nedotkne živého systému.
#   ./test/run.sh            všetko
#   ./test/run.sh <súbor>... len dané súbory (.test.mjs, .test.sh alebo test/brain/run.sh)
set -u
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)
cd "$ROOT" || exit 1

run_one() {
  local t="$1"
  echo "== $t"
  case "$t" in
    *.test.mjs) node --test "$t" ;;
    *.test.sh | */run.sh) bash "$t" ;;
    *) echo "neznámy typ testu: $t" >&2; return 1 ;;
  esac
}

if [ "$#" -gt 0 ]; then
  tests=("$@")
else
  shopt -s nullglob
  tests=(test/*.test.mjs hooks/*.test.mjs lib/*.test.mjs check.test.mjs git-hooks/global.test.mjs lib/*.test.sh test/brain/run.sh)
fi

for t in "${tests[@]}"; do
  if ! run_one "$t"; then
    echo "FAILED: $t" >&2
    exit 1
  fi
done

echo
echo "All tests passed (${#tests[@]} files)."
