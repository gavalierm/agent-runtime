# Playbook: agenti s identitou, pravidlami a kontrolou

## 0. Úvod

Tento návod je pre operátora, ktorý chce mať viac agentov (relácie jazykového modelu s vlastným repom) a nechce im
stále opakovať to isté. Je aj pre agenta, ktorý dostal pokyn "prečítaj si toto repo, naštuduj a premysli, ako
postaviť podobný mechanizmus u nás". Nie je to plugin a nič sa z neho neinštaluje. Opisuje, čo sme postavili, prečo a
v akom poradí to postaviť u seba.

Problém je jednoduchý. Agent bez pamäte opakuje chyby, pýta sa na veci, ktoré operátor už rozhodol, a tvrdí veci,
ktoré neoveril. Prosba "nabudúce pozor" nepomôže, lebo nabudúce je nová relácia. Pomáha len pravidlo zapísané v súbore,
ktorý sa pri štarte načíta, a kontrola, ktorá zlyhá, keď agent pravidlo poruší.

Systém preto stojí na troch veciach. Pravidlá a rozhodnutia sú súbory v gite. Chybu uznanú operátorom sprevádza zmena
súboru, ktorý správanie riadi. Čo sa dá skontrolovať strojom, kontroluje hook alebo skript, nie dobrá vôľa modelu.

Každá kapitola 1 až 11 má rovnakú stavbu. Problém hovorí, čo sa bez mechanizmu pokazí, aj pre čitateľa, ktorý náš
systém nepozná. Kedy to potrebuješ hovorí, kedy mechanizmus nestavať. Mechanizmus opisuje, ako to funguje. Ako to
postaviť dáva kroky, formát súboru a príklad, bez nášho kódu. Čo od runtime vyžaduje vymenúva, čo musí vedieť nástroj,
v ktorom agent beží. Náš príklad ukazuje cesty v tomto repe, kde si hotovú verziu prečítaš. Kapitola 12 je poradie práce
na prvý týždeň.

Skripty, bez ktorých by harness nebežal (budič, čistý kontext, správy medzi agentmi, obal správcu úloh), žijú v repe
`https://github.com/gavalierm/agent-runtime`. Repo je verejné (D0171). Každý mechanizmus je aj tak opísaný tak, aby si ho postavil bez
odkazu. Odkaz je cesta, kde si hotový kód prečítaš. Tam žijú aj skripty zápisu rozhodnutia a uznanej chyby, helper
zamietnutia a kontroly tohto repa v jeho priečinkoch `bin/`, `lib/` a `test/`. Toto repo nenesie žiadny kód, len odkazy naň.

Cesty sú voči koreňu repa, ak nie je uvedené inak. Toto repo je očistená kópia súkromného repa pravidiel, ktoré u nás
žije v prevádzke. Cesty v častiach "Náš príklad" ukazujú do tohto repa, kde súbor existuje, inak do súkromného repa
prevádzky (jeho nasadenie na server je naša vec, nie súčasť návodu). Mapu repa nesie `README.md`, prečítaj ju prvú. Súbory, ktoré text spomína a v repe nie sú, opisuje jej tabuľka "Čo v repe nie je".
Neskopíruj naše pravidlá ako text, sú odpoveďou na naše chyby a tvoje budú iné. Skopíruj mechanizmy, teda spôsob, ako sa pravidlo zapíše,
načíta, skontroluje a opraví.

### Slovník

| pojem | význam |
|---|---|
| operátor | človek, ktorý vlastní pracovisko, agentov a účty a rozhoduje o tom, čo si vyhradil |
| zástupca operátora | agent s mandátom rozhodovať za operátora v schválených medziach |
| správca agentov | rola, ktorá spravuje persony, pravidlá, hooky a tok práce agentov |
| správca servera | agent s rootom, robí len prácu, ktorá root alebo citlivý úkon potrebuje |
| správca úloh | nástroj s úlohami, stavmi a komentármi, u nás Tasker |
| persona, rola | súbor `PERSONA.md` v repe agenta a mandát opísaný v `roles/<slug>.md`, nezávislý od mena agenta |
| runtime | nástroj, v ktorom agent beží a ktorý mu dodá model, súbory a príkazy, u nás Claude Code |
| relácia | jedno spustenie agenta nad repom od štartu po čistý kontext alebo koniec procesu |
| kontext | všetok text, ktorý model pri jednom volaní dostane, teda pravidlá, rozhovor a výsledky nástrojov |
| kompakcia | skrátenie kontextu, pri ktorom runtime nahradí starý rozhovor súhrnom |
| hook | skript, ktorý runtime spustí pri udalosti (štart relácie, prompt, použitie nástroja, koniec odpovede) a ktorý môže pridať text do kontextu alebo krok zamietnuť |
| pamäť | súbory agenta v repe (`memory/`), v ktorých je to, čo má prežiť reláciu a presahuje jeden projekt |
| skill | súbor s postupom pre agenta a prípadne so skriptom, ktorý agent použije, keď úloha zodpovedá jeho popisu |
| sub-agent | druhá relácia, ktorú hlavná relácia spustí na jednu dielčiu prácu a ktorá vráti len výsledok |
| vlákno | trvalá relácia agenta v jeho nástroji (u nás vlákno v T3 Code), prežije jednotlivé odpovede a dá sa do nej poslať text |
| vlákno témy | ďalšie vlákno toho istého agenta, ktoré vedie jednu tému, hlavné vlákno je to, v ktorom agent beží predvolene |
| ťah | jedno volanie modelu od vstupu po koniec odpovede, model pri ňom znova číta celý kontext |
| beh | úsek, v ktorom agent pracuje na jednom vstupe, môže mať viac ťahov a volaní nástrojov |
| schránka | adresár agenta s podadresármi `inbox` a `processed`, správa je súbor |
| budič | program, ktorý správu zo schránky doručí do bežiacej relácie agenta a súbor presunie do `processed` |
| dávka | všetky budiace správy pre jedno vlákno, ktoré budič pošle naraz, takže spotrebujú jeden ťah |
| tiché okno | doba bez novej budiacej správy (u nás 30 s), po ktorej dávka odíde, aby správy tesne za sebou išli spolu |
| režim správy | prvý riadok správy `odpoveď: čakám`, `nečakám` alebo `na vedomie`, hovorí, čo odosielateľ od odpovede čaká |
| trasa odpovede | záznam, z ktorého vlákna odosielateľ písal, podľa neho budič doručí odpoveď do toho vlákna |
| úloha | záznam v správcovi úloh s projektom, dôvodom, podmienkou hotového, riešiteľom, stavom a komentármi |
| riešiteľ | agent alebo človek, ktorý úlohu robí a ktorého správca úloh zobudí pri zmene |
| podmienka hotového | zápis v úlohe, podľa ktorého sa dá rozhodnúť, či je hotová, najlepšie príkaz a jeho očakávaný výstup |
| blokér | väzba "táto úloha stojí na tamtej" s povinným dôvodom, po uzavretí tamtej sa táto odblokuje |
| čistý kontext | nová relácia bez rozhovoru, ktorú agent začne z toho, čo je zapísané v súboroch a v správcovi úloh |
| odovzdávka | malý súbor so súhrnom stavu a ďalším krokom, ktorý agent zapíše pred čistením a ktorý sa vloží do novej relácie |

### Predpoklady

Skripty v repe sú bash a Node.js 22 alebo novší. Verziu vyžaduje príkaz testov, `node --test` s vzormi súborov, a skripty
používajú len moduly `node:`, nič sa neinštaluje.
Hooky sú hooky Claude Code (SessionStart, UserPromptSubmit, PreToolUse, Stop). Fungujú, len keď ich zapojíš do nastavenia
Claude Code, repo to za teba nerobí.
Klon pravidiel máme nasadený v pevných cestách na našich strojoch. V texte ich nahrádza `<klon pravidiel>`, ty si zvoľ
vlastnú cestu.
Windows sme neoverili. Skripty pobežia len cez WSL alebo Git Bash, bez bashu a Node nepobežia vôbec.
Mechanizmy v texte stoja aj bez našich skriptov. Podľa časti "Ako to postaviť" v každej kapitole si ich napíšeš vo
svojom jazyku a svojom nástroji.

## 1. Agent je persona a pamäť v gite, nie relácia

### Problém

Relácia modelu zanikne pri čistom kontexte, kompakcii, reštarte aj pri výmene stroja. Čo agent vie len z rozhovoru,
po nej nevie. Operátor potom vysvetľuje znova, kto agent je, čo smie a čo sa už dohodlo. Agent, ktorého správanie
závisí od toho, ako sa relácia vyvinie, je nepredvídateľný.

Druhý problém vznikne pri viac agentoch. Keď pravidlá a poznatky žijú v oknách rozhovorov, nikto nevie, čo ktorý agent
vie, a nedá sa to skontrolovať ani vrátiť späť.

### Kedy to potrebuješ

Potrebuješ to, keď agent pracuje dlhšie než jednu reláciu, alebo keď ich máš viac. Potrebuješ to aj vtedy, keď chceš
vedieť, čo a prečo sa v jeho správaní zmenilo, lebo história je v gite.

Nepotrebuješ to pri jednorazovej práci, ktorú dokončí jedna relácia. Pri jednom agentovi na jednom projekte stačí
súbor s pokynmi v koreni projektu (u Claude Code `CLAUDE.md`) a zvyšok kapitoly si prečítaj ako ukážku, kam to smeruje.

### Mechanizmus

Agent je repo v gite. Obsahuje personu (`PERSONA.md`), súbor pre runtime, ktorý personu importuje, pamäť a vlastné
skilly. Relácia je len jedno spustenie nad týmto repom. Pri štarte sa načíta persona a pamäť. Čo má prežiť reláciu,
agent zapíše do súborov, commitne a pushne.

Persona hovorí, kto agent je, ako pracuje s operátorom, čo spravuje a kde sú jeho hranice. Nemá mená nástrojov
konkrétneho runtime, aby sa dala preniesť. Pravidlá, ktoré potrebuje aj iný agent, v nej nie sú (kapitola 2).

Pamäť drží fakty, ktoré presahujú jeden projekt, napríklad kde je čo uložené a kto čo preferuje. Rozhodnutia a postupy
patria do dokumentov projektu a do registra rozhodnutí (kapitola 4). Poučenie z chyby sa z pamäte prenesie do persony
a položka v pamäti sa zmaže, lebo pamäť sa pri štarte len prečíta, kým persona agenta riadi.

Štart relácie je vždy rovnaký. Agent urobí `git fetch origin && git rebase origin/main` v repe agenta a v repe
pravidiel, potom prečíta pamäť a schránku (kapitola 8). Príkaz `git pull` sa nepoužíva. Viac relácií v jednom klone
spúšťa fetch naraz, každý zapíše do súboru `.git/FETCH_HEAD` svoj riadok a pull potom padne na dvoch riadkoch.

Commit podpisuje agent menom `<Agent> (<stroj>)`, aby bolo v histórii vidno, kto a kde ho urobil. Commituje vždy so
zoznamom súborov za `--`, lebo index klonu zdieľa viac relácií. Zakázané sú holý `git commit`, `-a`, `git add -A`
aj `git add .`, lebo by vzali rozpracované súbory inej relácie. Práca je hotová, keď je `git status --short` po pushi
prázdny.

### Ako to postaviť

1. Založ súkromné repo pre agenta s vlastným kľúčom na zápis. Jeden kľúč na agenta ukáže, kto pushol. Tajomstvá patria
   do súborov s právami `600` mimo repa.
2. Napíš `PERSONA.md`. Prvý riadok je nadpis s menom, pod ním riadok s rolami, potom sekcie. Päť sekcií stačí. Kto som,
   ako pracujem s operátorom, čo spravujem, hranice, kontinuita.
3. Napíš súbor pre runtime, ktorý personu importuje. Pre Claude Code je to `CLAUDE.md` v koreni repa a riadok
   `@PERSONA.md` vloží obsah súboru do kontextu.
4. Založ `memory/` s indexom `memory/MEMORY.md`. Index má jeden riadok na súbor pamäte, odkaz a jednu vetu, o čom
   súbor je.
5. Do persony napíš pravidlo štartu (fetch, rebase, pamäť, schránka) a konca (nedokončené do pamäte, commit, push).
6. Zapni git hook pre-commit, ktorý spustí kontroly repa (kapitoly 4 a 6). Git hook je skript v `.githooks/`, zapneš
   ho príkazom `git config core.hooksPath .githooks`. Bez kontrol sa pravidlá rozídu.
7. Over to jednou skúškou. Nechaj agenta zapísať fakt do pamäte, commitni, vyčisti kontext (alebo spusti novú reláciu)
   a spýtaj sa ho na ten fakt.

Súbor pre runtime:

```
@PERSONA.md

# <Meno> na <stroj>

Tento súbor pridáva k PERSONA.md len to, čo patrí behu na tomto stroji.
```

Riadok indexu pamäte:

```
- [Kde je tajomstvo k API](tajomstvo_api.md), cesta k súboru a kto ho smie čítať
```

### Čo od runtime vyžaduje

- Načíta pri štarte súbor s pokynmi z pracovného priečinka. Claude Code číta `CLAUDE.md`, iný nástroj má iný názov.
- Vie vložiť jeden súbor do druhého. Ak to nevie, súbor pre runtime obsahuje celú personu a ty ho z `PERSONA.md`
  generuješ skriptom, aby texty nezačali žiť dvakrát.
- Pustí agenta do shellu s gitom a kľúčom na zápis.

### Náš príklad

Pravidlá štartu a konca sú v `env/server/CLAUDE.md`, časť "Git na serveri", pravidlo nedokončenej práce v
`global/CLAUDE.md`, §6. Že persona nemá mená nástrojov runtime, hovorí `roles/spravca-agentov.md`, časť "Persona
agentov". Pre-commit hook je `.githooks/pre-commit`. Ukážku persony má repo správcu agentov v súbore `PERSONA.md`.

## 2. Vrstvy pravidiel

### Problém

