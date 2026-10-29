---
name: artefakty
description: Nájdi a použi schválený artefakt (playbook s referenciou) pred návrhom alebo implementáciou veci, ktorú artefakt pokrýva, napríklad dashboard, prehľad, administrácia, interná webová stránka so stavmi pre operátora. Použi aj pri zakladaní nového artefaktu. Spusti sa vždy, keď navrhuješ alebo stavaš stránku, web či iný výstup, ku ktorému môže existovať vzor v artifacts/.
scripts: none
scripts-reason: Skill vedie hľadanie schváleného artefaktu a úsudok, či ho použiť, mechanický krok v ňom nie je.
---

# Artefakty

Artefakt je schválený vzor pre opakovanú prácu. Operátor schválil konkrétny
výsledok a jeho pravidlá sú zapísané, aby ich každý agent použil rovnako a on
ich nemusel pri každej úlohe opravovať.

## Použitie

1. Pred návrhom alebo implementáciou pozri zoznam `artifacts/` (na serveri `/opt/agent-rules/artifacts`, na Macu nasadená kópia repa). `ls` stačí, názov priečinka hovorí, čo artefakt pokrýva.
2. Ak jeden sedí, prečítaj celý `PLAYBOOK.md` a otvor súbory v `reference/`. Playbook nesie pravidlá a dôvody, referencia nesie hodnoty a hotovú štruktúru.
3. Hodnoty (farby, rozmery, písmo, štruktúru) preber z referencie, nepíš ich z pamäte. Pri rozpore medzi textom a referenciou platí referencia.
4. Od artefaktu sa odchýľ len so zdôvodnením, napríklad "tabuľka mala 12 stĺpcov, na 390px ich skrývam od štvrtého". Odchýlku napíš do odpovede operátorovi jednou vetou. Pravidlo samotné neprepisuj.
5. Postup overenia z playbooku (snímky, grep) urob pred odovzdaním a uveď výsledok.
6. Ak žiadny artefakt nesedí, pokračuj bežne. Ak práca vyzerá ako opakovaná a operátor ju schválil, navrhni nový artefakt.

## Založenie nového artefaktu

Artefakt zakladá agent, ktorý vec urobil, a schvaľuje ho operátor. Bez schválenia sa nezakladá, lebo nesprávny vzor by sa rozšíril na všetkých agentov.

1. Priečinok `artifacts/<meno>/`, meno krátke a podľa veci, nie podľa agenta alebo projektu.
2. `PLAYBOOK.md`: čo artefakt pokrýva, pravidlá ako krátke vety s konkrétnymi hodnotami a dôvodom, čo nerobiť, ako výsledok overiť. Meno agenta sa nepíše, pravidlá sú pre rolu.
3. `reference/`: schválený výsledok ako šablóna (súbor, ktorý sa dá skopírovať), nie opis. Je to zdroj pravdy pre hodnoty.
4. Operátor schváli výsledok aj text. Do repa pravidiel ide až potom, commit podľa pravidiel repa (dosah globálny, README.md má riadok pre `artifacts/`).
5. Zmena artefaktu ide cez operátora tak isto. Pri zmene referencie uprav aj PLAYBOOK.md a naopak.

Text artefaktu píš podľa skillu `unslop`.
