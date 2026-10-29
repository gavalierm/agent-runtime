#!/bin/bash
# Odovzdávka pri čistom kontexte vlákna T3, logika je v lib/kontext.mjs.
#   kontext.sh spanok|pokracuj [--dalej "<ďalší krok>"] [--stav "<súhrn stavu>"]
# Vypíše riadok HOTOVO-KONTEXT <režim> <kľúč> pre koniec odpovede agenta.
exec node "$(dirname "$(readlink -f "$0")")/../lib/kontext.mjs" "$@"