Pravidlá napísané na jednom mieste sa rozrastú. Pravidlo, ktoré potrebuje každý agent, sa skopíruje do piatich person
a piate znenie sa potom líši od prvého. Pravidlo o role zapísané s menom agenta prestane platiť, keď sa agent premenuje
alebo rolu prevezme iný. Agent navyše nevie, ktoré z dvoch pravidiel je silnejšie.

Pri zmene pravidla je tretí problém. Relácia, ktorá už beží, nové znenie nevidí. Agent dodržiava staré pravidlo,
kým ho niekto nerestartuje.

### Kedy to potrebuješ

Potrebuješ to, keď má pravidlo platiť pre viac než jedného agenta alebo viac než jeden projekt. Potrebuješ to aj pri
jednom agentovi, ak pracuje na viacerých strojoch a každý z nich má trochu iné prostredie.

Nepotrebuješ to pri jednom agentovi na jednom stroji. Stačí mu jeden súbor s pokynmi a persona. Vrstvy pridaj, keď
prvýkrát napíšeš to isté pravidlo druhému agentovi. Roly pridaj, až keď máš prácu, ktorú nemá robiť prvý agent.

### Mechanizmus

Pravidlá majú päť vrstiev od najširšej po najužšiu. Užšia vrstva má prednosť pred širšou.

| vrstva | súbor | komu platí |
|---|---|---|
| globálne | `global/CLAUDE.md` | každý agent všade |
| prostredie | `env/<prostredie>/CLAUDE.md` | každý agent na tomto stroji |
| rola | `roles/<slug>.md` | agent, ktorého persona rolu uvádza |
| persona | `PERSONA.md` v repe agenta | jeden agent |
| projekt | `CLAUDE.md` projektu | práca v projekte, má prednosť |

Načítanie je tvrdé, nie dobrovoľné. Claude Code načíta súbor `CLAUDE.md` z domovského priečinka používateľa
(`~/.claude/CLAUDE.md`) a z každého rodiča pracovného priečinka. Globálny súbor preto dáš ako symbolický odkaz do
`~/.claude/CLAUDE.md` a súbor prostredia ako symbolický odkaz do koreňa stromu, pod ktorým agenti bežia. Persona sa
načíta importom `@PERSONA.md` zo súboru pre runtime. Roly vloží hook pri štarte relácie.

Hook identity beží pri štarte relácie. Prečíta z `PERSONA.md` riadok `Role: <slug>, <slug>` a do kontextu vloží súbory
`roles/<slug>.md`. Agent, ktorého persona rolu neuvádza, jej pravidlá nedostane. Neznámy slug dá upozornenie v kontexte
a hook nespadne. Ten istý hook ohlási aj identitu, teda meno z nadpisu persony a skrátené id relácie.

Zmena pravidiel sa k agentovi dostane aj uprostred relácie. Hook pri každom prompte porovná, na ktorom commite je
nasadený klon pravidiel, s commitom, ktorý videla táto relácia naposledy. Pri rozdiele vloží do kontextu zoznam
commitov a diff súborov z `global/` a `env/<prostredie>/`. Stav poslednej videnej verzie drží po jednom súbore na
reláciu, aby sa relácie neovplyvňovali. Prvý prompt relácie len zapíše commit, lebo súbory sa pri štarte načítali
čerstvé. Zmena tak platí najneskôr päť minút po pushi a bez reštartu, ak sa nasadený klon sám aktualizuje každých päť
minút.

Pravidlo o role a meno agenta majú každé jedno miesto. Pravidlo píšeš pre rolu alebo skupinu agentov. Kto rolu drží,
hovorí jediný súbor s mapovaním rolí na mená. Premenovanie agenta je zmena jedného riadku a mena repa, pravidlá sa
nemenia. Meno patrí len do príkladu alebo do opisu stavu s dátumom. Rola je mandát a zodpovednosť, nie systémové
práva.

Pravidlo patrí na úroveň svojho dosahu. Ak ho potrebuje aj iný agent alebo ak iný agent drží kópiu, patrí do
globálnych pravidiel, prostredia alebo roly. Dve kontroly to držia. Prvá hľadá duplikáty, teda odrážky v personách,
ktoré hovoria to isté ako odrážky v zdieľaných súboroch. Druhá je hook, ktorý pri prvom zápise nového textu do
pravidiel agenta zamietne zápis s otázkou, či tú vec nerobí aj iný agent. Rovnaký druhý zápis prejde, takže hook len
donúti zastaviť sa.

Globálne pravidlá majú strop slov, ktorý smie len klesať. Kratšie pravidlá sa dodržiavajú lepšie a každé slovo stojí
tokeny pri každom volaní modelu.

### Ako to postaviť

1. Napíš `global/CLAUDE.md`. Začni krátko (kapitola 12) a drž ho pod stropom, ktorý si určíš. Strop je číslo v súbore,
   napríklad `1500`, a kontrola spočíta slová súboru a zlyhá, keď ich je viac než číslo. Číslo smie len klesať, takže
   kontrola porovná aj so stavom v predošlom commite.
2. Linkni ho. Pri Claude Code to je `ln -s <klon pravidiel>/global/CLAUDE.md ~/.claude/CLAUDE.md`. Riadok v persone
   vyzerá `Role: zastupca-operatora, spravca-agentov`.
3. Napíš `env/<prostredie>/CLAUDE.md` pre veci typické pre stroj a linkni ho do koreňa stromu agentov, napríklad
   `ln -s <klon pravidiel>/env/server/CLAUDE.md /home/agenti/CLAUDE.md`.
4. Pri viac rolách napíš `roles/ROLES.md` ako index a `roles/<slug>.md` na každú. Mapovanie rolí na mená daj do
   jedného súboru, napríklad `roles/agents.md`, a nikam inam mená nepíš.
5. Napíš hook SessionStart, ktorý prečíta riadok `Role:` a vypíše súbory rolí na štandardný výstup. Pri SessionStart
   sa výstup hooku pridá do kontextu.
6. Napíš hook UserPromptSubmit s diffom klonu. Hook robí toto.
   1. Z JSON-u na vstupe vezmi `session_id`.
   2. Zisti `git rev-parse HEAD` nasadeného klonu.
   3. Prečítaj súbor stavu pre túto reláciu. Ak neexistuje, zapíš HEAD a skonči bez výstupu.
   4. Ak sa HEAD zhoduje, skonči. Inak ho zapíš a vypíš `git log --format='%h %s' <stará>..<nová> -- global/ env/<prostredie>/`
      a `git diff <stará>..<nová> -- global/ env/<prostredie>/`, najviac 20 kB.
7. Zabezpeč, aby sa klon pravidiel sám aktualizoval. Stačí časovač (cron alebo systemd), ktorý každých päť minút
   spustí `git fetch origin && git merge --ff-only origin/main`.
8. Napíš skript nasadenia, ktorý linky, hooky a časovač nastaví opakovateľne.
9. Pridaj do kontroly repa test na duplikáty. Rozdeľ pravidlá na jednotky (odrážka alebo odsek), zmaž diakritiku,
   interpunkciu a krátke slová, skráť slová na päť znakov a nahlás dvojicu jednotiek, kde sa zhodujú aspoň tri
   štvrtiny menšej z nich.

### Čo od runtime vyžaduje

- Načíta pokyny z domovského priečinka používateľa aj zo všetkých rodičov pracovného priečinka, alebo ti dá iný
  spôsob, ako vložiť globálny súbor do každej relácie.
- Podporuje hooky pri štarte relácie a pri každom prompte, ktorých výstup sa pridá do kontextu.
- Dá hooku vstup s id relácie a pracovným priečinkom. Hook podľa id relácie ukladá stav.
- Importuje súbor zo súboru (`@PERSONA.md`), alebo pridá persony iným spôsobom.

### Náš príklad

Tabuľka vrstiev je v `README.md`. Index rolí je `roles/ROLES.md`, pravidlá rolí `roles/zastupca-operatora.md`,
`roles/spravca-agentov.md`, `roles/pracovny-agent.md` a `roles/dizajner.md`. Hooky sú [hooks/identity.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/identity.mjs),
[hooks/rules_delta.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/rules_delta.mjs) a [hooks/own_rule_scope.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/own_rule_scope.mjs). Nasadenie robí `env/server/install.sh`, duplikáty hľadá
`lib/rule_dupes.mjs`, strop slov drží `lib/global_word_cap.txt`. Pravidlo "pokyn v rozpore s pravidlom" je záznam
`rozhodnutia/D0144.md`. Tieto štyri súbory v repe nie sú, sú viazané na náš runtime alebo súkromné. Čo robia, je
v tabuľke "Čo v repe nie je" v `README.md`.

## 3. Operátor a zástupca

### Problém

Operátor má málo času. Agent, ktorý sa ho pýta na všetko, ho zdržuje. Agent, ktorý nepýta nič, urobí aj to, čo si
operátor vyhradil. Pýtanie sa na veci, ktoré agent vie zariadiť sám, je navyše skrytá chyba, lebo sa tvári ako
opatrnosť.

Keď sú agenti viacerí a každý sa pýta operátora sám, operátor sa stane poštárom medzi nimi a nikto nevie, na čo
práve čaká. Otázky sa strácajú v rozhovoroch.

### Kedy to potrebuješ

Potrebuješ to, keď agenti pracujú dlhšie bez dozoru a operátor nemá čas schvaľovať každý krok. Potrebuješ to, keď
si operátor niečo vyhradil (platby, nové služby, kroky, ktoré sa nedajú vrátiť) a agent to musí poznať skôr, než sa
dotkne produkcie.

Nepotrebuješ to, keď pracuješ s jedným agentom a sedíš pri ňom. Vtedy rozhoduješ ty a agent sa pýta v rozhovore.
Pri troch a viac agentoch bez zástupcu skončíš ako sekretár, ktorý presúva otázky.

### Mechanizmus

Zástupca operátora je agent s mandátom rozhodovať za operátora, kde operátor nerozhoduje sám, v medziach, ktoré
operátor schválil. Mandát je napísaný v súbore roly. Jeho pokyn nesie značku "[<meno> za <operátor>]" a ostatní agenti
ho berú ako pokyn operátora. Zástupca je na každom stroji operátora jeden. Zástupcovia sú si rovní a stav si
odovzdávajú správami (kapitola 8), nie spoločnou pamäťou.

Operátor si vyhradil nový nástroj, službu alebo postup, krok, ktorý sa nedá vrátiť, prijatie a prepustenie agenta,
zmenu persony a hraníc moci. Platby a zmluvy robí len on. Tajomstvá ostávajú v súboroch s právami `600`. Všetko
ostatné zástupca rieši sám, technickú voľbu zapíše do registra rozhodnutí (kapitola 4). Operátorovi nosí len
rozhodnutia, ktoré patria jemu, a výstrahy.

Otázky pre operátora majú pevné miesto. Správa zástupcu, kým niečo čaká, končí riadkom "Čaká na teba:" a zoznamom
položiek so značkou (rozhodnutie), (hodnota) alebo (tvoj účet). Rozhodnutie je voľba medzi cestami, hodnota údaj,
ktorý agent nemá a nevie získať, a tvoj účet krok, ktorý sa dá urobiť len v operátorovom účte. Pred každou položkou
zástupca odpovie na jednu otázku. Viem to urobiť sám, alebo si na to zariadiť prostriedok? Ak áno, položka do riadku
nepatrí. Zakázané je napríklad založenie repa alebo pridanie kľúča cez API, ak má zástupca token alebo si ho vie
vypýtať.

Rozhodnutie pre operátora je len voľba medzi aspoň dvoma cestami, ktoré obe vedú k schválenému cieľu. Ak vedie len
jedna, je to požiadavka, a tú agent urobí a zapíše. Pred označením položky ako rozhodnutia agent napíše druhú cestu.

Úkony sa dajú schváliť vopred po triedach. Zástupca sa raz spýta "Môžem urobiť X? áno/nie". Po "áno" zapíše triedu
úkonu do registra rozhodnutí s rozsahom `schvalene` a už sa nepýta. Po "nie" ide úkon do "Čaká na teba:".

Zadanie od operátora, ktoré niečo mení, zástupca nevykoná hneď. Overí predpoklady, zistí dopady, prinesie plán (cieľ,
kroky, dopady, riziká, odporúčanie) a zadanie aj plán zapíše do úlohy. Vykoná ich po súhlase. Malej zmene stačia tri
vety. Plán úlohy v správcovi úloh (kapitola 7) schváli zástupca sám komentárom, ak v ňom nie je nič vyhradené
operátorovi.

Námietka operátora, ktorú agent po overení prijme, je súhlas so zmenou. Agent ju vykoná v tom istom ťahu, aj keď si
žiada nový nástroj. Pýta sa znova len pri kroku, ktorý sa nedá vrátiť, alebo pri kroku nad rámec námietky. Zakázaná
veta je "urobím to, keď to schválite". Pokyn proti písanému pravidlu pravidlo sám nemení. Agent pomenuje pravidlo
súborom a riadkom a operátor potvrdí pravidlo alebo zmenu.

Čakanie na vonkajší systém (register domén, šírenie DNS, odpoveď služby) nerobí zástupca modelom, lebo každá kontrola
modelom stojí volanie s celým kontextom. Zadá ho skriptu bez modelu s príkazom na kontrolu, krokom po splnení
a podmienkou hotového.

### Ako to postaviť

1. Do `roles/zastupca-operatora.md` napíš zoznam toho, čo si operátor vyhradil. Čo tam nie je, zástupca robí sám.
   Začni piatimi vyhradenými vecami a dopĺňaj ich z chýb.
2. Zapíš pravidlo "Čaká na teba:" s tromi značkami a kontrolnou otázkou. Položka vyzerá `- Schváľ doménu pre nový web
   (rozhodnutie)`.
3. Zapíš postup pre zadanie od operátora v poradí overiť, dopady, plán, zápis, vykonanie po súhlase.
4. Do globálnych pravidiel napíš značku zástupcu, pravidlo "prijatá námietka je súhlas" a pravidlo rozhodnutia s dvoma
   cestami.
