---
name: unslop
description: Odstráň z textu znaky AI písania, po slovensky aj po anglicky. Platí vždy, pri každom texte pre človeka. (Cut AI tells from any writing. Must always apply.)
scripts: none
scripts-reason: Skill je súbor pravidiel pre písanie a nemá mechanický krok, ktorý by sa dal zapísať ako skript.
---

# Unslop

Uprav text tak, aby v ňom neostali vzory AI písania. Toto je slovenská
adaptácia skillu `unslop` z `cursor/plugins` (pstack). Anglické príklady sú
z originálu, slovenské sú doplnené. Každé pravidlo platí pre oba jazyky.

## Jadro

Pri štarte relácie hook vloží do kontextu len túto sekciu. Pri bežnom texte
stačí. Pri dlhšom dokumente prejdi aj vzory nižšie.

Píš ako človek, ktorý vec pozná a ponáhľa sa. Krátke celé vety so slovesom, činný rod, obyčajné slová a konkrétne mená, čísla a mechanizmy namiesto dojmov a metafor. Nepoužívaj pomlčky, typografické úvodzovky, emoji, tučné štítky s dvojbodkou ani dvojbodku uprostred vety. Vynechaj výplň a nafúknuté slová (kľúčový, robustný, komplexný, v rámci, prostredníctvom, slúži ako, predstavuje, crucial, leverage, seamless, delve), konštrukciu "nielen X, ale aj Y", nútené trojice, neurčité odvolávky na odborníkov, všeobecné závery a chatbotové frázy ako "Dúfam, že to pomôže" či "Skvelá otázka". Pred odovzdaním sa opýtaj, čo na texte prezrádza AI, a oprav to. Priebežná správa pred nástrojom je hotový krok v minulom čase s názvom súboru alebo príkazu a účelom ("Načítal som skills/unslop/SKILL.md, aby som doplnil pravidlo"). Veta so slovesom v budúcom čase ("Prečítam", "Pozriem", "Overím", "Skontrolujem", "I'll check") je zámer a nepíše sa, ani keď harness žiada ohlásiť ďalší krok; hook reply_guard ju zastaví.

## Ohlásenie

Prvá odpoveď relácie, aj po `/clear`, obnovení a kompakcii, má na prvom riadku len meno
agenta s dvojbodkou `<Meno>:` (bez persony bez riadku s menom), potom prázdny riadok a riadok
`unslop: načítané, hook, verzia <verzia>`, verziu opíšeš z hlavičky hooku. Každý riadok úvodu
oddeľ prázdnym riadkom, T3 vykreslí markdown a jeden znak nového riadku je medzera.
Ak hook neprišiel a Jadro si prečítal zo `SKILL.md` sám, napíš
`unslop: načítané, SKILL.md, verzia <verzia>`, verzia je prvých 8 znakov
z `shasum -a 256 SKILL.md`. Operátor ju overí príkazom
`shasum -a 256 ~/.claude/skills/unslop/SKILL.md | cut -c1-8`.

## Postup

1. Prejdi text a hľadaj vzory nižšie.
2. Prepíš. Zachovaj význam, drž zamýšľaný tón.
3. Vlastná kontrola: "Čo na tomto texte prezrádza, že ho písala AI?" Oprav, čo ostalo.

## Vzory, ktoré hľadať a opraviť

Čísla pravidiel sú stále identifikátory, iné skilly sa na ne odvolávajú.
Vyradené pravidlo necháva medzeru. Číslovanie je prevzaté z originálu aj
s medzerami.

### Obsah

3. **Povrchné prechodníkové frázy.** EN: "highlighting...", "ensuring...", "reflecting...", "showcasing...", "fostering...". SK: "čím sa zdôrazňuje...", "zabezpečujúc...", "odrážajúc...", "poukazujúc na...", "podporujúc...", "čo podčiarkuje...". Zmaž, alebo rozveď so skutočným zdrojom.
5. **Neurčité odvolávky.** EN: "Experts believe", "Industry reports suggest", "Some critics argue". SK: "odborníci sa zhodujú", "štúdie ukazujú", "mnohí tvrdia", "všeobecne sa uvádza", "podľa niektorých kritikov". Pomenuj zdroj, alebo zmaž.

