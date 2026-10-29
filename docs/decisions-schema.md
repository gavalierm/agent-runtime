# Schéma záznamov rozhodnutí

Dva texty za sebou: formát záznamu a príkazy, potom značky rozsahu a moc.

## Rozhodnutia

Jeden súbor na rozhodnutie, `D0001.md` a ďalej. Píše ich len
[bin/rozhodni.sh](https://github.com/gavalierm/agent-runtime/blob/main/bin/rozhodni.sh), číta [lib/rozhodnutia.mjs](https://github.com/gavalierm/agent-runtime/blob/main/lib/rozhodnutia.mjs) (`list`, `show`, `check`,
`index`). `INDEX.md` generuje skript, ručne ho neupravuj. Značky rozsahu sú
v `ROZSAHY.md`. Návrh a dôvody sú v úlohe Taskera 390.

### Záznam

Hlavička je zoznam `kľúč: hodnota` medzi dvoma riadkami `---`, potom telo.

| pole | význam |
|---|---|
| `id` | `D` a štyri číslice, rovná sa menu súboru |
| `nazov` | jedna veta, čo platí |
| `stav` | `platí`, `nahradené`, `zrušené` |
| `kluc` | bodková cesta jednej veci, medzi platnými záznamami jedinečná |
| `rozsah` | značky z `ROZSAHY.md` |
| `agenti` | mená agentov z `roles/agents.md` malými písmenami, alebo `*` |
| `rozhodol`, `moc` | kto rozhodol a akou mocou |
| `zapisal`, `datum` | kto záznam zapísal a kedy |
| `zdroj` | kde to zaznelo: vlákno, správa, úloha. Číslo riadku v `DECISIONS.md` a `SCHVALENE.md` archívov (v súkromnom repe prevádzky) platí pre stav pred hlavičkou archívu, ktorá pridala 4 riadky: `git show <commit hlavičky>~1:DECISIONS.md` |
| `uloha` | číslo úlohy Taskera, keď otázka išla cez `needs_human` |
| `nahradza`, `nahradene` | odkazy medzi záznamami, obe strany ukazujú na seba |
| `alias` | staré číslo R alebo nadpis, `R153.sandbox` pre rozdelené R |
| `subory` | súbory repa, ktoré rozhodnutie stelesňujú, tie musia existovať |
| `zrusene-tvrdenie` | regulárny výraz vety, ktorá po zmene nesmie nikde stáť |

Telo má najviac päť viet: čo platí, dôvod, čo bolo zamietnuté. História je
v gite. Súbor sa nemaže, zmena stavu je commit.

### Príkazy

- `node lib/rozhodnutia.mjs list --agent beta --rozsah server` vypíše platné
  záznamy pre agenta. Záznamy stelesnené v pravidle (`subory` v `global/`,
  `roles/`, persone) ukáže až `--vsetky`.
- `node lib/rozhodnutia.mjs show D0007` alebo `show R153` (alias).
- `bin/rozhodni.sh --dry-run ...` vypíše záznam a nezapíše nič.

## Značky rozsahu

Pole `rozsah` záznamu nesie značky z tejto tabuľky, oddelené čiarkou.
`lib/rozhodnutia.mjs check` odmietne značku, ktorá tu nie je. Novú značku
pridaj sem v tom istom commite ako prvý záznam, ktorý ju používa. Správca
agentov pri rannom súhrne prechádza nové značky a kľúče, aby dva názvy
nepomenovali tú istú vec.

| značka | čoho sa rozhodnutie týka |
|---|---|
| `pravidla` | globálne pravidlá, prostredia, role, persony, kánon, hooky, skilly |
| `server` | stroj, služby, verzie, nastavenie servera |
| `tasker` | správca úloh, jeho tok, stavy, príkazy |
| `t3` | T3 Code, vlákna, budič |
| `prehliadac` | prehliadač a náhľady |
| `git` | repá, vetvy, commity, kľúče |
| `schranky` | schránky agentov, správy medzi agentmi |
| `dizajn` | vzhľad a postup dizajnu |
| `mac` | Mac a Claude na Macu |
| `schvalene` | trieda úkonov, ktorú operátor schválil vopred |
| `projekt:<meno>` | jeden projekt, napríklad `projekt:<projekt>` |

### Moc a rozsah

Pole `moc` hovorí, akou mocou rozhodol ten, kto rozhodol. Kontrola odmietne:

| rozsah | smie moc |
|---|---|
| `pravidla` | `operator`, `spravca-agentov` |
| `server` | všetky okrem `pracovny-agent` |

Hodnoty `moc`: `operator`, `zastupca-v-plnej-moci`, `spravca-agentov`,
`spravca-servera`, `dizajner`, `pracovny-agent`. Rozsah mimo tabuľky vyššie
nemá obmedzenie. Záznam s `rozhodol: Operátor` musí mať v `zdroj` vlákno,
reláciu alebo úlohu.