5. Zaveď v registri rozhodnutí rozsah `schvalene` pre vopred schválené triedy úkonov (kapitola 4).
6. Voliteľne napíš hook Stop, ktorý prečíta poslednú odpoveď agenta. Ak obsahuje riadok "Čaká na teba:", každá
   položka pod ním musí končiť značkou (rozhodnutie), (hodnota) alebo (tvoj účet), inak hook odpoveď zastaví a vypíše
   chýbajúcu značku.
7. Skript na čakanie napíš ako malú slučku bez modelu. Každých pár minút spustí príkaz na kontrolu, napríklad `dig +short
   example.org`. Keď príkaz vráti očakávaný výsledok, zapíše správu agentovi do schránky (kapitola 8) alebo komentár
   do úlohy (kapitola 7) a skončí. Po zadanom čase zapíše správu o vypršaní.

### Čo od runtime vyžaduje

- Dá sa v ňom spustiť agent, ktorého persona uvádza rolu (kapitola 2), aby sa mandát zástupcu načítal pri štarte.
- Hook Stop dostane poslednú odpoveď (u Claude Code cez prepis relácie, ktorého cestu hook dostane vo vstupe).
- Skript čakania vie agenta zobudiť. To je buď správa v schránke s budičom (kapitola 8), alebo komentár v správcovi
  úloh, ktorý riešiteľa zobudí (kapitola 7).

### Náš príklad

Rolu opisuje `roles/zastupca-operatora.md`, časti "Čo urobí sám a čo čaká na operátora", "Zadanie od operátora",
"Hranice" a "Kontinuita". Čo si operátor vyhradil, je v `roles/ROLES.md`. Rozhodnutie s dvoma cestami je v
`global/CLAUDE.md`, §6, prijatá námietka v §1. Riadok "Čaká na teba:" kontroluje [hooks/reply_guard.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/reply_guard.mjs) s premennou
`AR_ROZHODNUTIA=1`. Rozsah `schvalene` je v `rozhodnutia/ROZSAHY.md`.

## 4. Register rozhodnutí

### Problém

Rozhodnutie povedané v rozhovore zanikne s reláciou. Agent sa o týždeň spýta znova alebo urobí opak. Zápis v jednom
veľkom súbore sa nedá kontrolovať a staré rozhodnutie sa nahradí novým bez opravy miest, ktoré tvrdia to staré. Pokyny
agentov potom tvrdia veci, ktoré dávno neplatia.

### Kedy to potrebuješ

Potrebuješ to, keď sa agent opakovane pýta na veci, ktoré si už rozhodol, alebo keď sa pravidlá menia a staré znenia
ostávajú v personách, pamäti a dokumentoch. Potrebuješ to aj vtedy, keď chceš o rozhodnutí vedieť, kto ho urobil
a akou mocou.

Nepotrebuješ to pri jednom agentovi a desiatke pravidiel. Vtedy stačí jeden súbor s odrážkami v repe. Register založ,
keď nájdeš v pokynoch dve tvrdenia, ktoré si protirečia, alebo keď sa ti stane, že agent robí podľa rozhodnutia, ktoré
už neplatí.

### Mechanizmus

Rozhodnutie je jeden súbor v `rozhodnutia/`, pomenovaný `D0001.md`, `D0002.md` a tak ďalej. Hlavička je zoznam polí
`kľúč: hodnota` medzi dvoma riadkami `---`, potom nasleduje krátke telo. Súbor sa nikdy nemaže, zmena stavu je commit.

| pole | význam |
|---|---|
| `id` | `D` a štyri číslice, rovná sa menu súboru |
| `nazov` | jedna veta, čo platí |
| `stav` | `platí`, `nahradené` alebo `zrušené` |
| `kluc` | bodková cesta jednej veci, napríklad `odpoved.strop-viet`, medzi platnými záznamami jedinečná |
| `rozsah` | značky z `rozhodnutia/ROZSAHY.md`, teda témy, ktorých sa rozhodnutie týka |
| `agenti` | mená agentov malými písmenami, alebo `*` |
| `rozhodol`, `moc` | kto rozhodol a akým mandátom (operátor, zástupca, správca agentov a podobne) |
| `zapisal`, `datum` | kto záznam zapísal a kedy |
| `zdroj` | kde to zaznelo, napríklad vlákno, správa alebo úloha |
| `nahradza`, `nahradene` | odkazy medzi záznamami, obe strany ukazujú na seba |
| `subory` | súbory repa, ktoré rozhodnutie stelesňujú, musia existovať |
| `zrusene-tvrdenie` | regulárny výraz vety, ktorá po zmene nesmie nikde stáť |

Telo má najviac päť viet. Hovorí, čo platí, prečo, a čo sa zamietlo. História je v gite.

Kľúč bráni dvom platným záznamom o jednej veci. Skript zápisu skončí chybou, keď nový záznam s platným kľúčom
nehovorí, že starý nahrádza. Moc bráni, aby o pravidlách rozhodol agent bez mandátu. Tabuľka rozsahu a moci je v
`rozhodnutia/ROZSAHY.md` a kontrola ju vynucuje. Súbor `INDEX.md` je generovaný prehľad všetkých záznamov, ručne sa
neupravuje.

