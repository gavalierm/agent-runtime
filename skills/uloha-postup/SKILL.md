---
name: uloha-postup
description: Pravidlá práce s úlohou v Taskeri a s príkazmi počas práce. Použi pri každom zakladaní úlohy (`tk task add`), blokovaní (`tasker block`), čakaní (`tasker wait`), podúlohe (`--parent`), zmene riešiteľa, zatváraní úlohy (`tasker done`), pred zadaním úlohy sub-agentovi, pri komentári s telom zo súboru, pri príkaze v kontajneri (`docker exec`) alebo v `tmux`, keď zadanie úlohy nie je jasné, keď úloha nevojde do jedného behu a keď sa chystáš zapísať `tasker result done` na úlohe pilotného projektu.
scripts: none
scripts-reason: Skill nesie len pravidlá postupu s úlohou a príkazmi, samotné zápisy robí príkaz správcu úloh, ktorý skill nevlastní.
---

# Postup úlohy

Časti pred "Kroky" platia pri každej úlohe. Časť "Kroky" je pilot od 20. 10. 2026
na pilotnom projekte (D0026): úloha na jeden beh ide rovno, kroky platia
pre úlohu s viac krokmi.

## Založenie úlohy

- Pred založením pozri otvorené úlohy, či ju už niekto nezaložil. To platí aj
  pre kartu pre operátora.
- Úloha má dôvod, podmienku hotového a projekt (`--project`: napríklad `tasker`,
  `agenti`), bez neho ju Tasker odmietne.
- Úlohu, ktorú agent robí sám alebo cez sub-agenta, zakladaj s `--assign
  <meno>`. Bez riešiteľa po dokončení blokérov nikoho nezobudí.
