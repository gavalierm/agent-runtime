---
name: schranka
description: Použi pri každej správe zo schránky agenta (prvý riadok `odpoveď: čakám`, `nečakám` alebo `na vedomie`), pred `ask_agent.sh` alebo `reply.sh` a pred záložným `tmux send-keys` do vstupu agenta.
scripts: none
scripts-reason: Skill opisuje, ako čítať a vybaviť správu, skripty schránky (reply.sh, ask_agent.sh) sú v koreni repa a v bin/, nie v skille.
---

# Schránka agenta

Schránku, budič a skripty opisuje `README.md` klonu kódu, časť
Budenie. Tu sú pravidlá pre správy. Schránku `/var/lib/<meno>/inbox` cez `ls`
ani `cat` nečítaj, správu doručí budič.

## Hodnoty prvého riadku

Prvý riadok správy `odpoveď: ...` píšu skripty a hovorí, čo odosielateľ čaká.

| hodnota | znamená | odpoveď |
|---|---|---|
| `čakám` | pokyn alebo otázka, odosielateľ na odpovedi stojí | povinná, `reply.sh`, zobudí ho |
| `nečakám` | len správa Taskera (most úlohy) a ranný súhrn, výsledok prečíta pri ďalšom ťahu | `reply.sh`, nebudí ho |
| `na vedomie` | výsledok alebo hlásenie, ktoré mení prácu adresáta | nepíše sa, ani "prevzaté" |

Na správy `tasker-*` a ranný súhrn sa do schránky neodpovedá.

## Odoslanie

- `ask_agent.sh` píše novú správu ako `čakám`, s `--vedomie` ako `na vedomie`.
  Iný režim nemá.
- Novú správu `na vedomie` (bez `--k`) pošli len adresátovi, ktorému zmení
  prácu. `--dopad "<čo sa mu mení>"` to povie.
- Neposielaj kontrolu budiča, hromadné "na vedomie" ani správu "odpoveď
  netreba".

## Odpoveď

- Odpoveď ide príkazom z hlavičky správy (`reply.sh <id>`).
- `reply.sh` je predvolene `na vedomie`. Čo potrebuješ späť, má `--cakam` alebo
  `--necakam`.
- Telo nesie riadky `Výsledok:`, `Dôkaz:` a `Otvorené:` (`Otvorené: nič`).
  Bez ktoréhokoľvek ich `reply.sh` odmietne.
- Správa `na vedomie` agenta nebudí (D0176). Práca, ktorá z nej vyplynie, je
  nový pokyn `ask_agent.sh`.

## Záložná cesta

`tmux send-keys` do vstupu agenta je záložná cesta. Čaká, len keď klient na
zápis písal posledných 30 s. Postup v `tmux` je v skille `uloha-postup`, časť
"Príkazy počas práce".