Zápis ide jednou cestou. Skript [bin/rozhodni.sh](https://github.com/gavalierm/agent-runtime/blob/main/bin/rozhodni.sh) pridelí číslo, zapíše súbor, prepíše `INDEX.md`, commitne pod menom
agenta a pushne. Hook, ktorý zamietne každý iný zápis do záznamov, beží pred použitím nástroja. Zachytí zápis cez
nástroj na úpravu súboru aj príkaz v shelli, vrátane `sed -i`, presmerovania a `tee`. Voľba `--dry-run` nezapíše nič,
voľba `--zrus` rozhodnutie zruší.

Zrušené tvrdenia sa kontrolujú strojom. Keď rozhodnutie niečo mení, jeho pole `zrusene-tvrdenie` nesie regulárny
výraz starej vety. Kontrola prehľadá pokyny agentov a pamäť a zlyhá na každom mieste, ktoré starú vetu ešte tvrdí.
Druhá kontrola prejde cesty v spätných apostrofoch v pokynoch a zlyhá na ceste k súboru, ktorý neexistuje. Tretia
zlyhá na pamäti, ktorá tvrdí, že niečo čaká na operátora bez čísla úlohy, alebo spomína rozhodnutie bez čísla záznamu.

Agent sa o rozhodnutiach dozvie z troch miest. Hook pri štarte relácie vloží zmeny od posledného štartu a úlohy
čakajúce na operátora. Hook zmeny pravidiel z kapitoly 2 vloží zmenu záznamu do najbližšieho promptu. A agent si
zoznam vypíše sám, `node lib/rozhodnutia.mjs list --agent <meno>`.

Poznámka v rozhovore nie je rozhodnutie. Zapíše sa až po tom, čo operátor povie áno na text. Kým o veci diskutujú,
záznam sa nepíše.

### Ako to postaviť

1. Založ `rozhodnutia/` a `rozhodnutia/README.md` so schémou polí.
2. Napíš `rozhodnutia/ROZSAHY.md` s tabuľkou značiek a tabuľkou "rozsah smie moc". Začni piatimi značkami.
3. Napíš skript zápisu. Pridelí ďalšie číslo (najvyššie číslo v priečinku plus jedna), zapíše hlavičku a telo zo
   štandardného vstupu, spustí kontrolu a commitne. Zápis nikdy neprepíše existujúci súbor.
4. Napíš kontrolu. Id sa rovná menu súboru, kľúč je medzi platnými jedinečný, odkazy `nahradza` a `nahradene` ukazujú
   na seba, súbory z `subory` existujú, značka je v tabuľke, moc sedí k rozsahu.
5. Napíš zoznam zrušených tvrdení a kontrolu, ktorá ich hľadá v pokynoch a v pamäti. Zoznam môže byť obyčajný textový
   súbor, kde riadok je regulárny výraz, tabulátor a dôvod.
6. Zapoj hook PreToolUse, ktorý zamietne zápis do `rozhodnutia/` mimo skriptu. Hook zamietne nástroj na zápis, ktorého
   cesta vedie do záznamu `rozhodnutia/D0xxx.md`, a príkaz v shelli, ktorý spomína taký záznam spolu so `sed -i`,
   `tee` alebo presmerovaním. Zamietnutie nesie riadok "Správny postup:" (kapitola 6).
7. Zapoj hook SessionStart so zmenami od posledného štartu a spusti kontrolu v pre-commit hooku.

Záznam:

```
---
id: D0001
nazov: Odpoveď operátorovi má najviac šesť viet
stav: platí
kluc: odpoved.strop-viet
rozsah: pravidla
agenti: *
rozhodol: <meno operátora>
moc: operator
zapisal: <agent>
datum: <RRRR-MM-DD>
zdroj: <vlákno alebo úloha, kde to zaznelo>
subory: <cesta k súboru, ktorý pravidlo vymáha>
---
Odpoveď operátorovi má najviac šesť viet prózy. Dôvod je, že dlhú odpoveď operátor nečíta.
Zamietnutý bol strop dvanásť viet, lebo ho agenti pravidelne dosiahli.
```

### Čo od runtime vyžaduje

- Hooky PreToolUse a SessionStart, ktoré vedia pridať text do kontextu alebo zamietnuť nástroj s dôvodom (kapitola 6).
- Hook PreToolUse vidí aj príkazy v shelli, nielen zápisy cez nástroj na úpravu súborov. Ak runtime shell hookom
  nevidí, zápis cez `sed` nechytíš a stráž to kontrolou v pre-commit hooku.
- Prístup k gitu a možnosť pushnúť pod menom agenta.

### Náš príklad

Schéma je v `rozhodnutia/README.md`, značky v `rozhodnutia/ROZSAHY.md`. Ukážkové záznamy sú `rozhodnutia/D0141.md`,
`rozhodnutia/D0142.md` a `rozhodnutia/D0144.md`, ktorý nahrádza `rozhodnutia/D0010.md`. Zápis robí [bin/rozhodni.sh](https://github.com/gavalierm/agent-runtime/blob/main/bin/rozhodni.sh),
logiku a kontrolu [lib/rozhodnutia.mjs](https://github.com/gavalierm/agent-runtime/blob/main/lib/rozhodnutia.mjs) s testom [test/rozhodnutia.test.mjs](https://github.com/gavalierm/agent-runtime/blob/main/test/rozhodnutia.test.mjs). Zrušené tvrdenia číta `lib/doc_paths.mjs`
zo súboru `lib/retired_claims.txt`, pamäť kontroluje `lib/memory_claims.mjs`. Hooky sú `hooks/rozhodnutia_guard.mjs` a
`hooks/rozhodnutia_context.mjs`. Záznamy D0010, D0141, D0142 a D0144, skripty `lib/doc_paths.mjs` a
`lib/memory_claims.mjs`, zoznam `lib/retired_claims.txt` a oba hooky `rozhodnutia_*` v repe nie sú. Záznamy sú
súkromné, ostatné sú viazané na naše úlohy a pamäť. Čo robia, je v tabuľke "Čo v repe nie je" v `README.md`.

## 5. Slučka chyby

### Problém

Agent urobí chybu, operátor ho opraví, agent povie "máš pravdu" a o týždeň urobí to isté. Oprava zapísaná len do
pamäte alebo do rozhovoru neprežije. Oprava, ktorá nemení súbor riadiaci správanie, nie je oprava. A prosba o väčšiu
opatrnosť chybu nezablokuje.

Keď chyby nikto nezapisuje, nevidíš, ktoré sa opakujú. Opakovaná chyba je signál, že pravidlo alebo kontrola chýba,
a bez záznamu ho nezachytíš.

### Kedy to potrebuješ

Potrebuješ to, keď sa ti tá istá chyba vráti druhýkrát, aj keď ju agent už raz uznal. Potrebuješ to aj vtedy, keď
agentovi veríš na slovo a neskôr zistíš, že tvrdil, čo neoveril.

Nepotrebuješ to, kým agent robí jednorazové úlohy a chyby nemajú dôsledok. Aj vtedy ale pomôže prvý krok kapitoly,
teda definícia chyby v pravidlách. Skript, register a hook pridaj, až keď máš prvú opakovanú chybu.

### Mechanizmus

Slučka má päť krokov. Operátor namietne. Agent námietku overí a prijme. Opraví súbor, ktorý správanie riadi, a
commitne. Zapíše chybu do registra skriptom. Zavedie kontrolu, ktorá chybu zablokuje, najneskôr pri druhom výskyte
triedy. Trieda chyby je krátky kľúč pre jednu príčinu, napríklad `neoverene-tvrdenie`. Rovnaká príčina je rovnaká
trieda aj pri inom konkrétnom prípade.

Za chybu sa považuje nepravdivé tvrdenie, krok, ktorý nebol agentov, zbytočná akcia operátora, prijatá námietka,
oprava vyžiadaná dvakrát alebo škoda na živom systéme. Každá chyba agenta je chyba procesu. Agent nájde nástroj,
pravidlo alebo kontrolu, ktoré ju pustili, a opraví ich skôr, než chybu vyhlási za vybavenú.

Oprava patrí do súboru, ktorý správanie riadi, teda do persony, pravidla, skillu, hooku alebo kontroly. Zápis do
pamäte opravou nie je. Pravidlo sa píše ako cieľové správanie s kontrolou, ktorú možno odškrtnúť, a pri zákaze so
zakázanou vetou. Persona nesie krátky riadok o incidente. Mená z incidentu patria do záznamu rozhodnutia, nie do
pravidla roly.

Najsilnejšia oprava je kontrola, ktorá na chybe zlyhá. Je to test, hook alebo skript. Pred vyhlásením opravy sa chyba
zopakuje (replay) a kontrola sa ukáže, ako zlyháva. Replay nikdy nesiaha na živý systém a najprv overí, že nemôže
spadnúť na živú cestu, schránku alebo službu. Po zmene hodnoty, voľby alebo cesty agent nájde starú hodnotu príkazom
`grep -rn` a opraví každý zásah, aj v dokumentoch a komentároch.

Mechanickú časť robí [bin/chyba.sh](https://github.com/gavalierm/agent-runtime/blob/main/bin/chyba.sh). Prijme triedu chyby a súbor, ktorý správanie riadi, a urobí štyri veci.

1. Odmietne súbor, ktorý nie je commitnutý, aby hlásenie malo číslo commitu opravy.
2. Zapíše do registra riadok (dátum, agent, trieda, súbor, commit, popis, číslo úlohy).
3. Pri druhom výskyte tej istej triedy toho istého agenta založí v správcovi úloh úlohu na kontrolu, ktorá chybu
   zablokuje.
4. Vypíše hlásenie v štyroch vetách. Čo som tvrdil alebo urobil, čo bola pravda, ktorý súbor a commit sa zmenil, čo to
   nabudúce zastaví.

Hlásenie agent vloží do najbližšej odpovede operátorovi, aj keď sa nepýta.

Slučku vynucuje hook, ktorý beží pred koncom odpovede (Stop). Prečíta poslednú odpoveď a príkazy ťahu. Keď odpoveď
uznáva chybu (frázy ako "máš pravdu" alebo "moja chyba") a v ťahu nebežal `chyba.sh`, odpoveď zastaví. Zastaví ju
aj vtedy, keď v ťahu chýba commit súboru, ktorý agenta riadi, alebo keď odpoveď nenesie číslo commitu. Pri druhom
zastavení v rade mlčí, aby sa nezacyklil.

Správca agentov robí navyše postup zlepšovania v šiestich krokoch.

1. Nájde súbor a riadok, ktorý chýbal alebo klamal.
2. Určí jednu príčinu v systéme.
3. Napíše opravu s kontrolou.
4. Nasadí ju.
5. Zopakuje scenár, v ktorom problém vznikol.
6. Zapíše rozhodnutie.

Opravu typu "zapísal som to do skillu" neschváli.

### Ako to postaviť

1. Do globálnych pravidiel napíš sekciu o chybách. Definuj chybu, povedz, že je to chyba procesu, že oprava ide do
   súboru riadiaceho správanie a že kontrola musí na chybe zlyhať.
2. Do persony daj sekciu "Vlastná chyba", ktorá na globálne pravidlo odkazuje a nesie krátke riadky incidentov.
3. Napíš [bin/chyba.sh](https://github.com/gavalierm/agent-runtime/blob/main/bin/chyba.sh) s voľbami `--trieda`, `--subor`, `--popis`, `--pravda`, `--kontrola`. Register je súbor s
   tabulátormi mimo repa, napríklad `~/.local/state/<názov>/chyby.tsv`. Skript zistí commit príkazom
   `git log -1 --format=%h -- <súbor>` a odmietne súbor, ktorý má neuložené zmeny (`git status --porcelain -- <súbor>`
   nie je prázdny).
4. Napíš skill `chyba`, ktorý hovorí, kedy skript spustiť a v akom poradí. Skill je súbor `SKILL.md` s popisom, podľa
   ktorého ho agent vyberie.
5. Napíš hook Stop, ktorý zastaví odpoveď uznávajúcu chybu bez commitu a bez skriptu. Hook robí toto.
   1. Z JSON-u na vstupe vezme `transcript_path` a `stop_hook_active`. Ak je `stop_hook_active` pravda, skončí
      bez výstupu.
   2. Prečíta prepis (jeden JSON na riadok) a nájde poslednú správu operátora, teda záznam `user`, ktorý nesie text.
   3. Zo záznamov `assistant` po nej zozbiera texty odpovede a príkazy nástroja Bash.
   4. Ak text obsahuje frázu z regulárneho výrazu uznania a medzi príkazmi nie je `chyba.sh`, vypíše
      `{"decision":"block","reason":"<dôvod> Správny postup: <krok>"}`.
6. Napíš test hooku s prepisom konverzácie z reálnej chyby. Test musí zlyhať, keď hook vypneš.
7. Úlohu na kontrolu pri druhom výskyte zadaj agentovi, ktorý spravuje pravidlá (kapitola 7).

Spustenie (skript je v repe agent-runtime, v klone vedľa tvojho repa):

```
bin/chyba.sh --trieda neoverene-tvrdenie --subor PERSONA.md \
  --popis "tvrdil som stav bez kontroly" --pravda "stav bol iný" \
  --kontrola "hook odmietne odpoveď bez dôkazu"
```

### Čo od runtime vyžaduje

- Hook, ktorý beží pred koncom odpovede a môže odpoveď zastaviť s dôvodom, ktorý agent dostane späť.
- Prístup hooku k prepisu relácie, aby videl text odpovede a príkazy ťahu. U Claude Code je to cesta v poli
  `transcript_path`.
- Príznak, že hook už raz zastavil (`stop_hook_active`), aby sa slučka neopakovala donekonečna.
- Pri automatickom založení úlohy na kontrolu správca úloh s príkazovým riadkom (kapitola 7). Bez neho skript úlohu
  nezaloží a povie to.

### Náš príklad

Pravidlá chýb sú v `global/CLAUDE.md`, §4, prijatá námietka v §1. Skript je [bin/chyba.sh](https://github.com/gavalierm/agent-runtime/blob/main/bin/chyba.sh), skill
`skills/chyba/SKILL.md`, hook [hooks/objection_fix.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/objection_fix.mjs), testy [test/chyba.test.mjs](https://github.com/gavalierm/agent-runtime/blob/main/test/chyba.test.mjs) a [test/objection_fix.test.mjs](https://github.com/gavalierm/agent-runtime/blob/main/test/objection_fix.test.mjs).
Rozhodnutie o slučke je `rozhodnutia/D0142.md`, súkromný záznam, ktorý v repe nie je (obsah je v tabuľke "Čo v repe
nie je" v `README.md`). Postup zlepšovania je v `roles/spravca-agentov.md`, časť "Zlepšovanie agentov". Sekciu
"Vlastná chyba" ukazuje `PERSONA.md` v repe správcu agentov.

## 6. Hooky ako vymáhanie

### Problém

Pravidlo napísané vo vete model dodrží väčšinou, nie vždy. Čím dlhší kontext, tým väčšia šanca, že naň zabudne.
Operátor nemôže čítať každú odpoveď. Čo sa dá skontrolovať strojom, má sa skontrolovať strojom.

Zamietnutie bez vysvetlenia je ďalší problém. Model po ňom hádá a každý pokus stojí volanie s celým kontextom.

### Kedy to potrebuješ

Potrebuješ to pri pravidle, ktoré agent porušil aspoň dvakrát, a pri kroku, ktorého následok sa nedá vrátiť (zápis do
registra mimo skriptu, nebezpečný príkaz gitu, odpoveď s odkazom, ktorý nefunguje). Pri pravidle, ktoré agent
dodržiava, hook nepíš. Každý hook pridáva kód, ktorý treba udržiavať, a trochu spomaľuje ťah.

Nepotrebuješ to na začiatku. Začni pravidlom vo vete, a keď ho agent poruší, napíš hook na tú jednu chybu.

### Mechanizmus

Hook je skript, ktorý runtime spustí pri udalosti. Dostane JSON na štandardnom vstupe (napríklad `session_id`,
`cwd`, `transcript_path`, `tool_input`) a výsledok vráti výstupom alebo kódom skončenia. Pri Claude Code platí toto.

- Kód 0 hovorí, že hook prebehol. Výstup SessionStart a UserPromptSubmit sa pridá do kontextu agenta.
- Kód 2 zablokuje krok a agent dostane text zo štandardného chybového výstupu.
- Iný kód je chyba hooku. Krok pokračuje a agent o chybe nevie.
- Hook môže namiesto toho vypísať JSON. Zamietnutie nástroja (PreToolUse) je
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`.
  Zastavenie odpovede (Stop) je `{"decision":"block","reason":"..."}`.

Udalosti, ktoré používame:

| udalosť | kedy beží | čo u nás vymáha |
|---|---|---|
| SessionStart | štart, obnovenie, `/clear`, kompakcia | `unslop.mjs` vloží jadro pravidiel písania, `identity.mjs` ohlási identitu a vloží roly, `clear_bridge.mjs` urobí štart relácie po `/clear`, `rozhodnutia_context.mjs` vloží zmeny rozhodnutí |
| UserPromptSubmit | pri každom prompte | `context_warning.mjs` upozorní na hranicu kontextu, `rules_delta.mjs` vloží zmenu pravidiel, `tasker_work.mjs` ohlási prácu na úlohe |
| PreToolUse | pred použitím nástroja | `no_model_wait.mjs` zamietne čakanie v popredí, `foreign_git.mjs` a `git_pull.mjs` nebezpečný git, `tasker_root.mjs` priamy príkaz správcu úloh pod rootom, `web_review.mjs` úlohu webu bez posudku, `rozhodnutia_guard.mjs` zápis rozhodnutia mimo skriptu, `own_rule_scope.mjs` pravidlo na zlej úrovni |
| SubagentStop | koniec sub-agenta | `tasker_work.mjs` ukončí záznam práce |
| Stop | pred koncom odpovede | `reply_guard.mjs` strop a odkazy v odpovedi, `todo_after_comment.mjs` úlohu po komentári, `objection_fix.mjs` uznanú chybu bez opravy |

Každé zamietnutie nesie správny postup. Zásada stojí na jednom pomocnom module, cez ktorý zamietajú všetky hooky. Modul
vypíše dôvod a riadok "Správny postup: <krok>" a odmietne prázdny postup aj nejasné vety ako "skús inak". Agent tak
nemusí hádať a ušetrí volanie, ktoré by stálo celý kontext. Strážca beží v kontrole repa a zlyhá na hooku, ktorý
zamieta surovým JSON-om, kódom 2 alebo `echo` na chybový výstup bez postupu. Pravidlo v pokynoch, ktoré hook stráži,
potom stačí krátkou vetou s menom hooku.

Tri zásady pre vlastný hook.

- Hook typu Stop pri druhom zastavení v rade (`stop_hook_active`) mlčí, inak sa zacyklí.
- Hook, ktorý len ohlasuje, nikdy nezablokuje nástroj a pri chybe mlčí s kódom 0.
- Hook, ktorý drží stav v súbore, ukladá ho po relácii, aby sa relácie neovplyvňovali.

Každý hook má test vedľa seba. Chyba, kvôli ktorej hook vznikol, je v teste ako replay, teda znovu spustený vstup,
ktorý chybu spôsobil. Test nikdy nesiaha na živú databázu ani službu. Hooky čítajúce stav správcu úloh čítajú databázu
len na čítanie.

Zapojenie je v `settings.json`, buď v nastavení prostredia, alebo v `.claude/settings.json` repa agenta. Inštalátor
najprv odstráni skupiny hookov z našej cesty a potom pridá aktuálne, takže ho možno spúšťať opakovane a starý klon
nezostane zapojený.

### Ako to postaviť

1. Napíš pomocný modul na zamietnutie s tromi funkciami. Prvá zamietne nástroj (PreToolUse), druhá zastaví odpoveď
   (Stop) a tretia zamietne kódom 2. Všetky vezmú dôvod a postup a odmietnu prázdny postup.
2. Napíš kontrolu, ktorá zlyhá na hooku so surovým zamietnutím. Stačí prehľadať súbory hookov a nájsť
   `permissionDecision` alebo `process.exit(2)` mimo pomocného modulu.
3. Začni jedným hookom Stop, ktorý stráži jednu vec, čo sa ti už pokazila.
4. Pre každý nový hook napíš test s replayom chyby a pridaj ho do kontroly repa.
5. Zapoj hook v `settings.json` opakovateľným skriptom.

Najmenší hook, ktorý zamietne čakanie v popredí:

```
#!/usr/bin/env node
import { readFileSync } from "node:fs";

let input = {};
try { input = JSON.parse(readFileSync(0, "utf8")); } catch { process.exit(0); }
const cmd = input.tool_input?.command ?? "";
const m = cmd.match(/\bsleep\s+(\d+)/);
if (m && Number(m[1]) > 10) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "Čakanie v popredí drží ťah otvorený a platíš ho.\nSprávny postup: skonči odpoveď a výsledok spracuj v ďalšom ťahu.",
    },
  }));
}
```

Zapojenie:

```
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "node <klon agent-runtime>/hooks/reply_guard.mjs" } ] }
    ],
    "PreToolUse": [
      { "matcher": "Bash",
        "hooks": [ { "type": "command", "command": "node <klon pravidiel>/hooks/no_model_wait.mjs" } ] }
    ]
  }
}
```

### Čo od runtime vyžaduje

- Hooky na udalostiach z tabuľky, ktoré dostanú JSON na vstupe a vedia pridať text do kontextu, zamietnuť nástroj
  alebo zastaviť odpoveď. Claude Code to robí a popisuje formáty v dokumentácii hookov.
- Zapojenie v súbore nastavení, ktoré runtime číta pri štarte. Zmena nastavenia sa u Claude Code prejaví v novej
  relácii, nie vždy v bežiacej.
- Node.js alebo iný interpreter, v ktorom hook napíšeš. Hook môže byť aj shell skript, ak vstup číta nástrojom na JSON.

### Náš príklad

Hooky sú v priečinku `hooks/` repa agent-runtime a ich testy v jeho priečinku `test/`, v tomto repe ich nie je. Helper zamietnutia je [lib/deny.mjs](https://github.com/gavalierm/agent-runtime/blob/main/lib/deny.mjs) (pre git hooky
[lib/deny.sh](https://github.com/gavalierm/agent-runtime/blob/main/lib/deny.sh)), strážca [lib/deny_check.mjs](https://github.com/gavalierm/agent-runtime/blob/main/lib/deny_check.mjs), rozhodnutie `rozhodnutia/D0141.md`. Zapojenie robí funkcia `settings` v
`env/server/install.sh`, ktoré v repe nie sú (v tabuľke "Čo v repe nie je" v `README.md`). Hlavičkové komentáre
[hooks/reply_guard.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/reply_guard.mjs), [hooks/objection_fix.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/objection_fix.mjs), [hooks/todo_after_comment.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/todo_after_comment.mjs) a [hooks/tasker_work.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/tasker_work.mjs)
opisujú, čo hook vymáha a čo ho vyvolalo.

## 7. Práca je úloha v správcovi úloh

### Problém

Práca zadaná v rozhovore nemá dôvod, podmienku hotového ani stav. Nikto nevie, či stojí, čaká alebo je hotová.
Otvorená úloha, na ktorej nikto nepracuje, sa stratí. Otázka na človeka v rozhovore sa stratí tiež, lebo sa nezobrazí
tam, kde ju človek hľadá.

### Kedy to potrebuješ

Potrebuješ to, keď agent robí viac vecí naraz, keď práca trvá dlhšie než jednu reláciu, alebo keď na nej pracuje viac
agentov. Potrebuješ to aj vtedy, keď sa operátor pýta "čo stojí a prečo".

Nepotrebuješ to pri jednom agentovi a jednej úlohe, ktorú dokončí jedna relácia. Vtedy stačí rozhovor. Na začiatok
stačí aj súbor na úlohu v repe projektu (časť "Ako to postaviť"). Hooky z konca kapitoly pridaj, až keď máš nástroj,
ktorý vieš čítať strojom.

### Mechanizmus

Bežná práca pre agenta je úloha v správcovi úloh (u nás Tasker). Správca úloh je nástroj s databázou úloh,
príkazovým riadkom a webom. Každá úloha má projekt, dôvod, podmienku hotového a riešiteľa. Riešiteľ je agent alebo
človek, ktorý ju robí. Podmienka hotového je zápis, podľa ktorého sa dá rozhodnúť, či je úloha hotová, najlepšie
príkaz a jeho očakávaný výstup. Úloha bez projektu sa odmietne. Úloha bez riešiteľa po dokončení blokérov nikoho
nezobudí, preto sa úloha, ktorú agent robí sám alebo cez sub-agenta, zakladá s riešiteľom.

Stavy, ktoré pravidlá a hooky používajú:

| stav | význam |
|---|---|
| `todo` | čaká na prevzatie |
| `in_progress` | niekto na nej pracuje |
| `needs_human` | agent sa pýta človeka alebo čaká na jeho schválenie |
| `blocked` | stojí na inej úlohe |
| `waiting` | čaká na udalosť mimo správcu úloh |
| `done`, `cancelled`, `failed` | koniec |

Otázka na človeka je stav úlohy, nie veta v rozhovore. Agent zapíše otázku do komentára, nastaví `needs_human` a beh
ukončí. Odpoveď človeka je komentár, ktorý úlohu zobudí. Keď odpoveď príde do vlákna namiesto komentára, agent ju
najprv zapíše do úlohy komentárom s menom operátora a až potom koná. Inak správca úloh o odpovedi nevie a úloha stojí.

Čakanie má dva tvary a oba majú dôvod. Čakanie na inú úlohu je blokér, teda väzba "táto úloha stojí na tamtej", s
povinným dôvodom, ktorý hovorí, na čom blokér stojí, kto ho odstráni a čo úlohu potom pohne. Čakanie na udalosť mimo
správcu úloh je stav `waiting` s dôvodom a časom, po udalosti sa úloha uzavrie alebo obnoví. Holé čísla blokérov
čitateľovi nepovedia, na čom úloha stojí.

Oprava práce na zavretej úlohe ide novou úlohou, lebo komentár na zavretej úlohe nikoho nezobudí.

Pre úlohu s viac krokmi platí štvorkrokový postup.

1. Nejasné zadanie. Agent zapíše najviac päť otázok, ktorých odpoveď nenájde v kóde ani v úlohe, a skončí v stave
   `needs_human`. Pri viacerých otázkach navrhne rozdelenie úlohy.
2. Plán. Agent zapíše do komentára plán so štyrmi časťami. Čo robíme (dve až štyri vety), kroky (najviac sedem), čo
   nerobíme (nikdy prázdne) a ako overíme, že to funguje (jedna až tri skúšky). Plán nejde do súboru v repe.
   Schválenie je komentár. Plán schváli zástupca operátora, vyhradenú vec operátor.
3. Stavba. Krok, ktorý sa nezmestí do jedného behu, je podúloha zreťazená blokérmi
   na úlohe. Prácu mimo plánu agent nerobí, zmenu plánu navrhne komentárom a skončí v stave `needs_human`.
4. Kontrola. Pred uzavretím agent zapíše komentár s tromi odpoveďami s dôkazom. Funguje to (príkaz a jeho výstup)?
   Sedí to s plánom (čo chýba, čo pribudlo, čoho iného sa zmena dotkne)? Je to jednoduché (čo by sa dalo zmazať)?
   Keď odpoveď neobstojí, výsledok je `needs_human` s dôvodom.

Za tok práce zodpovedá správca agentov. Otvorená úloha, na ktorej nikto nepracuje, je jeho chyba. Blokér pridelený
človeku sleduje a keď ho do 30 minút nikto nevezme, pošle operátorovi notifikáciu s číslom úlohy a tým, čo presne
stojí. Zakázaná veta je "čaká na operátora" bez času a bez notifikácie.

Hooky držia správcu úloh a ťah v súlade. Hook `todo_after_comment.mjs` zastaví ťah, v ktorom agent napísal komentár na
svojej úlohe a tá ostala v stave `todo`, a dá postup (uzavrieť, čakať, blokovať alebo položiť otázku). Hook
`tasker_work.mjs` ohlási prácu sub-agenta z čísla úlohy v jeho zadaní. Hook `tasker_root.mjs` zamietne priamy príkaz
správcu úloh pod rootom a pošle agenta k obalu `bin/tk`. Obal je malý skript, ktorý spustí príkaz správcu úloh pod
správnym používateľom a s menom agenta v prostredí. Číslo úlohy v texte pre operátora je odkaz na jej stránku, hook
`reply_guard.mjs` zastaví neprepojenú zmienku a dá hotovú náhradu.

### Ako to postaviť

1. Vyber správcu úloh s príkazovým riadkom. Ak ho nemáš, začni súborom na úlohu v repe projektu, napríklad
   `ulohy/0042.md`. Súbor má hlavičku medzi dvoma riadkami `---` s poľami `id`, `nazov`, `projekt`, `stav`,
   `riesitel`, `dovod`, `hotovo` a `blokery` (zoznam čísel úloh), pod ňou komentáre, každý riadok s dátumom a menom.
   Takýto súbor prečíta aj hook aj človek. Hooky tejto kapitoly pridaj, až keď máš nástroj, ktorý vieš čítať strojom.
2. Ustáľ stavy z tabuľky a povinnosť dôvodu pri blokéri a čakaní. Príkaz vyzerá `tasker block <id> --by <id> --reason
   "<dôvod>"` a bez dôvodu zlyhá. Ak používaš súbory, kontrola repa odmietne `stav: blocked` bez neprázdneho komentára
   o príčine.
3. Do pravidiel prostredia napíš, že práca je úloha s projektom, dôvodom a podmienkou hotového.
4. Do prostredia napíš štvorkrokový postup a použi ho najprv pri jednom projekte.
5. Zaveď pravidlo, že odpoveď operátora do vlákna sa najprv zapíše do úlohy.
6. Napíš hook Stop, ktorý zastaví ťah, po ktorom komentovaná úloha agenta ostala v stave `todo`. Hook nájde úlohy,
   kde je riešiteľ agent, stav `todo` a posledný komentár napísal agent po poslednej správe operátora. Stav čítaj z
   databázy správcu úloh len na čítanie, alebo zo súborov.
7. Do roly správcu agentov napíš, že otvorená úloha bez práce je jeho chyba, a limit 30 minút pre blokér pridelený
   človeku.
8. Rozhodni, ako sa úloha dostane k agentovi. Keď niekto pridelí úlohu agentovi alebo pridá komentár, riešiteľ sa musí
   dozvedieť. Napíš malý most, ktorý sleduje udalosti správcu úloh a zapíše správu do schránky riešiteľa (kapitola 8).

### Čo od runtime vyžaduje

- Správca úloh, ktorý sa dá ovládať z príkazového riadku, aby ho agent použil nástrojom na príkazy. Webové rozhranie
  nestačí.
- Stav úloh čitateľný strojom pre hooky. Najlepšie databáza alebo súbory, ktoré hook otvorí len na čítanie.
- Cesta, ktorou sa riešiteľ dozvie o zmene (kapitola 8), inak úlohy stoja, kým sa agent nepozrie sám.
- Hook PreToolUse pre nástroje na spustenie sub-agenta, ak chceš ohlasovať prácu sub-agentov. Vstup hooku nesie zadanie
  sub-agenta, z ktorého hook vytiahne číslo úlohy.

### Náš príklad

Pravidlá sú v `env/server/CLAUDE.md`, častiach "Správca úloh" a "Postup úlohy". Plán schvaľuje zástupca podľa
`roles/zastupca-operatora.md`. Tok práce a 30 minút pre blokér sú v `roles/spravca-agentov.md`, časť "Čo spravuje a
tok práce". Hooky sú [hooks/todo_after_comment.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/todo_after_comment.mjs) a [hooks/tasker_work.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/tasker_work.mjs). Obal je `bin/tk`. Hook
`hooks/tasker_root.mjs`, skript `bin/uloha-webu.sh` (založí úlohu pre agenta webu spolu s úlohou posudku dizajnéra)
a hook `hooks/web_review.mjs` (zamietne všetko ostatné) sú viazané na náš správca úloh a v repe nie sú, opisuje ich
tabuľka "Čo v repe nie je" v `README.md`. Samotný správca úloh v tomto repe nie je, je to samostatný nástroj. Most,
ktorý doručuje udalosti úloh do schránok, je v repe `https://github.com/gavalierm/agent-runtime` (verejné, D0171).