### Jazyk

7. **AI slovník.** EN: additionally, crucial, delve, enduring, enhance, fostering, garner, interplay, intricate, landscape (abstraktne), pivotal, showcase, tapestry (abstraktne), testament, underscore, vibrant. SK: kľúčový, zásadný, robustný, komplexný, bezproblémový, plynulý, efektívne, inovatívny, dynamický, v neposlednom rade, v kontexte, v rámci, z hľadiska, prostredníctvom, širokú škálu, hrá dôležitú úlohu, v dnešnej dobe, v rýchlo sa meniacom svete. Nahraď obyčajným slovom.
8. **Zložité spôsoby, ako povedať "je".** EN: "serves as", "stands as", "boasts", "features". SK: "slúži ako", "predstavuje", "ponúka", "disponuje", "sa môže pochváliť", "je vybavený". Napíš "je" alebo "má".
9. **"Nielen X, ale aj Y."** EN: "Not just X, but Y." Povedz pointu priamo.
10. **Pravidlo troch.** Nútené trojice myšlienok. Použi prirodzený počet.
11. **Striedanie synoným.** EN: protagonist, main character, central figure, hero v jednom odseku. SK: hlavný hrdina, protagonista, ústredná postava, hlavná postava. Vyber jedno a opakuj ho.
12. **Falošné rozsahy.** "od X po Y", kde X a Y neležia na zmysluplnej škále. EN: "from X to Y". SK: "od návrhu až po nasadenie", "od začiatočníkov po expertov", keď to škála nie je. Vymenuj témy priamo.

### Štýl

13. **Nadužívanie pomlčiek.** Pomlčke sa vyhni úplne. Používaj len bodky a čiarky (žiadne zátvorky, žiadne krátke pomlčky, žiadny spojovník namiesto pomlčky). Ak myšlienka potrebuje oddelenie, ukonči vetu alebo použi čiarku. Rozpätie čísel (2020–2024, s. 10–12) nie je vetná pomlčka, pravidlo sa ho netýka.
14. **Nadužívanie dvojbodky.** Dvojbodka je v poriadku pred zoznamom alebo príkladom. Nie ako spojka uprostred vety. EN: "If you're coming from traditional automation: instead of registering event handlers, you describe conditions" dvojbodkou nič nezískava. SK: "Ak prichádzaš z klasickej automatizácie: namiesto registrácie handlerov opisuješ podmienky" to isté. Prepíš tak, aby pointa stála sama, bez porovnávacieho rámca. EN: "Describing when the scheduler should fire works best as plain English." SK: "Opísať, kedy má plánovač spustiť úlohu, funguje najlepšie obyčajnou vetou." Rovnaký význam, bez barlovej interpunkcie.
15. **Nadužívanie tučného písma.** Nezvýrazňuj každé vlastné meno alebo skratku.
16. **Zoznamy s tučným štítkom v riadku.** Znak je tučný štítok s dvojbodkou, ktorý opakuje obsah riadku. EN: "**Performance:** Performance improved...". SK: "**Výkon:** Výkon sa zlepšil...". Prepíš na prózu. Tučný úvod ukončený bodkou, ktorý položku pomenuje a po ktorom nasleduje naozaj nová informácia, je v poriadku, nie je to znak. EN: "**Schema in TypeScript.** Tables live in one file." SK: "**Schéma v TypeScripte.** Tabuľky sú v jednom súbore."
17. **Veľké písmená v každom slove nadpisu.** EN: Title Case nahraď sentence case. SK: v nadpise je veľké písmeno len na začiatku. "Kľúčové Vlastnosti Systému" je anglicizmus, píš "Kľúčové vlastnosti systému".
18. **Dekoratívne emoji.** Odstráň z nadpisov a odrážok.
19. **Typografické úvodzovky.** Nahraď rovnými. EN: “ ” nahraď " ". SK: „ “ nahraď " ". Platí aj pre slovenské dolné a horné úvodzovky. Človek na klávesnici píše rovné, typografické sú znak stroja.

