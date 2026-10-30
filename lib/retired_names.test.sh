#!/bin/bash
# Test lib/retired_names.sh: zrušené meno v persone a hooku dá kód 1, po
# zmazaní kód 0. Mená testu sa skladajú z base64 zoznamu. 
# Spustenie: bash lib/retired_names.test.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
fail=0
git -C "$T" init -q
a="$(printf cGFwZXJjbGlw | base64 -d)"
b="$(printf S2xpcA== | base64 -d)"
printf 'Úlohy čítam v %se.\n' "$a" > "$T/PERSONA.md"
printf 'const KEY = "cache/%s_key";\n' "$a" > "$T/hook.mjs"
printf 'Téma je úloha v %se.\n' "$b" > "$T/CLAUDE.md"
printf 'clipboard, eklipsa, PAGAV-1, mpc_api\n' > "$T/ok.md"
git -C "$T" add -A
out="$(bash "$HERE/retired_names.sh" "$T" 2>&1)"; rc=$?
[ "$rc" = 1 ] && echo "ok   nález v persone a hooku" || { echo "FAIL kód $rc, čakal som 1"; fail=1; }
for f in PERSONA.md hook.mjs CLAUDE.md; do
    printf '%s\n' "$out" | grep -q "/$f:1:" && echo "ok   $f nájdený" || { echo "FAIL $f nenájdený"; fail=1; }
done
printf '%s\n' "$out" | grep -q "ok.md" && { echo "FAIL ok.md hlásený"; fail=1; } || echo "ok   podobné slová nehlási"
git -C "$T" rm -q --cached PERSONA.md hook.mjs CLAUDE.md
bash "$HERE/retired_names.sh" "$T" 2>/dev/null && echo "ok   čisté repo prejde" || { echo "FAIL čisté repo neprešlo"; fail=1; }
exit "$fail"