## 8. Správy medzi agentmi

### Problém

Máš dvoch agentov v trvalých reláciách a prvý potrebuje od druhého výsledok, napríklad nasadenie na testovací stroj.
Operátor nemá byť poštár, ktorý správy prepisuje z jedného okna do druhého. Keď prvý agent zapíše text priamo do
vstupu druhého, preruší jeho prebiehajúci beh alebo sa vmieša do toho, čo práve píše človek. Keď na odpoveď čaká
v slučke, ťah ostáva otvorený a každé ďalšie prečítanie kontextu platíš. A keď sa nedohodnete, kto na koho čaká,
jedna strana čaká zbytočne a druhá nevie, že ju niekto očakáva.

### Kedy to potrebuješ

Nepotrebuješ to, keď máš jedného agenta. Nepotrebuješ to ani vtedy, keď si agenti píšu komentármi v správcovi úloh
(kapitola 7) a to stačí, lebo komentár zobudí riešiteľa a úloha nesie stav.

Potrebuješ to pri dvoch a viac agentoch v trvalých reláciách, ktorí si posielajú pokyny a výsledky mimo úloh. Ide
o súrnu vec, ktorá nepočká na úlohu, o otázku, na ktorú odosielateľ stojí, a o odovzdanie stavu medzi strojmi.

Prečo súbory v adresári a nie fronta alebo databáza. Nepotrebuješ službu, ktorá môže padnúť, a nič sa neinštaluje.
Správu prečítaš príkazmi `ls` a `cat` a opravíš editorom. Premenovanie príkazom `mv` na jednom disku je atómové,
takže adresát nikdy neuvidí polovičný súbor. Súbor prežije reštart procesu aj stroja, správa vo fronte v pamäti nie.
Fronta alebo databáza sa oplatí pri stovkách správ za sekundu. U nás ide o desiatky až okolo sto správ denne
v schránke jedného agenta.

### Mechanizmus

Každý agent má schránku, adresár s podadresármi `inbox` a `processed`. Správa je súbor v `inbox` adresáta. Zápis ide
cez skrytý dočasný súbor a `mv`, aby adresát nikdy nečítal polovičný súbor. Meno súboru má tvar
`<odosielateľ>-[<téma>-]<RRRRMMDD-HHMMSS>-<pid>.md`.

Budič je program, ktorý správu zo schránky doručí do bežiacej relácie agenta a súbor presunie do `processed`. Beží
nepretržite vedľa agentov a model nevolá. Nikdy nepošle správu do bežiaceho behu. Správy, ktoré budia, pošle jednou
dávkou po krátkom tichom okne, takže správy tesne za sebou idú jedným ťahom.

Každá správa, ktorú budič pošle, je jeden ťah modelu a ten znova číta celý kontext. Meranie 19. 10. 2026 ukázalo, že
36 zo 69 ťahov nemalo akciu. Preto prvý riadok správy hovorí, čo odosielateľ od nej čaká (režim správy), a píšu ho
skripty, nie model.

| prvý riadok | znamená | budič adresáta | odpoveď na ňu |
|---|---|---|---|
| `odpoveď: čakám` | pokyn alebo otázka, odosielateľ stojí na odpovedi | zobudí | povinná, zobudí odosielateľa |
| `odpoveď: nečakám` | správa nástroja alebo súhrn, výsledok sa prečíta pri ďalšom ťahu | zobudí | ide bez budenia |
| `odpoveď: na vedomie` | hlásenie, výsledok, potvrdenie | nebudí, drží do ďalšej dávky | nepíše sa |

Správa `na vedomie` zobudí len ako odpoveď na správu, na ktorú odosielateľ čaká. Odpoveď `na vedomie` na správu
`čakám` preto odosielateľa zobudí, odpoveď `na vedomie` na správu `nečakám` nie.

Skript odoslania píše novú správu ako `čakám`, s voľbou `--vedomie` ako `na vedomie`, iný režim nemá. Skript odpovede
píše predvolene `na vedomie`, a keď niečo potrebuje späť, má `--cakam` alebo `--necakam`. Odpoveď `na vedomie` na
správu `nečakám` odosielateľa nezobudí, preto skript odoslania režim `nečakám` pri novej správe odmietne. Na správu
`na vedomie` sa neodpisuje a potvrdenie "prevzaté" sa neposiela. Práca, ktorá z nej vznikne, je nový pokyn.

