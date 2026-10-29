---
name: dokonci
description: Použi, keď beh na úlohe Taskera ide bez dozoru (noc, operátor neodpovedá) a má skončiť hotovou zmenou v main s dôkazom. Skript vedie ledger, hlási do úlohy a zavrie beh, ty dodáš najmenšiu zmenu, dôkazy a posudok druhým modelom.
---

# Dokonči bez dozoru

Nikto sa nepozerá, takže hotovo je len to, čo má dôkaz v ledgeri. Vzor je
`full-send` zo sady tstack, bez pull requestu a bez `gh` (D0182). Mechanické
kroky robí `/opt/agent-rules/skills/dokonci/dokonci.sh` (ďalej `dokonci.sh`),
každé jeho zlyhanie nesie riadok `Správny postup:`.

## Pravidlá

- Najmenšia zmena, ktorá splní podmienku hotového úlohy. Nič navyše.
- Dôkaz pre každú zmenu: reprodukcia pred zmenou, test alebo príkaz po nej,
  pri webe snímka z `/root/agent-runtime/browser.sh --gaps` (šírky 1440 a 390).
- Otázka na človeka ide len cez `dokonci.sh otazka <úloha> --summary "<otázka
  s ?, možnosti A) B) a odporúčanie>"` (zapíše ledger a zavolá
  `tasker result needs_human`).
  Čo vieš rozhodnúť sám, rozhodni a zapíš `dokonci.sh rozhodnutie`.

## Postup

1. `dokonci.sh start <úloha>` v repe, kde pracuješ. Vypíše politiku (dev pre
   projekty, main pre pravidlá, runtime a persony) a východiskový commit.
2. Reprodukcia pred zmenou:
   `dokonci.sh dokaz <úloha> --popis "<čo dokazuje>" -- <príkaz>` (kód ≠ 0 je
   v poriadku, zapíše sa).
3. Najmenšia zmena a commit: `git commit -m '...' -- <súbory>`.
4. Dôkaz po commite, rovnakým príkazom (kód 0), alebo
   `dokaz <úloha> --popis "..." --subor <snímka>`. Dôkaz pred posledným
   commitom `koniec` neprijme.
5. Posudok: nástroj Agent (`subagent_type` general-purpose, `model` opus pre
   návrh, sonnet pre kód). Prompt: diff (`git diff <východiskový>..HEAD`),
   podmienka hotového, cesta ledgera a otázka "čo by zlyhalo". Výsledok zapíš
   `dokonci.sh posudok <úloha> --kolo <1..3> --verdikt ok|zmeny --text "..."`.
   Agent spusti v popredí (`run_in_background: false`) a výsledok spracuj
   v tom istom ťahu. Beh Taskera končí s ťahom: ťah ukončený pred `koniec`
   zavrie beh bez výsledku a `tasker comment` aj `result` potom zlyhajú na
   run identity (úloha 623, behy 126 a 127). Hook `dokonci_open.mjs` koniec
   ťahu s otvoreným ledgerom zastaví.
6. Pri `zmeny` oprav, commit, nový dôkaz, ďalšie kolo. Po treťom kole skript
   kolo odmietne: `dokonci.sh otazka <úloha> --summary "..."`.
7. `dokonci.sh koniec <úloha> --vysledok "<veta>" [--otvorene "<text>"]`.
   Skript skontroluje čistý strom, commit, dôkaz po ňom a posudok `ok`, zlúči
   `dev` do `main` (`--no-ff`), pushne `main` aj `dev`, zapíše komentár
   `Výsledok:`, `Dôkaz:`, `Otvorené:` s rozhodnutiami a posudkami a zavolá
   `tasker result done`.
   Koniec nerobí `git checkout` dev ani main, merge ide v dočasnom worktree.
8. `--stop` na kroku 7 pushne len `dev`, merge do `main` ostane v `Otvorené`
   (zmena, ktorú má pred main vidieť človek).

## Beh vo worktree

Keď `git checkout dev` zlyhá, lebo dev drží iný worktree (beh Taskera
v `run-N-<projekt>`), `start` ostane na aktuálnej vetve, ak z dev vychádza,
inak založí `dokonci-<úloha>` z dev, a ledger zapíše `vetva` a `zaklad=dev`.
`koniec` najprv zlúči vetvu behu do dev a potom dev do main, každý merge
v dočasnom worktree z origin, a pushne ich.

## Premenné

`DOKONCI_TASKER` (príkaz Taskera, pod rootom predvolene `bin/tk`; môže byť
príkaz s argumentmi, napríklad `node /opt/tasker/bin/tasker`),
`DOKONCI_LEDGER_DIR` (predvolene `.scratch` repa, ak ho git ignoruje, inak
`/tmp/dokonci`). Test: `node --test /opt/agent-rules/skills/dokonci/dokonci.test.mjs`.