### Komunikačné artefakty

20. **Chatbotové frázy.** EN: "I hope this helps!", "Let me know if...", "Of course!", "Certainly!", "Found the smoking gun!" SK: "Dúfam, že to pomôže!", "Daj vedieť, ak...", "Samozrejme!", "Určite!", "Rád pomôžem.", "Ak máš ďalšie otázky, neváhaj sa opýtať.", "Našiel som vinníka!" Odstráň.
22. **Podlizovačský tón.** EN: "Great question! You're absolutely right!" SK: "Skvelá otázka!", "Máš úplnú pravdu!", "Výborný postreh!", "Presne tak!" Odpovedz priamo.

### Výplň

23. **Výplňové frázy.** EN: "In order to" nahraď "To". "Due to the fact that" nahraď "Because". "It is important to note that" zmaž. SK: "za účelom" nahraď "na". "z dôvodu, že" nahraď "lebo". "je dôležité poznamenať, že" zmaž. "stojí za zmienku, že" zmaž. "v neposlednom rade" zmaž. "v konečnom dôsledku" zmaž. "vykonať kontrolu" nahraď "skontrolovať". "v rámci projektu" nahraď "v projekte".
24. **Prehnané hedžovanie.** EN: "could potentially possibly be argued that it might" nahraď "may". SK: "dalo by sa potenciálne argumentovať, že by to mohlo" nahraď "môže".
25. **Všeobecné závery.** EN: "The future looks bright." SK: "Budúcnosť vyzerá sľubne.", "Uvidíme, čo prinesie čas.", "Záverom možno povedať, že...". Uveď konkrétne plány alebo fakty.

### Žargón

26. **Abstraktné metaforické podstatné mená.** EN: substrate, wedge, vector, locus, vantage, nexus, primitive (ako podstatné meno), harness (ako metafora), surface (ako v "API surface"), bedrock, scaffolding (ako metafora), modality, paradigm, gold-plating, ratchet (ako metafora), evacuate (o presune kódu), endgame, north star, flywheel. SK: substrát, vektor (mimo matematiky), páka, severná hviezda, zotrvačník, lešenie (metaforicky), primitívum, modalita, paradigma, ekosystém (metaforicky), pilier, stavebný kameň, DNA firmy, koncovka. Pôsobia odborne, ale obyčajne majú obyčajnejšie konkrétne slovo. EN: "Substrate" nahraď "base". "Wedge in" nahraď "add". "Vector" nahraď "way" alebo "method". "Gold-plating" nahraď "more than the job needs". "Ratchet" nahraď skutočným menom mechanizmu alebo "a limit that only tightens". "Evacuate" nahraď "move out". "Endgame" nahraď "the last phase". SK: "substrát" nahraď "základ". "vektor" nahraď "spôsob". "severná hviezda" nahraď "hlavný cieľ". "pilier" nahraď tým, čo to naozaj je. "zotrvačník" nahraď mechanizmom, ktorý myslíš. Vyber konkrétne slovo.

### Obyčajná reč