Odpoveď sa páruje s pôvodnou správou podľa hlavičky `k:`, takže meno súboru môže byť ľubovoľné. Agent píše aj z vlákna
témy (vlákno je trvalá relácia agenta v jeho nástroji, vlákno témy je ďalšie vlákno toho istého agenta, ktoré vedie
jednu tému). Preto skript po zápise uloží trasu odpovede, teda kľúč správy a vlákno odosielateľa, a budič podľa nej
odpoveď doručí do vlákna témy, nie do hlavného.

Správa agentovi je pracovný príkaz. Pokyn nesie úlohu, kontext, ktorý adresát nemá, a podmienku hotového. Odpoveď nesie
výsledok, dôkaz (príkaz a jeho výstup) a čo je otvorené. Cesta, riadok alebo commit nahrádza kópiu. Neistota sa píše
slovom "neoverené". Bez pozdravov, poďakovaní, ospravedlnení a opakovania.

Prečo nie spoločná pamäť. Zástupcovia na rôznych strojoch si stav odovzdávajú schránkami, nie spoločnou pamäťou.
Správa v schránke má odosielateľa, adresáta, tému a očakávanú odpoveď. Zápis v spoločnej pamäti nič z toho nenesie,
a tak nikto nevie, kto má na ňom konať ani kto čaká.

### Ako to postaviť

Keď schránky nepotrebuješ (časť "Kedy to potrebuješ"), preskoč celú kapitolu. Inak postupuj v tomto poradí.

#### 1. Adresáre a práva

Pre každého agenta založ `<koreň>/<agent>/inbox` a `<koreň>/<agent>/processed`. Adresár `inbox` má právo `2770`
(setgid) a spoločnú skupinu, v ktorej sú agenti, ktorí do neho píšu, a používateľ budiča. Meno agenta je malé písmená,
číslice a podčiarkovník, najviac 31 znakov, začína písmenom. U nás je pri agentovi ešte `outbox` z čias, keď sa
odpovede čítali z neho. Ak stavíš nanovo, nepotrebuješ ho, odpoveď je obyčajná správa do `inbox` pôvodného
odosielateľa.

Agent na inom stroji nemá schránku na svojom disku. Schránka je na stroji, kde beží budič, a odosielateľ z druhého
stroja zapíše súbor cez `ssh` s rovnakým postupom (skrytý `.tmp`, potom `mv`).

#### 2. Formát správy

Hlavička sú riadky na začiatku súboru, potom text správy. Prvý riadok je vždy `odpoveď:`. Správa bez neho sa doručí
ako budiaca, aby sa dali doručiť aj ručne zapísané správy.

```
odpoveď: <čakám|nečakám|na vedomie>
k správe: <režim pôvodnej správy>      (len odpoveď, druhý riadok)
id: <meno súboru>
od: <odosielateľ>
komu: <adresát>
téma: <téma, pre hlavné vlákno prázdne>
k: <id pôvodnej správy>                (len odpoveď)
```

Riadok `id:` je meno súboru. Riadok `k správe:` skript odpovede opíše z prvého riadku pôvodnej správy a budič podľa
neho rozhodne, či má odpoveď `na vedomie` zobudiť. Budič hlavičku z textu pre model odstráni a dá ju do značky
(bod 5). Meno súboru musí zodpovedať vzoru `^[a-z][a-z0-9_]{0,30}-[A-Za-z0-9._-]{1,120}$`, budič ostatné súbory
v `inbox` preskočí. Preskočí aj súbory, ktorých meno začína bodkou alebo končí `.tmp`, to sú rozpísané zápisy.

Príklad správy:

```
odpoveď: čakám
id: agent_a-nasadenie-20261024-101500-4242.md
od: agent_a
komu: agent_b
téma: nasadenie

Úloha. Nasaď verziu 3 na testovací stroj.
Kontext. Verzia je v tagu v3. Databázu nemeň.
Hotovo, keď `curl -sI https://test.example/` vráti 200.
```

Príklad odpovede, ktorú agent B napíše po nasadení:

```
odpoveď: na vedomie
k správe: čakám
id: agent_a-nasadenie-20261024-101500-4242.md
od: agent_b
komu: agent_a
téma: nasadenie
k: agent_a-nasadenie-20261024-101500-4242.md

Hotovo. `curl -sI https://test.example/` vráti `HTTP/2 200`. Otvorené: nič.
```

#### 3. Skript odoslania

Použitie: `ask_agent.sh [--vedomie] [--k <id>] <adresát> <téma> < sprava.md`. Skript robí tieto kroky.

1. Overí, že adresát aj odosielateľ sú v tvare mena agenta a že `inbox` adresáta existuje. Inak skončí kódom 1
   a nič nezapíše. Odosielateľ je premenná prostredia s menom agenta.
2. Odmietne prázdnu správu.
3. Odmietne voľbu `--necakam` s hláškou, že na odpoveď čakáš a máš nechať predvolené, alebo že hlásenie bez odpovede
   je `--vedomie`. Dôvod je v tabuľke vyššie, odpoveď `na vedomie` na `nečakám` odosielateľa nezobudí a ten by čakal
   naprázdno.
4. Zostaví meno `<odosielateľ>-[<téma>-]<čas>-<pid>.md` a hlavičku. Režim je `čakám`, s `--vedomie` `na vedomie`.
5. Nastaví `umask 007`, zapíše `.<meno>.tmp`, nastaví mu skupinu `inboxu`, keď ju adresár nededí, a urobí `mv` na
   konečné meno.
6. Zapíše trasu (bod 6) a vypíše id správy.

Voliteľne skript pri novej správe overí, že téma je v zozname tém adresáta (súbor vedľa jeho `inbox`), a pri neznámej
téme vypíše platné témy a nič nepošle. Na začiatok to nepotrebuješ.

#### 4. Skript odpovede

Použitie: `reply.sh [--cakam|--necakam|--vedomie] <id správy> < odpoved.md`. Agent ho volá príkazom, ktorý mu budič
vypíše v značke správy.

1. Overí tvar id a odmietne prázdnu odpoveď.
2. Predvolený režim je `na vedomie`. Keď telo odpovede obsahuje riadok začínajúci `Úloha`, `Otázka` alebo `Hotovo:`,
   a režim nie je zvolený výslovne, skript odmietne zápis. Takéto telo je pokyn, odpoveď `na vedomie` by nezobudila
   nikoho.
3. Nájde pôvodnú správu v `processed` (budič ju tam už presunul), vezme jej prvý riadok pre `k správe:` a tému.
4. Zostaví hlavičku s `k: <id pôvodnej správy>`, `od:` je odpovedajúci agent, `komu:` odosielateľ pôvodnej správy.
5. Zapíše súbor do `inbox` odosielateľa pôvodnej správy rovnako ako skript odoslania (`.tmp`, `mv`), pod menom
   `<od>-[<téma>-]<čas>-<pid>.md`. U nás má odpoveď meno z predpôn oboch strán a jadra pôvodného mena. Pre tvoju stavbu
   to netreba, odpoveď páruje `k:`.
6. Zapíše trasu (bod 6).

#### 5. Čo musí vedieť tvoj runtime, a ako to robíme my

Budič potrebuje dve veci. Musí vedieť, či agent vo vlákne práve pracuje, a musí vedieť poslať text do jeho relácie tak,
aby neprerušil prebiehajúci beh. Ak tvoj nástroj nič také nevie, stačí, aby agent pozrel `inbox` na začiatku každého
ťahu, ale potom správa agenta nezobudí. Takú podobu sme neskúšali.

U nás agenti bežia ako trvalé vlákna v T3 Code a budič robí toto.

1. Stav vlákna číta z HTTP zoznamu vlákien servera. Riadok vlákna nesie id aktívneho behu, stav behu, príznak
   čakania na schválenie a stav vlákna. Vlákno je zaneprázdnené, keď má aktívny beh, keď čaká na schválenie
   človekom, keď jeho stav nie je koncový (nečinné vlákno, dokončený, prerušený, zlyhaný alebo zrušený beh) alebo keď
   skončilo chybou limitu predplatného a čas obnovy ešte nenastal.
2. Text pošle príkazom `message.dispatch` cez WebSocket. T3 Code 0.1.0 nemá HTTP volanie na správu do vlákna, budič
   preto vyžiada jednorazový lístok, otvorí WebSocket a pošle príkaz. Príkaz nesie režim doručenia
   `queue_after_active`, teda zaradiť za aktívny beh. Keby medzi čítaním stavu a odoslaním začal beh (napríklad
   človek napísal do vlákna), správa sa zaradí za neho a nič neprerušuje.
3. Príkaz nesie aj `commandId`, ktoré budič odvodí z mien súborov dávky, čísla pokusu a náhodného id dávky. Server si
   pamätá príjem každého `commandId`, takže opakovanie po páde budiča nevytvorí druhú správu.
4. Záložne sa dá text poslať do klienta CLI v `tmux` príkazom `tmux send-keys -l` a Enterom ako samostatným
   krokom. `tmux` nepozná stav behu a nevie, či agent práve nepíše, preto je to len záloha.

Pre tvoj runtime to znamená dve požiadavky. Potrebuješ spôsob, ako zistiť, že relácia práve nepracuje, a spôsob, ako do
nej vložiť vstup tak, aby sa zaradil za prebiehajúcu prácu, alebo aspoň tak, aby budič počkal na jej koniec. Ak runtime
nemá idempotentné príkazy ako `commandId`, pád medzi odoslaním a presunom súboru môže správu doručiť dvakrát.
Presun do `processed` preto rob hneď po úspešnom odoslaní.

#### 6. Budič

Budič je slučka. Jeden priechod robí toto.

1. Prečíta `inbox` (súbory s platným menom, bez bodky na začiatku a bez `.tmp`) a zoradí ich podľa času zmeny.
   Prázdny `inbox` ukončí priechod.
2. Pre každú správu zistí cieľové vlákno a či budí. Správa s `odpoveď: čakám` alebo `nečakám` a správa bez riadku budia.
   Správa `na vedomie` budí, len keď má `k:` na správu, ktorú odosielateľ poslal ako `čakám`, alebo riadok
   `k správe: čakám`. Inak sa drží.
3. Cieľové vlákno je vlákno z trasy odpovede (bod 7). Správa bez `k:` alebo bez trasy ide do hlavného vlákna agenta.
4. Tiché okno. Dávka pre vlákno odíde, keď od poslednej budiacej správy uplynulo `AGENT_BATCH_WAIT_S` (u nás 30 s),
   alebo od prvej budiacej správy uplynulo `AGENT_BATCH_MAX_WAIT_S` (120 s). Dávka je všetko, čo budí, a odíde jednou
   správou, takže správy tesne za sebou spotrebujú jeden ťah. Hodnota `0` okno vypne.
5. Skontroluje, či vlákno pracuje (bod 5). Ak áno, nepošle nič a skúsi to o ďalší interval.
6. Zostaví text dávky. Najviac 20 budiacich správ, každá do 100 kB, a najviac 10 držaných správ `na vedomie`, každá do
   4 kB, pod nadpisom "Na vedomie". Každá správa je v značke:

   ```
   <schranka od="agent_a" tema="nasadenie" id="agent_a-nasadenie-20261024-101500-4242.md" odpoveď="čakám">
   odpoveď: reply.sh <id> <<'EOF' ... EOF (odosielateľ na ňu čaká)

   Úloha. Nasaď verziu 3 na testovací stroj.
   </schranka>
   ```

   Pre správy `na vedomie` je riadok odpovede "odpoveď sa nepíše".
7. Zapíše dávku do súboru stavu (zoznam súborov, číslo pokusu, id dávky), pošle ju a po prijatí presunie súbory do
   `processed`. Ak tam súbor s rovnakým menom je, pripíše k menu čas. Potom stav zmaže. Ak server dávku odmietne,
   zvýši číslo pokusu, aby sa nezopakovalo odmietnuté `commandId`.
8. Spí `POLL_S` (u nás 5 s). Pri chybe spojenia čaká dvakrát dlhšie, najviac 300 s.

Držaná správa `na vedomie` ostáva v `inbox`, nič sa nemaže. Odíde pod nadpisom s najbližšou budiacou dávkou do toho
istého vlákna. Správu `na vedomie` staršiu než 24 hodín presunie ranný súhrn do `processed` a vypíše.

#### 7. Trasa odpovede

Trasa rieši problém, že agent píše z vlákna témy a odpoveď má prísť späť tam, nie do hlavného vlákna.

1. Pri zápise správy (a pri odpovedi) skript zistí vlákno, z ktorého agent píše. Použije id relácie, ktoré má proces
   agenta v prostredí (u nás `CLAUDE_CODE_SESSION_ID`) a ktoré nástroj uvádza pri vlákne. Po čistom kontexte má proces
   novú reláciu, preto sa id hľadá aj v argumente `--resume` príkazového riadku procesu.
2. Ak vlákno nie je hlavné, zapíše do súboru `routes.json` v stave budiča záznam s kľúčom správy (meno bez predpôn
   oboch strán), druhou stranou a vláknom. Záznam starší ako 30 dní vypadne. Pre hlavné vlákno sa záznam nezapíše
   a starší s tým istým kľúčom sa zmaže.
3. Budič pri správe s `k:` nájde záznam podľa `k:`. Ak vlákno existuje a nie je archivované, správa ide tam. Inak ide
   do hlavného vlákna s riadkom `[budič] Správa patrí vláknu <id>, to je archivované, preto je tu.`.
4. Ak vlákno nenájde skript, správa odíde bez trasy a odpoveď príde do hlavného vlákna. Skript to vypíše.

Naša verzia vie navyše doručiť novú správu k téme do vlákna témy podľa zoznamu tém. Na začiatok to nepotrebuješ.

#### 8. Pravidlá pre agenta a hook

Napíš pravidlo, že agent po odoslaní správy `čakám` ukončí ťah a na odpoveď nečaká, budič mu ju doručí. Doplň hook
PreToolUse, ktorý zamietne príkaz so `sleep` nad desať sekúnd alebo slučku so `sleep` v popredí. Zamietnutie nesie
riadok "Správny postup:" (kapitola 6).

### Náš príklad

Pravidlá schránok sú v `env/server/CLAUDE.md`, časť "Schránky a budič". Skript odoslania, skript odpovede, budič
a trasy sú v našom runtime, ktorý v tomto repe nie je. Žije v repe `https://github.com/gavalierm/agent-runtime` (verejné, D0171). Kapitola ho aj tak opisuje tak, aby si nebol na odkaze závislý.
Skripty opisuje aj tabuľka "Čo v repe nie je" v `README.md`, vrátane toho, čo z nich potrebuješ na stavbu. Ide o
`bin/ask_agent.sh` (skript odoslania, test `hooks/ask_agent.test.mjs`), `runtime/reply.sh` (skript odpovede),
`runtime/driver.mjs` (budič), `runtime/route.mjs` (trasy odpovedí a zoznam tém) a `runtime/README.md` (opis runtime,
časť "Budenie"). Hook proti čakaniu `hooks/no_model_wait.mjs` v repe nie je. Pravidlá pre správy agentom sú
v `global/CLAUDE.md`, §2.