- Názov pomenúva problém, ktorý vidí operátor, nie riešenie ("/opt/tasker beží
  bez 276db3a", nie "Nasadiť Tasker 276db3a"). Stráži to `task_title.mjs`.
- Úlohu agentovi webu (meno alebo workdir končí na `-web`) zakladá len
  `bin/uloha-webu.sh` klonu kódu. Úloha webu so zmenou vzhľadu chce
  `--mockup <id>` schválenej úlohy dizajnéra (done, komentár `Mockup schválený:`
  od iného autora ako dizajnér), inak `--bez-mockupu "<dôvod>"` (zmena bez nového
  vzhľadu alebo priamy pokyn operátora).
- Zadanie s novým mechanizmom (systemd, timer, slučka, nový skript, nový hook,
  nová kontrola, načítanie na štarte relácie) nesie riadok `Nástroj overený:
  <príkaz a výstup>` alebo vetu `Existujúci mechanizmus X to nerobí, lebo Y`.
  Hook posudzuje `task add`, `comment`, `ask_agent.sh` a text rozhodnutia pre
  `rozhodni.sh` (`own_mechanism.mjs`). Slová návrhu (nový hook, nová kontrola,
  načítanie na štarte relácie, vlastný mechanizmus) platia pre zadanie a
  rozhodnutie, nie pre komentár. Slová infraštruktúry (systemd, timer, cron,
  slučka, nový skript) platia aj v komentári.
- Agentovi, ktorý v tom istom projekte už má bežiaci beh, zakladaj úlohu
  s `--blocked-by` a `--reason`, inak ju dispečer spustí súbežne v tom istom
  klone. Vedomé súbežné zadanie je `TK_PARALLEL=1` pred príkazom
  (`task_concurrency.mjs`).
- Predpoklad v zadaní over na živom systéme, nie z pamäte.

## Stav úlohy

- Odpoveď operátora, ktorá príde do vlákna namiesto komentára, zapíš najprv do
  úlohy komentárom s jeho menom a až potom konaj.
- `blocked` len s komentárom, ktorý nesie príčinu a spúšťač odblokovania.
  Čakanie na inú úlohu je `tasker block <id> --by <id> --reason "<dôvod>"`:
  na čom blokér stojí, kto ho odstráni a čo úlohu potom pohne.
- Čakanie na udalosť mimo Taskera je `tasker wait <id> --reason "na čo"
  --until <čas>`. Po udalosti `tasker done` alebo `tasker resume`.
- Implementácia otvorenej úlohy je jej podúloha (`tasker task add --parent
  <id>`). Rodič ostane otvorený, kým nie je každý potomok `done` alebo
  `cancelled`, a zadávateľ ho zavrie po overení (D0174).
- Opravu práce na zavretej úlohe zadaj novou úlohou. Komentár na zavretej
  nikoho nezobudí.
- Riešiteľa mení len agent, do ktorého roly práca nepatrí. Odmietne ju
  komentárom s dôvodom a pridelí agentovi roly z `roles/agents.md`.

## Dozor nad úlohou

- Úlohu zavri `tasker done` v tom ťahu, v ktorom splnila podmienku hotového
  a jej implementácia je overená. Rodiča zavri po poslednom potomkovi
  (D0174).
- Pri zavretí úlohy prejdi svoje úlohy `needs_human` v tom istom projekte.
  Otázku, ktorú výsledok prekonal, zruš s dôvodom a číslom zavretej úlohy,
  pri ostatných napíš do komentára, prečo platia ďalej (`done_related.mjs`).
- Pred zadaním úlohy sub-agentovi pozri udalosti `work` v `tasker task show N
  --json`. Ak ich nesie iné vlákno a čas `until` neuplynul, robí ju ono a ty ju
  nezadávaj.
- Prácu, ktorá plynie z výsledku na čakajúcej úlohe, urob hneď.
- Po zápise komentára alebo úlohy s telom zo súboru prečítaj zápis z Taskera
  a porovnaj jeho prvý riadok so svojím textom.

## Príkazy počas práce

- Príkaz v kontajneri spúšťaj pod používateľom aplikácie (`docker exec -u
  <používateľ>`, zistíš ho `docker top`). `docker exec` bez `-u` pri
  zapisujúcom príkaze je zakázaný.
- Interaktívny príkaz s jednorazovým výstupom spúšťaj v `tmux` s
  `remain-on-exit on`. Kód pošli `send-keys -l`, Enter samostatne a výstup
  čítaj `capture-pane -p -J -S -`.
- `tmux send-keys` do vstupu agenta je záložná cesta, pozri skill `schranka`.

## Kroky

1. Nejasné zadanie: agent zapíše do komentára najviac päť otázok, ktorých
   odpoveď nenájde v kóde ani v úlohe, a beh ukončí `tasker result
   needs_human`. Pri viac otázkach navrhne rozdelenie úlohy.
2. Plán: agent zapíše do komentára plán so štyrmi časťami: čo robíme (dve
   až štyri vety), kroky (najviac sedem), čo nerobíme (nikdy prázdne)
   a ako overíme, že to funguje (jedna až tri skúšky). Beh ukončí
   `needs_human`. Plán nejde do súboru v repe. Schválenie je komentár,
   ktorý úlohu zobudí. Plán schvaľuje zástupca operátora, vyhradenú vec
   operátor.
3. Stavba: krok, ktorý sa nezmestí do jedného behu, je podúloha
   zreťazená blokermi (`tasker block --by --reason`). Prácu mimo plánu agent
   nerobí, zmenu plánu navrhne komentárom a beh ukončí `needs_human`.
4. Kontrola: pred `tasker result done` agent zapíše komentár s tromi
   odpoveďami s dôkazom. Funguje to (príkaz a jeho výstup)? Sedí to
   s plánom (čo chýba, čo pribudlo, čoho iného sa zmena dotkne)? Je to
   jednoduché (čo by sa dalo zmazať)? Keď odpoveď neobstojí, výsledok je
   `needs_human` s dôvodom.