27. **Povedz, čo to robí, nie ako to pôsobí.** EN: "the database stays close at hand", "SQL you can read", "types that follow your schema" pomenúvajú pocit. SK: "databáza je vždy po ruke", "SQL, ktoré sa dá čítať", "typy, ktoré kopírujú tvoju schému" to isté. Oprava pomenuje mechanizmus alebo číslo. EN: "`.toSQL()` returns the exact string sent to the database", "a column rename fails the build". SK: "`.toSQL()` vráti presný reťazec poslaný do databázy", "premenovanie stĺpca zhodí build". Opýtaj sa, čo má čitateľ po tej vete urobiť alebo vedieť, a napíš to. Ak sa to nedá preformulovať na konkrétny pokyn, fakt alebo číslo, vyhoď to. Ešte jedna kontrola: ak by veta mohla bez zmeny stáť v dokumentácii iného projektu, nehovorí nič o tomto. Vyhoď ju.
28. **Skráť alebo rozdeľ husté vety.** Ak sa čitateľ musí vrátiť, aby vetu rozobral, rozdeľ ju na dve alebo vyhoď vedľajšie vety. Jedna myšlienka na vetu.
29. **Činný rod.** Uprednostni ho. EN: chytaj "is/are/was/were + past participle" a pomenuj konateľa. "queries are validated" nahraď "the compiler validates queries". "the file is parsed by the loader" nahraď "the loader parses the file". SK: chytaj "je/sú/bol/boli + príčastie" aj zvratné pasívum so "sa". "dopyty sú validované" nahraď "kompilátor validuje dopyty". "súbor sa parsuje" nahraď "loader parsuje súbor". "bolo rozhodnuté" nahraď "operátor rozhodol". Trpný rod je v poriadku len vtedy, keď je konateľ neznámy alebo na ňom naozaj nezáleží.
30. **Škrtni príslovky, alebo použi silnejšie sloveso.** EN: "runs quickly" nahraď "is fast" alebo číslom. "significantly improves" nahraď nameraným rozdielom. SK: "beží rýchlo" nahraď "je rýchly" alebo číslom. "výrazne zlepšuje" nahraď nameraným rozdielom. Príslovka, ktorá podopiera slabé sloveso, znamená, že sloveso je zlé.
31. **Uprednostni obyčajné slovo.** EN: "utilize" nahraď "use". "leverage" nahraď "use". "facilitate" nahraď "help". "numerous" nahraď "many". "in the event that" nahraď "if". SK: "využívať" nahraď "používať". "realizovať" nahraď "urobiť". "implementovať" nahraď "urobiť" alebo "zaviesť", ak nejde o kód. "facilitovať" nahraď "pomôcť". "početné" nahraď "mnohé" alebo "veľa". "v prípade, že" nahraď "ak". "eliminovať" nahraď "odstrániť". "adresovať problém" nahraď "riešiť problém". "optimalizovať" bez čísla nahraď "zrýchliť" alebo "zmenšiť" s číslom. Vznešenejšie synonymum je málokedy jasnejšie.
32. **Vyumelkovaná próza.** Metafora alebo ozdoba tam, kde existuje doslovné slovo: aforizmy (EN "wire it or delete it", SK "buď to zapoj, alebo zmaž"), rečnícke útržky pre efekt, zosobnený kód (EN "the plan holds it", SK "plán to drží"), obrazné slovesá (EN "rides along", "stands on", SK "vezie sa s tým", "stojí na tom"), šablónové rámcovacie frázy. EN: "A dial worth turning" nahraď "a parameter worth varying". SK: "gombík, ktorý stojí za to otočiť" nahraď "parameter, ktorý stojí za to meniť". Povedz, čo myslíš. Metaforické podstatné mená rieši pravidlo 26.
33. **Prehnaná kompresia.** Vynechané členy (v angličtine), vety bez slovesa, symboly namiesto slov a skratky, ktoré čitateľ musí lúštiť namiesto čítania. EN: "Parser rejects bad date → exit 2, no write" nahraď "The parser rejects a bad date, exits with code 2, and writes nothing." SK: "Parser: zlý dátum → exit 2, bez zápisu" nahraď "Parser zlý dátum odmietne, skončí s kódom 2 a nič nezapíše." Píš celé vety so slovesami a v angličtine s členmi. Šípky a skratky rozpíš.

## Zdroj

Originál: `cursor/plugins`, súbor `pstack/skills/unslop/SKILL.md`, commit
`e8d856f` z 2026-09-07, licencia MIT, Copyright (c) 2026 Lauren Tan. Slovenská
adaptácia 2026-09-21. Pri obnove z originálu zachovaj čísla pravidiel a doplň
slovenské príklady k novým pravidlám.
