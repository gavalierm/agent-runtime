---
name: browser
description: Otvorí stránku v Chrome so sandboxom a vráti snímky PNG, text stránky a chyby konzoly. Použi, keď treba pozrieť stránku alebo návrh (web správcu úloh na http://127.0.0.1:8801, HTML v docs/), urobiť snímku pri šírke mobilu a desktopu, kliknúť alebo vyplniť pole a skontrolovať výsledok, alebo zistiť chyby konzoly. Nástroje náhľadu T3 (html_preview, preview_*) nepoužívaj, vo vlákne pod rootom nefungujú.
scripts: none
scripts-reason: Skill volá skript browser.sh z koreňa repa, vlastný skript v skille nemá.
---

# Prehliadač

Skript `browser.sh` v koreni repa spustí Chrome so sandboxom pod
používateľom prehliadača (`AGENT_BROWSER_USER` alebo `AGENT_TASKER_USER`)
a vráti snímky, text a chyby konzoly. Voľby sú v `README.md` repa, časť
"Prehliadač". Príklady nižšie sa spúšťajú z koreňa repa.

Nástroje náhľadu T3 (`html_preview`, `html_render`, `preview_*`) neskúšaj.
T3 beží pod rootom a sandbox Chromu ostáva zapnutý, takže tam prehliadač
nenaštartuje. Skript ide cez používateľa prehliadača a funguje.

## Príkaz

Živá stránka, mobil aj desktop, text a chyby konzoly:

```
./browser.sh --url http://127.0.0.1:8801/ --width 1440,390 --text
```

HTML súbor z `docs/` (skript skopíruje aj jeho priečinok, aby fungovali
relatívne odkazy, a priečinok nesmie mať nad 50 MB):

```
./browser.sh --file docs/<súbor>.html --width 1440,390 --full-page
```

Voľby:

- `--url` alebo `--file`, vždy práve jedno.
- `--width 1440,390` je zoznam šírok. Každá šírka dostane novú stránku.
  Bez voľby je len 1440, výška je 900 (`--height`).
- `--full-page` odfotí celú dĺžku stránky, nie len okno.
- `--text` uloží text stránky.
- `--gaps [px]` nájde texty nalepené pod sebou (medzera pod `px`, predvolene 6)
  alebo prekryté. Nálezy zapíše do `gaps-<šírka>.txt`, vypíše ich a skončí
  kódom 1.
- `--steps` sú kroky pred snímkou, súbor JSON alebo pole priamo v príkaze.
- `--out` je priečinok výstupu, predvolený je `$AGENT_WORKDIR/.scratch/browser/<čas>`.

## Kroky

Kroky sa vykonajú na každej šírke. Podporované sú `click`, `fill`, `press`,
`wait` (číslo v ms alebo selektor) a `shot` (pomenovaná snímka). Klik
a kontrola výsledku:

```
./browser.sh --url http://127.0.0.1:8801/ --text \
  --steps '[{"click":"a[href=\"/agents\"]"},{"wait":500},{"shot":"agenti"}]'
```

Po krokoch skript vždy urobí ešte snímku `page-<šírka>.png`. Krok, ktorý
zlyhá (zlý selektor), preruší ďalšie kroky na tej šírke, zapíše sa do
`console.txt` a skript skončí kódom 1. Selektory ber z HTML stránky
(`curl -s <url>`), nehádaj ich.

## Výstup

Skript vypíše názvy súborov v `--out`: `page-<šírka>.png`,
`<meno>-<šírka>.png` z kroku `shot`, `text-<šírka>.txt` a `console.txt`.
Snímku otvor nástrojom Read na ceste `<out>/page-390.png`. Pozri vždy aj
`console.txt`. Prázdny súbor znamená, že konzola nehlásila chybu ani
varovanie ani zlyhanú požiadavku.

Kód 0 je v poriadku, 1 chyba alebo zlyhaný krok, 2 zlé použitie.

## Iný používateľ, trvalý profil, vlastný skript

- `--user <meno>` spustí Chrome pod iným používateľom ako je predvolený
  (osobný asistent beží pod vlastným používateľom, D0163). Prostredie roota
  sa nepreberie.
- `--profile <názov>` drží profil prehliadača (cookies, prihlásenie) v
  `~<používateľ>/.local/share/agent-browser/profiles/<názov>` s právami 700.
  Naraz ho smie používať jeden beh.
- `--exec <skript.mjs> [--env NAME] [--timeout s] [-- argumenty]` spustí vlastný skript
  pod tým používateľom s Chrome so sandboxom. Skript otvorí prehliadač cez
  `const { openProfile } = await import(process.env.BROWSER_SESSION)`. Stdin, stdout a
  kód idú priamo cez. Príklad sú nástroje osobného asistenta v jeho repe
  (`tools/notes.mjs`).

## Pravidlá

- Zmenu webu alebo návrhu ukáž operátorovi, až keď `--gaps` na šírkach
  1440 a 390 skončí kódom 0 na každej stránke, ktorej sa zmena dotkne.
- Skript spúšťaj pod rootom, inak odmietne.
- Z `http://127.0.0.1:8801/` len čítaš. Klik na odosielacie tlačidlo
  v živom správcovi úloh (nová úloha) zapíše údaje, tam ho nespúšťaj.
- Snímky z `.scratch` nie sú v gite. Súbor pre operátora ulož do `docs/`.
