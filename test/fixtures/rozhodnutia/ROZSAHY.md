# Značky rozsahu

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

## Moc a rozsah

Pole `moc` hovorí, akou mocou rozhodol ten, kto rozhodol. Kontrola odmietne:

| rozsah | smie moc |
|---|---|
| `pravidla` | `operator`, `spravca-agentov` |
| `server` | všetky okrem `pracovny-agent` |

Hodnoty `moc`: `operator`, `zastupca-v-plnej-moci`, `spravca-agentov`,
`spravca-servera`, `dizajner`, `pracovny-agent`. Rozsah mimo tabuľky vyššie
nemá obmedzenie. Záznam s `rozhodol: Operátor` musí mať v `zdroj` vlákno,
reláciu alebo úlohu.