## 9. Delegovanie

### Problém

Silný model, ktorý robí všetko sám, je drahý a pomalý. Lacnejší model bez dohľadu urobí chybu, ktorú nikto nezachytí.
Úloha zadaná krok po kroku viaže zadávateľa na každý detail. A práca, ktorú robí niekto, kto na ňu nemá práva, rozbíja
hranice jurisdikcie.

### Kedy to potrebuješ

Potrebuješ to, keď máš aspoň dvoch agentov s rôznymi právami (jeden má root, druhý nie) alebo keď platíš za modely
rôznych cien a chceš na každú prácu primeraný. Potrebuješ to aj vtedy, keď silná relácia míňa tokeny na
mechanickú stavbu, ktorú by zvládol lacnejší model.

Nepotrebuješ to pri jednom agentovi a jednom modeli. Vtedy delegovanie nemá komu. Ani to nepotrebuješ pri práci,
ktorú dokončíš za pár volaní. Zadanie sub-agentovi stojí napísanie zadania a čítanie výsledku, čo sa pri malej práci
nevyplatí.

### Mechanizmus

Prácu robí najnižšia úroveň, ktorá na ňu má práva. Silnejší model navrhuje a overuje, lacnejší stavia. Relácia na
najsilnejšom modeli dá implementáciu sub-agentovi na lacnejšom modeli a sama si nechá návrh a overenie. Silnejší
sub-agent ide len na návrh, audit alebo prácu, ktorá s lacnejším zlyhala, a dôvod sa napíše. Sub-agent je druhá relácia,
ktorú hlavná relácia spustí na jednu dielčiu prácu. Vráti hlavnej relácii len výsledok, nie celý svoj rozhovor, takže
hlavný kontext ostane malý.

Pred každou úlohou pre agenta správca agentov postupuje v piatich krokoch.

1. Určí, aké práva úloha potrebuje, napríklad čítanie, zápis vo vlastnom repe, root, citlivý úkon alebo rozhodnutie.
2. Vyberie najnižšieho agenta, ktorému to persona dáva.
3. Pozrie otvorené úlohy vybraného agenta. Pri preťaženom úlohu rozdelí alebo zadá cez jeho nadriadeného.
4. V zadaní napíše, prečo patrí práve jemu.
5. Čakanie na vonkajší stav zadá skriptu bez modelu, ktorý agenta zobudí až pri zmene.

Zadanie hovorí cieľ a podmienku hotového, nie kroky. Medzistav agent nekontroluje, overí výsledok. Správca agentov
hotovú prácu overí sám a nespolieha sa na správu agenta. Prístup, ktorý má len správca (token, účet), nie je dôvod
robiť prácu agenta, správca vydá agentovi úzky prístup a prácu zadá jemu. Rýchlosť tiež nie je dôvod. Zakázané sú vety
"zadal som to správcovi servera" pri úlohe bez rootu a "urobil som to sám, bolo to rýchlejšie".

Úloha nesie číslo, aby bolo vidno, kto na nej pracuje. Zadanie sub-agentovi obsahuje text "úloha N". Hook pred
spustením nástroja na sub-agenta (PreToolUse pre nástroje Agent a Task) číslo nájde a ohlási správcovi úloh, že na
úlohe niekto pracuje. Po skončení sub-agenta (SubagentStop) záznam ukončí. Bez čísla v zadaní vyzerá úloha ako stojaca.
Pred zadaním úlohy sub-agentovi agent pozrie posledné záznamy práce na úlohe, aby ju nerobili dvaja naraz.

### Ako to postaviť

1. Do globálnych pravidiel napíš, ktorý model robí návrh a overenie, ktorý stavbu a kedy sa smie ísť vyššie. Pri
   Claude Code zvolíš model sub-agenta v zadaní nástroja Agent parametrom `model`.
2. Do roly správcu agentov napíš päť krokov výberu agenta a dve zakázané vety.
3. Do prostredia napíš, že zadanie sub-agentovi nesie "úloha N", a napíš hook, ktorý číslo nájde. Hook robí toto.
   1. V PreToolUse pre nástroj `Agent` (a starý názov `Task`) nájde v `tool_input.prompt` regulárnym výrazom číslo za
      slovom "úloha".
   2. Ohlási prácu príkazom správcu úloh a uloží si zhodu `tool_use_id` a čísla úlohy do súboru stavu relácie.
   3. V SubagentStop sub-agenta nevidí zadanie, preto záznam nájde cez uložený súbor. Keď v relácii nezostal iný
      sub-agent s tou istou úlohou, ukončí záznam práce.
   4. Pri chybe alebo bez čísla mlčí s kódom 0 a nikdy nezablokuje nástroj.
4. Napíš šablónu zadania s cieľom, kontextom, ktorý adresát nemá, a podmienkou hotového. Prvý riadok vyzerá `Úloha 120.
   Premenuj premennú X na Y v skriptoch v bin/. Hotovo, keď grep na X je prázdny.`
5. Z postupu zadaného druhýkrát ručne sprav skill so skriptom. Skill je súbor s popisom, kedy ho použiť, a skript
   urobí každý krok, ktorý nepotrebuje úsudok.

### Čo od runtime vyžaduje

- Spustenie sub-agenta z relácie s voľbou modelu. Claude Code to dáva nástrojom Agent s parametrom `model`.
- Hook pred spustením tohto nástroja a hook po skončení sub-agenta, ktorých vstup nesie zadanie a id.
- Správca úloh (kapitola 7), do ktorého vieš zapísať, že na úlohe niekto pracuje. Bez neho je číslo úlohy v zadaní
  len zvyk.
- Pre rozdelenie práv stroje alebo používatelia, ktorých právo sa dá oddeliť (root a ostatní), a persona, ktorá hranice
  jurisdikcie opisuje.

### Náš príklad

Pravidlo modelov a odovzdania práce je v `global/CLAUDE.md`, §6. Delegovanie je v `roles/spravca-agentov.md`, časť
"Delegovanie", pokyny agentom v časti "Pokyny agentom a oprava". Hook [hooks/tasker_work.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/tasker_work.mjs) s testom
[test/tasker_work.test.mjs](https://github.com/gavalierm/agent-runtime/blob/main/test/tasker_work.test.mjs) ukazuje, ako sa číslo úlohy nájde v zadaní. Skilly pre opakované postupy sú v `skills/`.
Náš `skills/projekt-novy` (založenie projektu webu) v repe nie je, je viazaný na naše účty a domény.

## 10. Písanie

### Problém

Text modelu má rozpoznateľné vzory. Dlhé odpovede s úvodom, zhrnutím, ponukami práce, vatou a tučnými štítkami sa
nečítajú. Operátor v nich nenájde, čo potrebuje, a prestane ich čítať. Pravidlo "píš stručne" bez kontroly sa zabúda.

Druhý problém je odkaz, ktorý nefunguje. Agent pošle operátorovi adresu stránky, ktorá ešte nebeží, alebo adresu
`localhost`, ktorú operátor na svojom zariadení neotvorí.

### Kedy to potrebuješ

Potrebuješ to, keď čítaš odpovede agentov každý deň a unavujú ťa. Potrebuješ to aj vtedy, keď agenti píšu texty, ktoré
čítajú iní ľudia (dokumenty, commit správy, komentáre).

Nepotrebuješ to pri agentovi, ktorý píše len kód a krátke stavy. Vtedy stačí pravidlo o dĺžke v globálnych pravidlách.
Hook so stropom pridaj, až keď agent pravidlo poruší aspoň dvakrát.

### Mechanizmus

Pravidlá písania majú jeden zdroj, skill `unslop`. Platí pre každý text určený človeku, teda pre odpovede, dokumenty,
commit správy, komentáre v kóde aj záznamy rozhodnutí. Správa inému agentovi sa riadi pravidlami správ (kapitola 8),
nie pravidlami čitateľnosti. Operátor radí `unslop` nad ostatné skilly.

Jadro skillu je jeden odsek. Krátke celé vety so slovesom, činný rod, obyčajné slová, konkrétne mená, čísla a
mechanizmy namiesto dojmov. Bez pomlčiek, typografických úvodzoviek, emoji a tučných štítkov s dvojbodkou. Bez výplne
a nafúknutých slov, bez nútených trojíc a bez chatbotových fráz. Pred odovzdaním sa agent opýta, čo na texte
prezrádza AI, a opraví to. Zvyšok skillu je katalóg vzorov s pevnými číslami pravidiel, aby sa iné skilly mohli na
pravidlo odvolať číslom.

Hook SessionStart vloží do kontextu len jadro, pri štarte, po `/clear`, pri obnovení aj po kompakcii. Celý katalóg by
stál tisíce tokenov pri každom štarte, jadro stojí pár stoviek. Claude Code vloží z jedného hooku najviac 10 000 znakov.
Dlhšie jadro, než povolí limit vloženého kontextu, hook ohlási a skončí s kódom 1, takže kontrola repa to zachytí pred
nasadením. Prvá odpoveď relácie ohlási riadok `unslop: načítané, hook, verzia <verzia>`, aby operátor videl, že jadro
prišlo. Verzia je prvých osem znakov kontrolného súčtu súboru skillu, ktorý operátor porovná príkazom
`shasum -a 256`.

Dĺžka odpovede má strop. Odpoveď operátorovi má jednu až tri vety, a to verdikt, dôvod a čo robiť. Dlhšia je len
vtedy, keď o kroky, podrobnosti alebo dokument operátor požiada. Hook na konci odpovede (Stop) odpoveď zastaví, keď má
viac ako šesť viet prózy, vetu nad 35 slov, položku zoznamu s viac vetami, odkaz, ktorý dnes neodpovedá, alebo odkaz na
localhost. Bloky kódu, tabuľky, nadpisy a riadky "Čaká na teba:" sa do prózy nepočítajú. Prvý riadok odpovede agenta s
personou je len jeho meno a dvojbodka, druhý je prázdny.

Podrobnosti idú do súboru. Súbor pre operátora (stránku, dokument) agent uloží do pracovného priečinka mimo dočasného
adresára, napríklad `docs/`, a v odpovedi uvedie jeho cestu. Runtime z cesty urobí odkaz, ktorý operátor otvorí.
Zakázaná veta je "súbor je na serveri, neotvoríš ho".

Plán sa dáva na schválenie len s overenými tvrdeniami. Hook Stop zastaví odpoveď, ktorá ponúka plán a overenie odkladá
na nasadenie.

### Ako to postaviť

1. Napíš skill `skills/unslop/SKILL.md` s jadrom na začiatku. Súbor začína hlavičkou s `name` a `description`, potom
   nadpis `## Jadro` a pod ním odsek jadra. Zakázané vzory opíš konkrétne a daj príklady v jazyku, v ktorom píšeš.
2. Napíš hook SessionStart, ktorý vloží len sekciu "Jadro". Hook robí toto.
   1. Prečíta `SKILL.md` a vytiahne text medzi nadpisom `## Jadro` a ďalším nadpisom `## `.
   2. Spočíta kontrolný súčet súboru a vezme prvých osem znakov ako verziu.
   3. Vypíše jadro a riadok o verzii na štandardný výstup. Pri SessionStart sa výstup pridá do kontextu.
   4. Ak je text dlhší než 10 000 znakov, vypíše chybu na chybový výstup a skončí kódom 1.
3. Do globálnych pravidiel napíš sekciu o písaní s odkazom na skill a stropom odpovede.
4. Napíš hook Stop so stropom viet a slov. Hook robí toto.
   1. Vezme poslednú odpoveď agenta z prepisu relácie.
   2. Odstráni bloky kódu, nadpisy, tabuľky a riadky, ktoré sa do prózy nepočítajú.
   3. Rozdelí zvyšok na vety a spočíta ich. Zastaví odpoveď, keď je viet viac než šesť alebo má veta viac než 35 slov.
   4. Nájde adresy `http` a `https`, pošle na každú dotaz `HEAD` a zastaví odpoveď, keď niektorá neodpovedá alebo je to
      `localhost`.
   5. Pri druhom zastavení v rade (`stop_hook_active`) mlčí.
   Začni jedným stropom a kontroly pridávaj, keď narazíš na ďalší problém.
5. Zaveď priečinok pre dokumenty operátora a pravidlo "odpoveď nesie cestu, nie obsah".

### Čo od runtime vyžaduje

- Hook pri štarte relácie, ktorého výstup sa vloží do kontextu aj po čistom kontexte, obnovení a kompakcii.
- Hook na konci odpovede, ktorý dostane text poslednej odpovede (u Claude Code cez prepis relácie) a môže ju zastaviť.
- Spôsob, ako sa súbor v pracovnom priečinku dostane k operátorovi, napríklad odkaz z cesty v rozhraní, ktoré používa.
  Ak ho runtime nemá, pošli súbor inou cestou a odpoveď zostane krátka.
- Sieť pre kontrolu odkazov. Kde ju nemáš, kontrolu odkazov vypni (u nás premenná `REPLY_GUARD_NO_NET=1`).

### Náš príklad

Skill je `skills/unslop/SKILL.md`, jadro je jeho sekcia "Jadro". Do kontextu ho vkladá `hooks/unslop.mjs`, ktorý v repe nie je,
píšeš si ho sám. Strop odpovede drží
[hooks/reply_guard.mjs](https://github.com/gavalierm/agent-runtime/blob/main/hooks/reply_guard.mjs) s testom [test/reply_guard.test.mjs](https://github.com/gavalierm/agent-runtime/blob/main/test/reply_guard.test.mjs). Pravidlá sú v `global/CLAUDE.md`, §2 a §5. Pravidlo
súborov pre operátora je v `env/server/CLAUDE.md`, časť "Schránky a budič". Schválené vzory opakovanej práce sú v
`artifacts/` a ich používanie opisuje `skills/artefakty/SKILL.md`. Ani jedno v repe nie je, sú to naše pracovné výstupy.

## 11. Čistý kontext a kontinuita

### Problém

Kontext relácie rastie a každé volanie modelu ho číta celý. Dlhá relácia je drahá a model v nej robí viac chýb.
Čistenie kontextu zasa zmaže všetko, čo agent vedel. Ak stav nie je zapísaný, agent po čistení pracuje naslepo alebo
sa pýta operátora na to, čo už bolo hotové.

### Kedy to potrebuješ

Potrebuješ to, keď relácie bežia hodiny a dni, keď platíš za každé čítanie kontextu a keď vidíš, že agent po dlhej práci
zabúda zadanie. Potrebuješ to aj vtedy, keď chceš, aby agent po čistení pokračoval bez operátora.

Nepotrebuješ to pri krátkych reláciách, ktoré skončia samy. Samotný zápis stavu do pamäte a gitu (prvá časť kapitoly)
potrebuješ vždy. Automatické čistenie podľa pokynu agenta (časť "Automatické čistenie") pridaj, až keď ťa prvé
ručné čistenie unaví. Do tej doby stačí, že operátor napíše `/clear` sám.

### Mechanizmus

Stav práce je v súboroch, nie v kontexte. Pamäť je v gite. Stav témy je úloha s komentármi a históriou v správcovi
úloh, nie súbor v gite. Do gitu idú len persona, pravidlá, rozhodnutia a kód. Nedokončená práca na konci ťahu ide do
pamäte, commitne sa a pushne. Zakázaná veta je "prinesiem to v ďalšej relácii".

Čistý kontext je nová relácia bez rozhovoru, ktorú agent začne z toho, čo je v súboroch. Robí sa po hotovom logickom
celku práce, nie uprostred úlohy. Postup má štyri kroky.

1. Agent zapíše stav do pamäte a úlohy.
2. Commitne a pushne.
3. Ukončí odpoveď riadkom, ktorý pozná program sledujúci relácie. Riadok vypíše skript odovzdávky.
4. Program pošle do toho istého vlákna príkaz `/clear` a model sa nevolá. Čistenie nestojí ťah modelu.

Odovzdávka je malý súbor, v ktorom agent odovzdá novej relácii súhrn stavu a prípadne ďalší krok. Skript odovzdávky
vypíše riadok `HOTOVO-KONTEXT <režim> <kľúč>`. Režim `spanok` len vyčistí kontext. Režim `pokracuj` po čistení pošle
agentovi ešte jednu správu s ďalším krokom a použije sa len vtedy, keď ďalší krok nečaká na nikoho. Kľúč je náhodný
reťazec, ktorý spája riadok s odovzdávkou, aby citát slova v bežnom texte nič nespustil.

Po čistení sa model nevolá. Štart relácie (fetch, rebase, stav) urobí hook. Hook prečíta odovzdávku, zmaže ju
a vloží do novej relácie ako text, takže model nečíta pamäť ani nerobí fetch, kým to práca nepotrebuje.

Skript odmietne čistenie (kód 1), keď úloha agenta čaká a agent na nej komentoval po vstupe do čakania. Agent najprv
zmení stav úlohy (uzavrie ju, obnoví ju alebo nastaví čakanie s novým dôvodom) a až potom spustí čistenie. Inak by
výsledok, na ktorý úloha čakala, zostal nespracovaný.

Hranicu kontextu stráži hook, ktorý beží pri každom prompte. Sčíta vstupné tokeny poslednej odpovede modelu a nad
hranicou 80 tisíc tokenov pridá do kontextu pokyn na čistý kontext. Pod hranicou mlčí.

Agent, ktorý beží na dvoch miestach (hlavné vlákno a behy úloh v inom klone), zdieľa pamäť, manuály a skilly cez git,
preto po ich zmene commit a push idú hneď. Čakanie na vonkajší stav robí skript, ktorý agenta zobudí až pri zmene, nie
opakovaná kontrola modelom.

### Ako to postaviť

#### Zápis stavu (vždy)

1. Do persony napíš sekciu "Kontinuita" s pravidlom štartu (fetch, rebase, commity ostatných agentov) a konca (stav do
   pamäte, commit, push).
2. Do pravidiel napíš, že čistenie ide po logickom celku a nie uprostred úlohy.

#### Hranica kontextu

3. Napíš hook UserPromptSubmit. Prepis relácie je súbor, ktorého cestu hook dostane vo vstupe (`transcript_path`),
   jeden JSON na riadok. Hook prejde riadky s poľom `usage`, z posledného zoberie `input_tokens`,
   `cache_read_input_tokens` a `cache_creation_input_tokens` a sčíta ich. Pod 80 000 mlčí. Nad hranicou vypíše
   pokyn na čistenie. Pokyn povie, kedy čistiť (po hotovom celku, nie uprostred úlohy) a aký riadok napísať.

#### Ručné čistenie (najjednoduchšia podoba)

4. Napíš skript odovzdávky. Použitie `kontext.sh spanok|pokracuj [--dalej "<krok>"] [--stav "<súhrn>"]`. Zapíše súbor
   `<priečinok stavu>/<id relácie>.json` s právami `600` (najprv do skrytého súboru, potom `mv`) s poľami `key`
   (osem náhodných bajtov v hexadecimálnom zápise), `rezim`, `dalej`, `stav`, `cwd` a `at`. Vypíše riadok
   `HOTOVO-KONTEXT <režim> <kľúč>`. Odmietne čistenie, keď úloha agenta čaká.
5. Napíš hook SessionStart, ktorý beží, keď `source` vo vstupe je `clear`. Hook robí toto.
   1. V `cwd` spustí `git fetch origin` a pri čistom strome `git rebase origin/main`. Nikdy `git pull` ani
      `git stash`. Chybu ohlási v texte a reláciu nezastaví.
   2. Prečíta odovzdávku podľa id relácie a zmaže ju.
   3. Vypíše stav, ďalší krok a výsledok fetchu a rebase, aby sa vložili do novej relácie.
6. Operátor napíše `/clear` po tom, čo agent vypíše riadok. Novú reláciu tak dostane s odovzdávkou.

#### Automatické čistenie

7. Napíš program, ktorý sleduje relácie agentov. Keď relácia dokončí odpoveď, prečíta jej posledný neprázdny riadok.
   Riadok je pokyn len vtedy, keď je to presne slovo `HOTOVO-KONTEXT`, prípadne s režimom `spanok` alebo `pokracuj`
   a s kľúčom z 8 až 64 hexadecimálnych znakov. Citát slova inde v texte nič nespustí.
8. Pri režime `pokracuj` program overí, že existuje nespotrebovaná odovzdávka s týmto kľúčom. Ak nie, správa sa ako
   `spanok` a ohlási výstrahu.
9. Program skontroluje, že relácia nepracuje, a pošle jej príkaz `/clear`. Tesne pred odoslaním ešte raz overí stav,
   lebo medzitým mohol začať nový beh. Pri `pokracuj` po čistení pošle jedinú správu s ďalším krokom a označí odovzdávku
   za použitú.
10. Zapíš si stav programu do súboru, aby pád medzi `/clear` a pokračovaním nezostal nedokončený. Správy majú
    identifikátor príkazu, takže opakovanie po páde nevytvorí druhé čistenie (kapitola 8).

### Čo od runtime vyžaduje

- Spôsob, ako relácii z programu poslať `/clear`. My ho posielame cez server T3 Code, ktorý agentov spúšťa a príkaz
  odovzdá ich relácii. Iný spôsob sme neskúšali. Ak ho tvoj runtime nemá, ostáva ručné čistenie.
- Spôsob, ako zistiť, že relácia nepracuje (kapitola 8, časť "Čo musí vedieť tvoj runtime").
- Hook pri štarte relácie, ktorý vie povedať, že štart je po čistení (u Claude Code pole `source` s hodnotou `clear`).
- Hook pri prompte, ktorý vidí prepis relácie a počet tokenov poslednej odpovede.
- Čistenie, ktoré naozaj zahodí starý rozhovor. Po prvom čistení to skús tak, že sa agenta spýtaš na fakt z predošlého
  rozhovoru a nezapísaný do pamäte. Ak ho vie, čistenie nefunguje, ako má.

U nás čistenie nefungovalo. T3 Code si pri vlákne drží id relácie z prvého štartu a každý ďalší proces spustí s
`--resume` na ňu. `/clear` to id nezmení a starý kontext sa vrátil. Hook `clear_bridge.mjs` preto pri `source` `clear`
nájde pôvodné id v príkaze rodičovského procesu, odloží starý prepis ako zálohu a na jeho miesto dá symbolický odkaz na
prepis novej relácie. Ďalší `--resume` tak načíta čistý kontext. U teba sa to môže správať inak, preto skúška vyššie.

### Náš príklad

Pravidlá čistého kontextu sú v `env/server/CLAUDE.md`, časť "Schránky a budič". Skript je `bin/kontext.sh`, jeho
logika `lib/kontext.mjs`. Hooky sú `hooks/context_warning.mjs` a `hooks/clear_bridge.mjs`. Súbory `bin/kontext.sh`,
`lib/kontext.mjs`, `hooks/clear_bridge.mjs` a budič sú viazané na náš runtime a v tomto repe nie sú. Rovnako
`hooks/context_warning.mjs`, ktorý volá `bin/kontext.sh`. Čo každý robí, je v tabuľke "Čo v repe nie je" v `README.md`.
Budič, sledovač ostatných vlákien a čistenie na slovo agenta sú v repe `https://github.com/gavalierm/agent-runtime` (verejné, D0171). Pravidlo nedokončenej práce je v `global/CLAUDE.md`, §6.
Časti "Kontinuita" a "Súbežnosť" ukazuje `PERSONA.md` v repe správcu agentov.

## 12. Ako začať u seba

### Poradie na prvý týždeň

Nestavaj všetko naraz. Každý krok má vlastnú hodnotu a ďalší na ňom stojí.

1. Prvý deň, jeden agent. Založ repo, `PERSONA.md`, súbor runtime s importom a `memory/MEMORY.md`. Napíš pravidlo
   štartu a konca relácie. Hotovo, keď nová relácia po čistom kontexte vie, kto je a čo sa včera robilo.
2. Druhý deň, globálne pravidlá. Napíš `global/CLAUDE.md` o objektivite, odpovediach, trvanlivosti, chybách a
   autonómii a linkni ho do `~/.claude/CLAUDE.md`. Začni pár odrážkami, nie šiestimi sekciami, a stav ich z chýb,
   ktoré ti agent už urobil. Hotovo, keď agent v novej relácii pravidlo dodrží.
3. Tretí deň, register rozhodnutí. Založ `rozhodnutia/`, schému, skript zápisu a kontrolu. Zapíš prvé tri
   rozhodnutia, ktoré si agentovi už raz povedal. Hotovo, keď sa na ne agent nepýta.
4. Štvrtý deň, slučka chyby. Napíš sekciu o chybách, `chyba.sh`, hook, ktorý uznanie chyby bez zápisu zastaví, a test.
   Hotovo, keď hook zastaví testovaciu odpoveď "máš pravdu" bez commitu.
5. Piaty deň, hooky so správnym postupom. Zaveď helper `deny` a hooky na dve chyby, ktoré sa ti opakovali. Hotovo, keď
   každé zamietnutie nesie riadok "Správny postup:".
6. Druhý týždeň, správca úloh a postup plán, stavba, kontrola. Až keď agent robí viac vecí naraz.
7. Druhý až tretí týždeň, roly a druhý agent. Až keď existuje práca, ktorú nemá robiť prvý agent.
8. Potom schránky a budič (kapitola 8). Až keď dvaja agenti potrebujú posielať výsledky.
9. Nakoniec automatické čistenie kontextu (kapitola 11, časť "Automatické čistenie"). Ručné čistenie so zápisom stavu
   do pamäte máš od prvého dňa.

### Čo odložiť

- Schránky a budič, kým nemáš aspoň dvoch agentov. Jeden agent s úlohami v správcovi úloh stačí.
- Roly nad dve, kým nemáš prácu, ktorá nepatrí žiadnej z nich.
- Ďalšie roly (dizajnér, vedúci vývoja, osobný asistent) a artefakty, kým pre ne nie je práca.

### Pred vlastným mechanizmom

Pred každým novým mechanizmom zisti, či to nástroj už nerobí. Nástroj, ktorý používaš, má dokumentáciu a niektoré
veci (zapojenie hookov, importy súborov, správu oprávnení) rieši sám. Vlastný inštalátor, pevná cesta k domovskému
priečinku a vlastný shell skript sú znaky, že si dokumentáciu neprečítal. Pravidlá a limity cudzej služby cituj len z
jej oficiálnej stránky prečítanej celej.

Dôvody v tomto playbooku vychádzajú z praxe na jednom serveri s jedným operátorom. Budič, obal pre správcu úloh a hook
`clear_bridge.mjs` sú viazané na náš runtime. Kapitoly 7, 8 a 11 opisujú ich stavbu tak, aby si ich postavil bez nášho
kódu. Náš kód je v repe `https://github.com/gavalierm/agent-runtime` (verejné, D0171). Zvyšok je prenosný hneď, teda persona v gite, register rozhodnutí, slučka chyby, hooky so správnym postupom
a úloha so stavmi.
