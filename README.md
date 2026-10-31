# Runtime agentov na serveri

Runtime je spoločný pre agentov v trvalom vlákne T3 Code (časť Viac agentov).
Nesie nastavenie z prostredia, schránku správ, budiča, dozor nad behom,
čistý kontext, most z Taskera a pomocné skripty. V príkladoch v tomto texte
sú vymyslené mená: agent `adam` (hlavný agent s budičom), `boris` (druhý
agent), `cyril` (agent na Macu), `tasker-svc` (používateľ behov úloh),
`host.example.ts.net` (adresa v tailnete).

Agent beží ako trvalé vlákno T3 Code servera pod rootom v klone
`/root/adam` (`t3code.service`, https port 8802 cez `tailscale serve`).
Správy od agentov, z Taskera a z časovača prichádzajú do schránky
`/var/lib/adam`, budič `agent-driver@<adam>.service` ich pošle do vlákna.
Operátor píše do vlákna priamo z T3 desktopu alebo mobilu.

| súbor | čo robí |
|---|---|
| `mac_wake.sh` | pri správe `odpoveď: čakám` do schránky agenta na Macu (`MAC_WAKE_AGENT`) zavolá webhook T3 na Macu, spúšťa `systemd/mac-wake.path` |
| `reply.sh` | agent ním odpovedá na správu zo schránky do `outbox`, odosielateľovi s kanálom aj do jeho schránky (odosielateľovi z `AGENT_INBOX_ONLY` len do jeho schránky), z vlákna témy zapíše trasu; hlavička nesie `k: <id pôvodnej>`; telo odmietne bez riadkov `Výsledok:`, `Dôkaz:` a `Otvorené:` |
| `route.mjs` | trasa odpovede: id správy (`k:`) -> vlákno odosielateľa v `routes.json`, budič podľa nej doručí odpoveď do vlákna témy; zoznam tém `topics.json` (`topic set`) |
| `driver.mjs` | budič: `inbox` do vlákna cez T3 (`message.dispatch`), nikdy do bežiaceho behu, spracované do `processed`; volá dozor a čistý kontext |
| `supervise.mjs` | dozor nad posledným behom vlákna a čistý kontext (`/clear` v tom istom vlákne) na slovo agenta |
| `stuck.mjs` | dozor visiacej požiadavky na schválenie vo vlákne T3: výstraha a správa do schránky iného agenta (časť Dozor) |
| `clear_watch.mjs` | čistý kontext (`/clear`) na slovo agenta vo všetkých ostatných vláknach T3 servera, beží v budiči jedného agenta |
| `tasker_events.mjs` | prechody úloh Taskera do `needs_human`, `failed` a `done` z tabuľky `events` (len čítanie) do schránky, úloha s projektom, ktorý je v zozname tém, ide do vlákna témy (`tasker-<téma>-...`), dávka viac ako `BURST` skutočne odosielaných prechodov ide jednou správou (`čakám`, keď v nej je `needs_human` alebo `failed`, inak `na vedomie`); most: úlohu agenta z `TASKER_EXTERNAL_AGENTS` a vlastníka mostu `TASKER_SELF` (predvolene `AGENT_NAME`, vlákno T3, v Taskeri `enabled=0`) pošle do `/var/lib/<agent>/inbox`, tému berie zo zoznamu tém schránky agenta, agenta s `enabled=1` (spúšťa ho dispečer) preskočí. Úloha bez riešiteľa, ktorú Tasker sám presunul `blocked` -> `unassigned` (actor `tasker`, všetky blokéry hotové), ide jej zakladateľovi (udalosť `created`, actor `human:<agent>`), ak je agent z mosta a nemá `enabled=1`, ako `nečakám` "je odblokovaná a nemá riešiteľa"; s riešiteľom sa správa ako každá úloha agenta (úloha 427, 23. 10. 2026). Úlohu vypnutého agenta bez mosta a komentár cudzieho človeka, ktorý nikoho nezobudí (koncová úloha, úloha bez riešiteľa), pošle vlastníkovi mostu do jeho schránky. Komentár operátora (`TASKER_OPERATORS`, mená cez dvojbodku, predvolene `operator`) na úlohe v `needs_human` (udalosti comment a status `needs_human` -> stav poradia toho istého aktéra) ide vlastníkovi mostu ako `čakám` "zapíš rozhodnutie" (úloha 402, U11); otázka, ktorú vlastník položil sám (`tasker ask`, status `needs_human` s detailom `ask`, actor `human:<vlastník>`), ho nebudí Po zápise správy o úlohe v `handoff` do schránky riešiteľa zapíše doručenie do Taskera (`tasker delivered`, úloha 496), poistka: udalosť `handoff_stale` z doctora pošle riešiteľovi správu znova a ohlási ju zakladateľovi a vlastníkovi mosta. |
| `morning.mjs` | ranný súhrn do schránky (s `--stdout` vypíše telo súhrnu bez hlavičky správy na stdout a do schránky nič nezapíše, presunie sa len držaná správa `na vedomie`, úloha 618, D0183): `tasker summary --since 24h`, držané správy, nové rozhodnutia, rozloženie práce a zásahy operátora za 24 h (udalosti a posuny poradia v Taskeri, komentáre agenta za operátora, správy operátora z webu v T3; úloha 605), stojace úlohy s príčinou a otvorené needs_human s vekom, prerušené behy (killed, cancelled) s udalosťami úlohy, neprázdne klony a správy iných agentov v processed (úloha 607, D0179), značka `[s <operátorom>]` pri hotovej úlohe, do ktorej operátor v okne písal (správa v T3 vo vlákne s číslom úlohy v názve, komentár v úlohe; úloha 653), pokyn na začiatku: report len z týchto dát |
| `start_agent.mjs` | založí projekt T3 nad klonom repa a vlákno agenta, id vlákna uloží do stavu |
| `lib.mjs` | nastavenie, schránka, klient T3 (REST na čítanie, `/ws` na príkazy) |
| `agent_vlakno.sh`, `github_repo.sh`, `github_repo_visibility.sh`, `github_foreign_repo.sh`, `github_device_login.sh` | zriadenie agenta (kľúč, repo, klony, schránka, budič, agent v Taskeri) |
| `browser.sh`, `browser/` | Chrome so sandboxom pod volajúcim (nie root) alebo pod iným používateľom (z roota) |
| `secret_drop.sh`, `secret_drop.mjs` | jednorazová stránka na odovzdanie tajomstva |
| `systemd/` | šablóna budiča `agent-driver@.service`, jednotky udalostí Taskera a ranného súhrnu, `tmpfiles.d` schránky a drop-in `t3code.service` |
| `test/` | `node --test 'test/*.test.mjs'`, falošný T3 server bez závislostí |
| `lib/public_check.mjs` | kontrola mien a adries pred commitom (`.githooks/pre-commit` súbory, `.githooks/commit-msg` meno autora a committera a správa, `--commit-msg`) a pushom (`.githooks/pre-push` commity), slúži aj repu playbooku |
| `hooks/` | hooky relácie claude (časť Hooky relácie): `identity`, `memory_context`, `no_operator_commands`, `objection_fix`, `own_rule_scope`, `reply_guard`, `rules_delta`, `tasker_work`, `todo_after_comment`, `done_related`, `idle_wake`, `topic_task`, testy v `test/<hook>.test.mjs` |
| `lib/agent_env.mjs`, `lib/agent_name.mjs`, `lib/deny.mjs`, `lib/tasker_read.mjs` | knižnice hookov: hodnoty z `runtime.env` agenta, meno a persona agenta (aj vo vlákne témy cez T3 a `topics.json`), zamietnutie s riadkom "Správny postup:" (D0141), čítanie úloh Taskera |
| `skills/error/scripts/error.sh`, `bin/rozhodni.sh` | zápis uznanej chyby do registra mozgu a zápis rozhodnutia, opis v časti Skripty a knižnice |
| `lib/rozhodnutia.mjs`, `lib/deny.sh`, `lib/deny_check.mjs`, `lib/session_id.mjs`, `lib/path_check.mjs`, `lib/paths.mjs`, `lib/paths.sh` | register rozhodnutí, zamietnutie pre shell, strážca zamietnutí, id relácie T3, kontrola odkazov na cesty, cesty ku klonu kódu a spoločného mozgu (`AGENT_WORKFLOW`, `AGENT_BRAIN_GLOBAL`) |

Node 22.13 alebo novší, bez npm závislostí.

## Cesty a nastavenie

- Schránka `/var/lib/adam/{inbox,outbox,processed}`, skupina `agent-inbox`,
  vedľa nej zoznam tém `/var/lib/adam/topics.json` (640, skupina
  `agent-inbox`, `AGENT_TOPICS_FILE` ho presunie).
  Meno správy `<odosielateľ>-[<téma>-]<YYYYMMDD-HHMMSS>-<pid>.md`,
  zápis cez skrytý `.<meno>.tmp` a `mv`.
- Stav `~/.local/state/adam/`: `thread_id`, `inflight.json` (dávka, ktorú
  budič posiela), `supervise.json` (dozor aktuálneho vlákna),
  `rotation.json` (rozbehnutý čistý kontext), `retired_threads` (vlákna
  nahradené novým vláknom), `clear_watch.json` (sledovač ostatných
  vlákien), `alerts.log`
  (výstrahy budiča), `tasker_events_last_id`, `tasker_bridge_last_id` (kurzor mosta), `routes.json` (trasy odpovedí do vlákien tém).
- `~/.config/adam/runtime.env` (600), čítajú ho služby aj `reply.sh`:
  `T3_URL`, `T3_TOKEN_FILE`, `AGENT_MODEL`, voliteľne `AGENT_WORKDIR`
  (`~/agenti/adam`), `AGENT_T3_INSTANCE` (`claudeAgent`),
  `AGENT_RUNTIME_MODE` (predvolene `auto`, agenti na serveri bežia vo
  `full-access`), `TASKER_HOME` (`~/.tasker`), `TASKER_DB`
  (`$TASKER_HOME/tasker.db`), `TASKER_BIN` (`/opt/tasker/bin/tasker`),
  `AGENT_REPLY_ROUTE_<odosielateľ>=<priečinok>`.
  Všetky premenné sú v časti Premenné prostredia. Dozor a čistý kontext
  nastavujú premenné v tabuľke v časti Dozor.
- Token T3 `~/.config/adam/t3_token` (600), scopes `orchestration:read`
  a `operate`. Do repa nikdy.

## Ako budič posiela

T3 v0.1.0 nemá REST na správu do vlákna. Budič číta stav cez
`GET /api/orchestration/shell` a píše cez `/ws` s lístkom z
`POST /api/auth/websocket-ticket`: `orchestration.dispatchCommand`
s `message.dispatch` (zdroj `packages/contracts/src/orchestrationV2.ts`).
Keď vo vlákne beží beh, čaká schválenie alebo trvá limit predplatného,
budič nepošle nič a skúsi to o 5 s. Čakajúce správy potom pošle jednou
dávkou s `dispatchMode queue_after_active`, takže ani beh, ktorý začne
medzi čítaním a zápisom, nepreruší. `commandId` je odvodené z mien súborov,
čísla pokusu a náhodného id dávky v `inflight.json`. T3 si pamätá príjem
každého `commandId`, opakovanie po páde preto nevytvorí druhú správu
a nová správa s menom už doručenej správy dostane nové `commandId`.

## Budenie

Každá správa, ktorú budič pošle, je jeden ťah modelu. 19. 10. 2026 bolo
36 zo 69 ťahov bez akcie (rozhodnutie z 19. 10. 2026). Prvý riadok súboru správy
preto nesie, čo odosielateľ od nej čaká. Riadok píšu skripty, nie model.
Budič ho z textu pre model odstráni a dá do značky `odpoveď="..."`.

| prvý riadok | znamená | budič adresáta | odpoveď na ňu |
|---|---|---|---|
| `odpoveď: čakám` | pokyn alebo otázka, autor na odpovedi stojí | zobudí | budič autora zobudí |
| `odpoveď: nečakám` | len `reply.sh --necakam`, most Taskera a ranný súhrn, výsledok autor prečíta pri ďalšom ťahu | zobudí | ide bez budenia |
| `odpoveď: na vedomie` | hlásenie, výsledok, potvrdenie | nebudí, ide s ďalšou dávkou, po behu vlákna alebo po lehote | nepíše sa |
| bez riadku | staré skripty, ručný zápis | zobudí | ako doteraz |

| skript | predvolene | prepínače |
|---|---|---|
| `ask_agent.sh` (repo pravidiel, server aj Mac) | `čakám` | `--vedomie` (`--necakam` skript odmietne) |
| `reply.sh` | `na vedomie` | `--cakam`, `--necakam` |
| `tasker_events.mjs`, úloha čaká na človeka alebo zlyhala | `čakám` | bez voľby |
| `tasker_events.mjs`, most úlohy agentovi | `nečakám` | bez voľby |
| `tasker_events.mjs`, úloha založená agentom je `done` | `na vedomie` | bez voľby |
| `morning.mjs` | `nečakám` | bez voľby |
| `env/server/sync.sh` (pravidlá) | `na vedomie` | bez voľby |

Hlavička správy (píše ju `bin/ask_agent.sh` a `reply.sh`, budič ju z textu
pre model odstráni): `odpoveď:` (režim), pri odpovedi `k správe:` (režim
pôvodnej správy, nezamieňať s `k:`), potom `id:` (meno súboru), `od:`,
`komu:`, `téma:` a pri odpovedi `k:` (id pôvodnej správy). Odpoveď s `k:` sa
páruje len podľa neho (`routeFor`, `waitingFor` v `route.mjs`), meno súboru
môže byť ľubovoľné, takže odpoveď z Macu s novým menom nájde vlákno a budí,
keď agent čaká. Heuristiky z mena (kľúč bez predpôn, téma, 24 h) platia len
pre správy bez `k:`, zmaž ich po prechode Macu na hlavičky.

Rozhodnutie budiča pre správu `na vedomie`: zobudí, len keď agent na
odpoveď k jej kľúču čaká. Kľúč je ten istý ako pri trase (meno bez
predpôn oboch strán), `ask_agent.sh` a `reply.sh` ho cez `route.mjs
remember --mode` zapíšu do `routes.json` pod `sent`. Vlastná odpoveď na
kľúč záznam prepíše: odpoveď `na vedomie` kľúč zavrie, `--cakam` ho
znova otvorí. Nová správa `na vedomie` bez vlastného záznamu zobudí aj
vtedy, keď má tú istú tému ako odoslaná správa s `čakám` mladšia než
24 h (Mac odpovedá novou správou, nie odpoveďou). Bez záznamu rozhodne druhý riadok odpovede `k správe:
<hodnota pôvodnej správy>`, ktorý `reply.sh` opíše z `processed`. Bez
oboch sa správa drží.

Držaná správa ostáva v `inbox`, kým nejde. Ide pod nadpisom
"Na vedomie, N správ bez budenia" (najviac 10 správ, každá do 4 000 B,
zvyšok s cestou do `processed`) a to dvoma cestami (úloha 518):

1. S najbližšou budiacou dávkou do toho istého vlákna.
2. Sama ako dávka len z držaných správ, keď je vlákno voľné a platí
   jedno z dvoch. Vlákno je teplé: jeho posledný beh skončil najviac
   `AGENT_HELD_WARM_S` (10 min) dozadu a nebol to `/clear`, kontext je
   v cache a volanie modelu je lacné. `/clear` je vlastný beh vlákna
   (jeho `userMessageId` nesie text `/clear`), po ňom je kontext prázdny
   a samostatná správa by ho drahým ťahom znova naplnila (úloha 559),
   takže vlákno po `/clear` teplé nie je. Budič to zistí z detailu vlákna,
   len pre skupinu, ktorá by inak odišla ako teplá. Čas berie budič z poľa `latestRunCompletedAt` riadku
   vlákna v `/api/orchestration/shell`, `null` alebo neplatný čas nie je
   teplé. Alebo lehota: najstaršia držaná správa skupiny čaká dlhšie než
   `AGENT_HELD_MAX_S` (24 h, D0176).

Budiaca skupina má prednosť pred skupinou len z držaných správ, držaná
dávka tak budiacu nezdrží. Držané správy vlákna témy idú do vlákna témy.
Ranný súhrn je `nečakám`, držané správy hlavného vlákna idú s ním, ak ich
nedoručila niektorá z ciest vyššie. Ranný súhrn je hlavná cesta držanej
správy (D0176): `morning.mjs` pri behu presunie každú správu `na vedomie`
zo schránky agenta do `processed`, bez ohľadu na jej vek, a súhrn nesie
časť "Držané správy na vedomie, presunuté do processed" (agent,
odosielateľ, téma, prvý riadok, nová cesta). Budič ju pošle sám až po
24 h, teda keď ranný súhrn neprebehol. Bez takej správy časť v súhrne nie je.
Vlákna tém sa tým nebudia.
Schránky na odnos: `AGENT_SWEEP_BOXES` (zoznam cez dvojbodku), inak
vlastná schránka a priečinky z `AGENT_REPLY_ROUTE_<meno>`
(`AGENT_REPLY_ROUTE_<meno>`), na serveri adam a boris. Journal: `držím N na vedomie`, pri odoslaní `poslané N (M na
vedomie)`. Na správu `na vedomie` sa neodpovedá, potvrdenie "prevzaté"
sa neposiela, práca z nej je nový pokyn `ask_agent.sh`.

Správa Taskera ("Tasker: úloha #N"), na ktorej úlohe agent po zápise správy
sám zapísal nečinnú (`quiet 0`) udalosť svojho aktéra `human:<agent>`
(budič číta `events` v `taskerDb` len na čítanie), nebudí a ide na vedomie
ako držaná správa (časť vyššie). Chýbajúca alebo
nečitateľná databáza správanie nemení, správa budí. Chyba 24. 10. 2026,
úloha 499: agent komentár operátora prečítal sám a budič ho o minútu zobudil
tou istou správou.

Dávka s budiacou správou odíde až po tichom okne `AGENT_BATCH_WAIT_S`
(30 s) od poslednej budiacej správy, najviac `AGENT_BATCH_MAX_WAIT_S`
(120 s) od prvej, správy tesne za sebou tak idú jedným ťahom. `0` okno
vypne. Zábrany v `reply.sh`: telo s riadkom `Úloha` alebo `Otázka`
bez `--cakam` alebo `--necakam` odmietne. Riadok `Hotovo:` je výsledok
a tú zábranu prejde. Telo každej odpovede (aj `--cakam`, `--necakam`,
`--vedomie` a `Hotovo:`) musí navyše niesť tri riadky, ktoré začínajú
`Výsledok:`, `Dôkaz:` a `Otvorené:` (v ľubovoľnom poradí, za dvojbodkou
neprázdny text, `Otvorené: nič`, keď nič neostalo). Bez ktoréhokoľvek
skript skončí kódom 1 a na stderr dá riadok `Správny postup:` s príkladom.
Odpoveď tak nesie výsledok, dôkaz ako príkaz s výstupom a čo je otvorené.

### Ktorou cestou ide správa

| od koho, komu | cesta | odpoveď |
|---|---|---|
| hlavné vlákno agenta, iné vlákno T3 na tom istom serveri | nástroj `t3_thread_send` s `mode: queue`, správa nesie `senderThreadId` (overené 26. 10. 2026, audit T3 v repe agenta správcu agentov, `docs/t3-audit/audit.md`) | odpoveď príde ako ďalší beh odosielajúceho vlákna |
| agent servera, agent iného stroja alebo používateľa | schránka `/var/lib/<meno>/inbox` cez `ask_agent.sh` | `reply.sh`, budič odpoveď trasuje do vlákna témy |
| agent servera, zástupca operátora na Macu (cyril) | schránka cez `ask_agent.sh`, zástupca ju číta pri štarte relácie, budí ho `mac_wake.sh` | `ask_agent.sh --replies` |
| Tasker, agent | most `tasker_events.mjs` zapíše správu do schránky agenta | `reply.sh` pri správe `čakám`, na správu `nečakám` sa nepíše |
| odpoveď na správu zo schránky | `reply.sh` do `/var/lib/<meno>/outbox`, budič ju trasuje | podľa režimu správy |

Schránka teda ostáva pre Mac, Tasker a odpovede, ktoré budič trasuje.
Správu medzi dvoma vláknami T3 na tom istom serveri nesie `t3_thread_send`.

Ranný súhrn (D0179, D0183) ide cez plánovač T3: úloha `schedule_task` typu
`fixed_time` na 07:00, viazaná na hlavné vlákno správcu agentov, s promptom
`node $AGENT_WORKFLOW/morning.mjs --stdout`. Správca agentov v tom vlákne
spustí skript a z jeho výstupu napíše report podľa svojej persony.
`agent-morning.timer` ostáva ako náhrada mimo T3 (zapisuje súhrn do schránky)
a je vypnutý.

## Trasa odpovede do vlákna témy

Agent píše aj z vlákna témy, nie len z hlavného. Odpoveď na správu
z vlákna témy má prísť tam, kde o nej téma vie. Chyba 18. 10. 2026: odpoveď
Borisa na správu z vlákna "Adam, globálne pravidlá a persony" prišla do
hlavného vlákna.

1. Správu agentovi píše `ask_agent.sh <adresát> <téma>` s textom na stdin,
   odpoveď na správu `reply.sh`. Oba po zápise zavolajú `route.mjs remember
   <meno>`, ktorý nájde vlákno volajúceho a zapíše trasu do
   `$AGENT_STATE/routes.json`: kľúč správy (meno bez predpôn oboch strán,
   `pravidla-20261018-195432-12.md`), druhú stranu, tému, vlákno a čas.
   Hlavné vlákno trasu nedostane, jeho zápis zruší staršiu trasu s tým istým
   kľúčom alebo témou. Záznam starší ako 30 dní vypadne.
2. Vlákno volajúceho: `CLAUDE_CODE_SESSION_ID` v prostredí vlákna je id
   relácie claude a vlákno T3 ho má v `providerThreads[].nativeThreadRef.nativeId`
   (detail `/bounded`). `route.mjs` prejde zo shellu všetky vlákna okrem
   sub-agentov (`thread:provider:`, `parentThreadId`), ktoré patria rodičovi
   (sub-agent má id relácie rodiča) a nájdené id si zapamätá v `routes.json` pod
   `sessions`. Po `/clear` má proces novú reláciu, vtedy platí
   `--resume=<id>` z príkazového riadku procesu `CLAUDE_PID`. Keď vlákno
   nenájde alebo T3 neodpovie, správa odíde bez trasy a odpoveď príde do
   hlavného vlákna, skript to vypíše.
3. Budič pri každej správe v schránke pozrie trasu podľa `k:` z hlavičky
   (id pôvodnej správy). Správa bez `k:` trasu nemá, meno súboru sa na
   párovanie nepoužíva. Správy rozdelí podľa vlákna, jeden
   priechod pošle jednu dávku do jedného vlákna, zaneprázdnené vlákno témy
   hlavné nezdrží. Zaneprázdnenosť, front `queue_after_active`, `commandId`
   a `inflight.json` (navyše s `threadId` a poznámkami) platia rovnako.
4. Vlákno z trasy, ktoré neexistuje alebo je archivované, nahradí hlavné
   a správa dostane riadok `[budič] Správa patrí vláknu <id> (<titulok>),
   to je archivované, preto je tu.` Platí aj pre rozpracovanú dávku.

Platí pre každého agenta s týmto budičom: Boris volá
`AGENT_NAME=boris $AGENT_WORKFLOW/bin/ask_agent.sh adam <téma>` a jeho
budič číta `~/.local/state/boris/routes.json`.

## Zoznam tém

Trasa pozná len tému, ktorú vlákno začalo samo. Chyba 19. 10. 2026:
správa Cyrila k téme pravidiel prišla do hlavného vlákna a hlavné vlákno
robilo tú istú tému ako vlákno pravidiel, obe zapisovali do tých istých
klonov (úloha 2 v Taskeri, 19. 10. 2026).

1. Zoznam tém je `$AGENT_BOX/topics.json` (`/var/lib/adam/topics.json`),
   mimo gitu: meno témy -> vlákno T3, ktoré ju vedie, a čas zápisu.
   Práva 640 so skupinou schránky, Cyril ho číta cez SSH, iný agent na
   serveri priamo. Formát je plochý objekt s odsadením jednej medzery,
   `bin/ask_agent.sh` hľadá riadok ` "<téma>": {`.
2. Téma je presná, vlákno vedie jednu tému a téma má jedno vlákno (D0211).
   Nová téma dostane nové vlákno T3, nikdy sa nepriradí bežiacemu vláknu
   a holý názov projektu nie je téma. Chyba 28. 10. 2026: vlákno
   "workflow alignment" poslalo `ask_agent.sh <adresát> agentic_brain` a
   `route.mjs remember` mu tému agentic_brain zapísal, 26. 10. to isté
   vlákno zapísalo `topic set agenti` s holým názvom projektu. Zápis preto
   robí len výslovné `route.mjs topic set <téma>` z vlákna témy: nájde vlákno
   ako trasa (`CLAUDE_CODE_SESSION_ID`) a odmietne kódom 1 hlavné vlákno
   (tému nevedie), tému, ktorá je holým názvom projektu Taskera (zoznam
   projektov z `lib/tasker_read.mjs`, bez Taskera alebo pri chybe čítania
   kontrola mlčí), tému, ktorú podľa zoznamu už vedie iné vlákno, a vlákno,
   ktoré už vedie inú tému, bez `--force "<dôvod>"`. S `--force` zápis prejde
   a vypíše staré aj nové vlákno témy.
   Správa odmietnutia nesie riadok "Správny postup:". `route.mjs remember`
   (`ask_agent.sh`, `reply.sh`) tému nezapisuje, zapíše len trasu správy,
   a keď téma v zozname nie je, vypíše, že pre ňu treba nové vlákno T3.
   `ask_agent.sh` pri novej správe kontroluje aj zoznam odosielateľa
   (`route.mjs topic send <téma>`): téma musí byť v jeho `topics.json`
   a z vlákna témy ju smie poslať len vlákno, ktoré ju vedie, inak nič
   neodošle. `topic list`
   vypíše zoznam, `topic rm <téma>` tému zmaže. `topic tasks <téma> <id>...`
   pridá k téme koreňové úlohy (pole `tasks`): správy tasker mostu o takej úlohe,
   všetkých jej podúlohách (reťaz `parent_id`) a o úlohe, ktorú takáto úloha blokuje
   (tabuľka `blockers`, aj cez ďalší blokér, najviac 20 úloh; nadväzujúca úloha po done
   blokéra, úloha 560), idú do vlákna témy pred pravidlom podľa projektu. Úlohu založenú `tasker task add` vo vlákne témy zapíše do `tasks`
   sama hook `hooks/topic_task.mjs` (PostToolUse pre Bash v `.claude/settings.json`):
   vlákno nájde z relácie claude v SQLite T3 len na čítanie, z hlavného vlákna nerobí nič
   a pri chybe skončí kódom 0 bez zásahu. Keď z výstupu `task add` id nie je (príkaz ho
   prefiltroval rúrou, presmeroval alebo zahodil, úloha 563), hook ho zistí cez `tk task list|show --json`:
   úlohy z poslednej minúty, ktorých udalosť `created` je od tohto agenta (`human:<meno>`), pri `--title`
   v úvodzovkách musí sedieť aj názov. Hlavné vlákno a sub-agent tk nevolajú. Vlákno mimo hlavného (nie sub-agent),
   ktoré tému nemá, dostane pri prvej založenej úlohe tému `<projekt>_<koniec id vlákna>`
   (úloha 492, vlákno Tasker #7 tému nemalo a správy o úlohe 486 šli do hlavného vlákna).
   Holý projekt to nie je, aby téma nepresmerovala správy všetkých úloh projektu.
3. `ask_agent.sh <adresát> <téma>` pošle správu, len keď je téma
   v zozname tém odosielateľa (bod 2) a v zozname tém adresáta (`topics.json` vedľa jeho inboxu). Inak vypíše
   platné témy a nič neodošle, odpoveď s `--k` zoznam nekontroluje. Adresát bez zoznamu (cyril) prijme každú tému.
   Z Macu kontroluje zoznam Adama rovnako (ssh).
   Správa do hlavného vlákna adresáta ide s `--hlavne`, meno nemá tému
   (`<ja>-<čas>-<pid>.md`).
4. Budič správu bez trasy s témou v mene (`<odosielateľ>-<téma>-<čas>`,
   nie odpoveď `<odosielateľ>-<ja>-...` ani správa skriptu `ranny`,
   `pravidla`; správa `tasker-<téma>-...` z `tasker_events.mjs` tému má) doručí do vlákna témy zo zoznamu.
   Trasa má prednosť pred zoznamom. Správa od `tasker` bez trasy, ktorej
   telo začína riadkom `Tasker: úloha #N` (druhý riadok je `Odkaz: <TASKER_WEB_URL>/tasks/N`), ide pred zoznamom tém do
   nearchivovaného vlákna, ktorého titulok obsahuje `#N` ako celé číslo
   (`#70` nie je `#7`). Nie je to hlavné vlákno, vlákno sub-agenta
   (`thread:provider:`, `parentThreadId`) ani vlákno v projekte hlavného
   vlákna iného agenta (súrodenci `$AGENT_STATE` s `thread_id`). Projekt
   hlavného vlákna sa nevyžaduje, vlákna tém bežia aj v projektoch MCP
   nad priečinkom projektu (`projekt_b #351`). Viac zhôd: vlákno
   s najnovším `updatedAt`, inak prvé. Téma mimo zoznamu, vlákno zmazané
   alebo archivované: správa ide do hlavného vlákna s riadkom `[budič]
   Vlákno témy <téma> som nenašiel (<dôvod>), posielam do hlavného
   vlákna.` a pokynom vec nerobiť, kým hlavné vlákno nezistí, či tému
   nevedie iné vlákno. Dôvod je `téma nie je v zozname tém`, `vlákno <id>
   (<titulok>) je archivované` alebo `vlákno <id> neexistuje alebo je
   archivované`. T3 0.1.0 archivované vlákna v zozname nevracia, budič
   ich od zmazaných neodlíši.
5. Po doručení správy Taskera s riadkom `Tasker: úloha #N` budič zapíše do
   Taskera, kam ju doručil: `tk route N --thread <id vlákna> --title <názov>
   --via <spôsob>` pod menom agenta (`recordRoute` v `driver.mjs`, spôsob je
   `trasa odpovede`, `vlákno úlohy`, `téma <téma>` alebo `hlavné vlákno`).
   Web Taskera ukáže riadok `Správy idú do vlákna: ...` v bunke Riešiteľ
   na detaile úlohy (úloha 486). Príkaz je `AGENT_ROUTE_CMD`, predvolene
   `$AGENT_WORKFLOW/bin/tk`, prázdna hodnota zápis vypne. Chyba zápisu
   doručenie nezdrží.

## Zbytočné zobudenie

Zobudenie správou zo schránky, po ktorom agent nič nezapísal, je chyba
mechanizmu, nie ťah agenta (úloha 492, operátor 24. 10. 2026). Stop hook
`hooks/idle_wake.mjs` (v `.claude/settings.json`) prejde záznam relácie od poslednej
výzvy `<schranka ...>` a hľadá zapisujúci nástroj (Edit, Write, Agent, Bash, ktorý nie je
čisto čítací). Bez neho založí úlohu `tk task add --project agenti --assign <agent>` s id
správy, vláknom a dôvodom, najviac jednu na správu (`IDLE_WAKE_STATE`). Správa `na vedomie`
sa nepočíta. Hlásenie agenta nezobudí: `bridgeTrigger` nebudí pri `created` ani `assigned`
od samotného agenta, pri prechode do handoff od samotného agenta ani pri živej práci
(tabuľka `work`, `liveWork`). Test `test/idle_wake.test.mjs` replayuje zobudenia
`tasker-20261024-215628-486.md` a `tasker-20261024-215807-1927321-350064f5.md`, falošný
`tk` (`IDLE_WAKE_TK`), bez živého Taskera a schránky.

## Dozor

Budič v každom priechode (5 s) číta riadok vlákna z
`GET /api/orchestration/shell` a posúdi posledný beh. Ako T3 v0.1.0 končí
beh, overené v zdroji (zdroj T3, commit 81493efb71):

| koniec | stav behu v T3 | budič |
|---|---|---|
| riadny | `completed` | nič, skontroluje kontext |
| chyba poskytovateľa | `failed`, `lastErrorClass` iná ako `usage_limit` | zobudí |
| zabitý proces `claude` | `failed`, `transport_error` (`ClaudeAdapterV2.ts`, `finalizeActiveTurn` po zatvorení query) | zobudí |
| zabitý alebo reštartovaný T3 server | `cancelled` so `startedAt` (`ProviderRuntimeRecoveryService.ts`, obnova pri štarte) | zobudí, ak T3 nepokračoval sám |
| Stop alebo `run.interrupt` | `interrupted` a položka `run_interrupt_request` behu | nič, je to zámer človeka |
| prerušenie bez žiadosti | `interrupted` bez tej položky | zobudí (`AGENT_WAKE_ON_INTERRUPT=0` vypne) |
| limit predplatného | `failed`, `usage_limit`, `usageLimitResetAt` | čaká na reset, nie je to pád |

Po reštarte T3 server sám pošle do prerušeného behu "Continue where you
left off.", ak to dovolí nastavenie `continueThreadsAfterServerUpdate`
(predvolene zapnuté, najviac 3 za sebou, `RestartContinuation.ts`). Budič
preto budí až po odstupe od konca behu: keď T3 medzitým pokračoval, posledný
beh je už iný a budič nepošle nič.

Zobudenie je správa do vlákna "[budič] Posledný beh tohto vlákna neskončil
riadne ... Pokračuj v rozpracovanej práci podľa pamäte a stavu práce".
Odstup je `AGENT_WAKE_DELAY_S` krát 2 na počet zobudení v okne (60, 120,
240 s). Po `AGENT_WAKE_MAX` zobudeniach za `AGENT_WAKE_WINDOW_S` ďalší pád
zapíše výstrahu do `alerts.log`, spustí `ALERT_CMD` a budič ďalej nebudí,
kým niektorý beh neskončí riadne (napríklad operátor napíše do vlákna). Kým
čaká odstup pred zobudením, schránka čaká, po výstrahe ide ďalej.

Stojaci beh: vlákno s `activeRunId`, bez položky behu v stave `running`
(príkaz alebo sub-agent) a s poslednou položkou behu staršou než
`AGENT_STALLED_S` (predvolene 600 s, 0 vypne) budič preruší príkazom
`run.interrupt` (`orchestration.dispatchCommand`, ako v kóde Taskera
v module t3). T3 zapíše položku `run_interrupt_request`, takže ide o zámer,
nie pád, a nebudí sa. Do `alerts.log` ide výstraha, správy v rade T3
pokračujú. Vlákno čakajúce na schválenie alebo na iné vlákno sa
nepreruší. Prípad 23. 10. 2026: beh otvorila notifikácia o skončení
sub-agenta, Claude nevydal ťah a beh stál 52 minút. Prerušenie je raz na beh.

Rovnako sa preruší stojaci beh vo vláknach tém a ostatných vláknach T3
servera: dozerá na ne sledovač `clear_watch.mjs` (časť Ostatné vlákna T3
servera), vlákna agentov z `thread_id` vynecháva, tie rieši ich budič.
Vlákno s položkou `running` (sub-agent, príkaz) sa nepreruší. Raz na beh,
zapísané v `clear_watch.json` (`interrupted`), výstraha ide do `alerts.log`.
Úloha 419.

Visiaca požiadavka na schválenie (`stuck.mjs`, úloha 562). Vlákno vo
full-access na schválenie nečaká, ale Claude Code má vstavanú kontrolu
nebezpečného `rm` (`circuitBreaker` `dangerousRemoval`), ktorú
`bypassPermissions` nevypne, a T3 takú požiadavku pošle človeku
(`fullAccessOverride` `provider_check` v položke `approval_request`).
Vlákno potom stojí, kým ju niekto nevyrieši (štyri hodiny 25. 10. 2026).
Riadok vlákna v `shell` nesie `pendingRuntimeRequest` s `id`, `kind`
a `createdAt`, z neho budič vezme vek, databázu T3 nečíta. Požiadavka
staršia než `STUCK_ALERT_S` (predvolene 600 s, 0 vypne) sa ohlási raz na
`id`:

1. výstraha (`alert`: `alerts.log` a `ALERT_CMD`);
2. správa do hlavného vlákna iného agenta skriptom `STUCK_ASK_CMD`
   (`ask_agent.sh --hlavne <príjemca>`, text na stdin, režim `čakám`, takže
   ho zobudí). Príjemca je `STUCK_ALERT_AGENT`, a keď visí vlákno samotného
   príjemcu (`AGENT_NAME` budiča sa rovná príjemcovi), `STUCK_ALERT_FALLBACK`.
   Prázdny príjemca správu vypne a ostane výstraha. Správa nesie vlákno (id
   a názov), agenta, vek v minútach, dôvod z `approval_request`, prvých 200
   znakov príkazu z `command_execution` s rovnakým `nativeItemRef` a pokyn
   poslať operátorovi notifikáciu do telefónu (`PushNotification`), schváli
   v T3. Do hlavného vlákna ide správa bez témy, lebo nová správa s témou
   mimo zoznamu tém príjemcu skript odmietne.

Hlavné vlákno agenta dozerá `tick()` (`supervise.mjs` požiadavku len
preskakuje), vlákna tém a ostatné vlákna sledovač `clear_watch.mjs`
(vlákna agentov z `thread_id` vynecháva), takže sledovač treba mať zapnutý
v jednom budiči na T3 server. Stav je `$AGENT_STATE/stuck.json`
(`reported`: id požiadavky, čas výstrahy a správy, počet pokusov), správa
sa pri zlyhaní skriptu skúša znova, najviac päťkrát, výstraha ide raz.
Dozor požiadavku nerieši, neschvaľuje ju ani neodmieta. Skúška
`test/stuck.test.mjs` volá falošný skript správ a falošný T3, žiadna
nesiaha na živý T3 ani schránky.

Rozpracovaná dávka (`inflight.json`), ktorej vlákno je zaneprázdnené,
nezdrží doručenie do iných vlákien toho agenta: `tick()` doručí dávku inej
skupiny bez zápisu súboru (`batch` z mien, časov súborov a minúty, takže
pád po odoslaní správu nezopakuje) a `inflight.json` ostane, kým sa jeho
vlákno neuvoľní.

Po skončení limitu predplatného budič počká `AGENT_LIMIT_GRACE_S`, či T3
nepokračuje sám (`UsageLimitRecoveryWorker.ts`), potom pošle jednu správu
"Limit predplatného skončil, pokračuj". Do počtu pádov sa nepočíta.

Obnova po reštarte T3 a chyba behu zadržia front správ (`queueHeld`,
`Orchestrator.ts`), správy v ňom by čakali na človeka. Po riadnom behu
budič zadržaný front uvoľní príkazom `queue.resume`.

Reštart budiča nič nestratí: stav je v súboroch, každý príkaz má
`commandId` odvodené z vlákna a behu a T3 ho podľa záznamu príjmu
nezopakuje.

| premenná | predvolene | význam |
|---|---|---|
| `AGENT_WAKE_MAX` | 3 | zobudení v okne |
| `AGENT_WAKE_WINDOW_S` | 3600 | okno |
| `AGENT_WAKE_DELAY_S` | 60 | prvý odstup od konca behu |
| `AGENT_WAKE_ON_INTERRUPT` | 1 | budiť po prerušení bez žiadosti |
| `AGENT_LIMIT_GRACE_S` | 120 | čakanie po resete limitu |
| `ALERT_CMD` | prázdne | príkaz pre `sh -c`, text výstrahy na stdin a v `ALERT_TEXT` |
| `STUCK_ALERT_S` | 600 | vek požiadavky na schválenie, od ktorého sa ohlási (0 vypne) |
| `STUCK_ALERT_AGENT` | prázdne | agent, ktorého hlavné vlákno dostane správu o visiacej požiadavke (prázdne: len výstraha); verejné repo nenesie mená, hodnotu nastaví `runtime.env` |
| `STUCK_ALERT_FALLBACK` | prázdne | príjemca, keď visí vlákno samotného `STUCK_ALERT_AGENT` |
| `STUCK_ASK_CMD` | `<workflowDir>/bin/ask_agent.sh` | skript správ, volaný ako `<skript> --hlavne <príjemca>` s textom na stdin a `AGENT_NAME` budiča (skúšky ho prepisujú falošným) |

## Čistý kontext

Hranicu kontextu stráži hook `context_warning.mjs` klonu kódu,
na serveri `$AGENT_WORKFLOW/hooks` (80 tisíc tokenov, pripomienka, o čistení rozhoduje agent). Vo vlákne T3
agentovi povie zapísať rozpracované do pamäte, commitnúť, pushnúť
a odpoveď ukončiť posledným riadkom z `bin/kontext.sh` klonu kódu.
Budič agenta nevyzýva, výzva stála celý ťah navyše
(čistý kontext na slovo agenta, 18. 10. 2026). Po `/clear` sa model predvolene nevolá (úloha 420: 83 % ťahov
po starej pokračovacej správe nespravilo nič a stálo okolo 192 tisíc
vstupných tokenov).

`kontext.sh spanok|pokracuj [--dalej "<ďalší krok>"] [--stav "<súhrn>"]`
zapíše odovzdávku `${KONTEXT_DIR:-~/.local/state/kontext}/<id relácie>.json`
(práva 600: `key`, `rezim`, `dalej`, `stav`, `cwd`, `at`) a vypíše riadok
`HOTOVO-KONTEXT <režim> <kľúč>`. `pokracuj` bez `--dalej` skončí kódom 2.
Formát riadku a čítanie odovzdávky sú v `kontext.mjs`, `config()` ju berie
ako `kontextDir`.

1. Po každom riadnom behu budič prečíta poslednú odpoveď agenta v behu
   z detailu vlákna (`messages` s `runId`, riadok shell má
   `latestVisibleMessage` v T3 0.1.0 prázdny).
2. Keď jej posledný neprázdny riadok je `HOTOVO-KONTEXT`, `HOTOVO-KONTEXT
   spanok [<kľúč>]` alebo `HOTOVO-KONTEXT pokracuj <kľúč>`, budič zapíše
   `rotation.json` a pošle do toho istého vlákna `/clear`. Pri holom slove
   a pri `spanok` je to všetko, model sa nevolá. Pri `pokracuj`
   s kľúčom, ktorý sedí s nespotrebovanou odovzdávkou, pošle za `/clear`
   jednu správu `[budič] Kontext vyčistený. Ďalší krok: <--dalej>` bez
   pokynu čítať pamäť a odovzdávku označí `consumed`. Neplatný alebo už
   použitý kľúč sa správa ako `spanok` a zapíše výstrahu do `alerts.log`.
   Potom `rotation.json` zmaže. Vlákno, jeho id aj relácia poskytovateľa
   ostávajú, budič nič nezastavuje. Riadok uprostred textu prechod
   nespustí. Štart relácie po `/clear` (fetch, rebase, stav a ďalší krok
   z odovzdávky) robí hook `clear_bridge.mjs`. Štartovaciu správu
   `start_agent.mjs` dostane už len náhradné nové vlákno, keď T3 `/clear`
   odmietne (ďalší krok a stav pribudnú pri `pokracuj`).
3. Kým prechod trvá, schránka čaká a správy z nej idú do vlákna až po
   čistom kontexte.

Keď agent slovo nenapíše, kontext rastie až po limit okna a beh skončí
chybou API (prompt is too long): kompakcia je zakázaný stav (D0190),
`autoCompactEnabled` false a hook `compact_block.mjs` repa pravidiel ju
zastavia aj pri `/compact`.

`/clear` cez `message.dispatch` T3 odovzdá Claude Code ako príkaz
a bežiaci proces claude pokračuje v novej relácii. T3 0.1.0 si však pri
vlákne drží id relácie z prvého štartu (`nativeThreadRef.nativeId`
v tabuľke `orchestration_v2_projection_provider_threads` v
`statev2.sqlite`) a ďalší proces claude, napríklad po reštarte T3 alebo
páde, spustí s `--resume` na reláciu spred `/clear`. Starý kontext by sa
vrátil. Bráni tomu hook `hooks/clear_bridge.mjs` klonu kódu: pri
`SessionStart` so source `clear` odloží prepis pôvodnej relácie ako
`.bak` a na jeho miesto dá symbolický odkaz na prepis novej relácie,
takže `--resume` načíta čistý kontext (/clear v T3 cez most prepisu,
18. 10. 2026). Hook musí byť zapojený
v `settings.json` používateľa, pod ktorým beží T3 server agenta. Bez neho
sa starý kontext vráti pri ďalšom štarte procesu claude.

Pád budiča počas `/clear`: obe správy majú `commandId` odvodené z vlákna
a behu, opakovaný priechod ich nepošle druhý raz.

### Ostatné vlákna T3 servera

Vlákna tém a vlákna spustených agentov nemajú budiča. Čistý kontext im
dáva sledovač `clear_watch.mjs`, ktorý beží v budiči jedného agenta na
T3 serveri, zapína ho `AGENT_CLEAR_WATCH=1` v jeho `runtime.env`. Na
jednom serveri je to napríklad `agent-driver@adam`, `agent-driver@boris` ho nemá. Dva
sledovače nad tým istým T3 serverom by `/clear` neposlali dvakrát
(`commandId` z vlákna a behu), ale každý by čítal detail každého vlákna.
Vlastná služba by pridala jednotku na údržbu bez úžitku.

V každom priechode budiča (vlastná slučka, chyba sledovača schránku
nezdrží) prejde nearchivované vlákna z `GET /api/orchestration/shell`
a `/clear` pošle, keď platí všetko:

- vlákno nie je vlákno agenta: chýba v `thread_id`, v `oldThreadId`
  súboru `rotation.json` a v `retired_threads` každého súrodenca
  `$AGENT_STATE` (`~/.local/state/*/`, zoznam priečinkov oddelených
  dvojbodkou mení `AGENT_CLEAR_WATCH_AGENTS`). Vlákno agenta rieši jeho
  budič, schránka ostáva len pri `thread_id`;
- posledný beh je `completed` a sledovač ho ešte neposúdil;
- vlákno nie je zaneprázdnené (`threadBusy`) a nemá úlohu na pozadí
  (`pendingBackgroundTasks`);
- posledný neprázdny riadok poslednej odpovede asistenta v behu je presne
  `HOTOVO-KONTEXT`.

Posledný riadok sa číta ako v budiči agenta (`kontext.mjs`). Po `/clear`
pošle správu `[budič] Kontext vyčistený. Ďalší krok: <--dalej>` len pri
`pokracuj` s platným kľúčom, pri holom slove a `spanok` ostane vlákno
témy po `/clear` samo a model sa nevolá, kým doň niekto nenapíše.
Štartovaciu správu agenta (`start_agent.mjs`) nedostane, vlákno témy nie je
trvalý beh agenta.

Tesne pred `/clear` sledovač znova prečíta riadok vlákna. Keď sa
`latestRunId` zmenil alebo vlákno je zaneprázdnené (medzitým prišla správa
a začal nový beh), `/clear` nepošle a beh neoznačí za posúdený, ďalší
priechod posúdi nový. `tick()` budiča a `watchStep()` bežia v jednom procese
za sebou, nie súbežne: `main()` ich obaľuje mutexom `serial()` z `lib.mjs`.

Stav je `$AGENT_STATE/clear_watch.json`: `checked` (vlákno a posúdený beh),
`pending` (rozpracovaný `/clear`), `interrupted` (vlákno a prerušený stojaci beh). Pád medzi `/clear` a pokračovaním
dokončí ďalší priechod s tými istými `commandId`. Prvý štart bez stavu
zapíše posledné behy všetkých vlákien ako posúdené a nepošle nič:
staré vlákna agentov nahradené novým vláknom (časť Náhrada) končia slovom
a pokračovanie by v nich spustilo druhého agenta. Z toho istého dôvodu
náhrada zapíše staré vlákno do `retired_threads`. Keď T3 `/clear`
odmietne, sledovač zapíše výstrahu do `alerts.log` a beh viac neskúša.

### Náhrada: nové vlákno

Keď T3 `/clear` odmietne, budič zapíše výstrahu a v `rotation.json`
prejde na fázu `launch`:

1. Založí nové vlákno v tom istom projekte s tým istým modelom a režimom
   (`orchestration.launchThread`, ako `start_agent.mjs`), titulok
   `<Meno> RRRR-MM-DD HH:MM`. Úvodná správa je štartovacia správa
   `start_agent.mjs` a veta, ktoré vlákno nahradilo, koľko tokenov malo
   a že T3 odmietol `/clear`.
2. Zapíše staré vlákno do `retired_threads`, prepíše `thread_id`, zastaví reláciu poskytovateľa starého vlákna
   a `rotation.json` zmaže. Staré vlákno ostane v T3 na čítanie,
   nearchivuje sa.
3. Zastavenie relácie je príkaz klienta T3 "thread session stop"
   (`EnvironmentCommands.stopThreadSession` v `client/assets/runtime-*.js`
   T3 0.1.0): pre každú položku `providerSessions` z detailu vlákna jeden
   `orchestration.dispatchCommand` s `type: "provider-session.detach"`,
   `threadId`, `providerSessionId` a `reason: "client-requested"`. T3 potom
   ukončí proces claude vlákna. Bez toho by po každej náhrade ostal jeden
   nečinný proces. Budič zastaví len staré vlákno z `rotation.json` a len
   keď v ňom nebeží ťah (riadok vlákna a behy v detaile, relácia má počas
   ťahu stav `ready`). Inak, aj pri chybe, zapíše výstrahu do
   `alerts.log` a prechod dokončí.
4. Kým náhrada trvá, schránka čaká a správy z nej idú až do nového vlákna.

Pád budiča počas náhrady: `launchThread` s tým istým `commandId` (z vlákna
a behu) vráti to isté vlákno, druhé nevznikne. Keď `thread_id` už ukazuje
na nové vlákno, budič dodatočne zastaví reláciu starého a súbor zmaže.

## Viac agentov

Runtime nesie meno agenta v `AGENT_NAME` a z neho odvodí cesty. Bez
`AGENT_NAME` platí meno `agent`, služby a skripty ho preto dostanú z unitu
(`Environment=AGENT_NAME=...`) alebo z `runtime.env`.

Šablóna `systemd/agent-driver@.service`: inštancia je meno agenta,
nastavenie `%h/.config/<meno>/runtime.env`, `AGENT_WORKFLOW` je klon tohto repa
s `driver.mjs` (predvolene `/opt/agentic-workflow`; `Environment=` je v jednotke pred
`EnvironmentFile=`, takže ho `runtime.env` prekryje). Je to systémová služba pod
rootom v `/etc/systemd/system/`, všetci agenti zdieľajú jeden T3 server
(`t3code.service`).

- Hlavný agent `adam`: `agent-driver@<adam>.service`,
  `/root/.config/adam/runtime.env` (`AGENT_WORKFLOW` len pri inom klone),
  `AGENT_WORKDIR=/root/adam`, `AGENT_BOX=/var/lib/adam`, `AGENT_CLEAR_WATCH=1`.
- Druhý agent `boris`: `agent-driver@<boris>.service`,
  `/root/.config/boris/runtime.env` (600),
  `AGENT_WORKDIR=/root/boris`, `AGENT_BOX=/var/lib/boris`,
  `AGENT_REPLY_CMD="AGENT_NAME=boris $AGENT_WORKFLOW/reply.sh"` a
  `AGENT_REPLY_ROUTE_adam=/var/lib/adam/inbox`. Hlavný agent mu odpovedá
  cez `AGENT_REPLY_ROUTE_boris` v svojom `runtime.env`.
- Ďalší agenti sa zriaďujú skriptom `agent_vlakno.sh` (nižšie).

## Hooky relácie

Hooky bežia v procese `claude` agenta, nie v budiči, preto `runtime.env` nie
je načítaný. Hook si ho prečíta sám (`hookEnv` v `lib/agent_env.mjs`):
`AGENT_RUNTIME_ENV` (cesta k súboru), inak `~/.config/<agent>/runtime.env`,
agent je `TASKER_USER`, `AGENT_NAME`, inak nadpis `# Meno` z `PERSONA.md`
v `CLAUDE_PROJECT_DIR` alebo `cwd`. Premenná procesu má prednosť pred
súborom, prázdna ho neprekryje. Bez súboru dostane hook predvolené hodnoty,
mená ani adresy v kóde nie sú. Správanie hookov nezávisí od mena operátora:
text pre model ho berie z `AGENT_OPERATOR_NAME` (bez neho slovo "operátor").

| hook | udalosť | čo robí |
|---|---|---|
| `identity.mjs` | SessionStart | ohlási identitu z `PERSONA.md` a vloží pravidlá rolí z `roles/<slug>.md` klonu kódu; bez `PERSONA.md` v koreni (vlákno témy v klone projektu) nájde agenta cez vlákno relácie v T3 a `topics.json` agentov (`personaFor` v `lib/agent_name.mjs`, úloha 636) a ohlási aj tému |
| `memory_context.mjs` | SessionStart | vloží prvých 200 riadkov `memory/MEMORY.md` repa agenta (index pamäte) do kontextu, aj po `/clear`; úvodná správa budiča preto pamäť čítať nehovorí (úloha 614). Bez `PERSONA.md` alebo `MEMORY.md` mlčí |
| `rules_delta.mjs` | UserPromptSubmit | vloží zmenu `RULES.md` klonu kódu a `env/<prostredie>/` klonu spoločného mozgu od posledného videného HEAD (s `AR_ROZHODNUTIA=1` aj `decisions/`) |
| `tasker_work.mjs` | UserPromptSubmit, PreToolUse (Agent, zapisujúce nástroje), SubagentStop | ohlási prácu na úlohe Taskera (`tk work N`), prevezme úlohu v poradí, zámok úlohy držanej inou reláciou; vlastnú reláciu po /clear pozná `sameSession` podľa symlinku prepisu a podľa reťaze id v `<pôvodné id>.sessions` (úlohy 595 a 656) |
| `own_rule_scope.mjs` | PreToolUse (Write, Edit, MultiEdit, Bash) | prvý zápis nového textu do `CLAUDE.md`, `PERSONA.md` alebo `RULES.md` repa agenta (`RULES.md` len s `PERSONA.md` vedľa seba) sa zamietne s otázkou, či to nepatrí do repa pravidiel; nový odsek `Chyba <dátum>` do akéhokoľvek `CLAUDE.md`, `PERSONA.md` alebo `RULES.md` (aj cez Bash: `>`, `>>`, `tee`, `sed -i`, `perl -i`, `python` so zápisom) sa zamietne vždy, chyba patrí do registra mozgu (`skills/error/scripts/error.sh`, úloha 613); príkaz `sed -i`, `perl -i` alebo `python` s prepisom súboru, ktorého odsek `Chyba <dátum>` je v cieľovom súbore už teraz (mazanie, preformulovanie), prejde, zamietne sa len odsek, ktorý v súbore ešte nie je (úloha 625) |
| `reply_guard.mjs` | Stop | odpoveď operátorovi: strop 3 viet prózy (6, keď posledná správa operátora žiada postup, podrobnosti, vysvetlenie alebo dokument; zoznamy, kód a štyri vety hlásenia zo `skills/error/scripts/error.sh` sa nerátajú) a 35 slov na vetu, meno na prvom riadku, priebežná správa v ťahu so slovesom v budúcom čase (zámer namiesto hotového kroku), mŕtvy alebo lokálny odkaz, zmienka úlohy Taskera bez odkazu, položka "(rozhodnutie)" v "Čaká na teba:" bez `?`, s nedefinovaným A/B alebo s neoverenou vetou (`lib/human_question.mjs`: `questionProblem`, `unverifiedClaim`, úlohy 575 a 656), s `AR_ROZHODNUTIA=1` aj "Čaká na teba" a nezapísané rozhodnutie |
| `no_operator_commands.mjs` | Stop | odpoveď bez príkazu shellu pre operátora a bez položky "Čaká na teba", ktorú urobí agent |
| `objection_fix.mjs` | Stop | uznaná chyba alebo námietka sa nezaobíde bez `error.sh` a commitu súboru, ktorý agenta riadi |
| `todo_after_comment.mjs` | Stop | úloha agenta s jeho komentárom nesmie ostať v poradí |
| `done_related.mjs` | Stop | po zavretí úlohy nesmie v jej projekte ostať otázka `needs_human` toho istého riešiteľa bez jeho komentára v ťahu (zruš s dôvodom, alebo napíš, prečo platí; úloha 609 po audite 612, 27. 10. 2026) |
| `idle_wake.mjs`, `topic_task.mjs` | Stop, PostToolUse | zbytočné zobudenie a úloha vo vlákne témy (časti vyššie) |
| `brain/bin/repeat_guard.mjs` | PreToolUse Bash | zamietne tretí ručný beh toho istého programu s inými argumentmi v jednej relácii (výnimky `brain/bin/repeat_guard.allow`, k nim `--allow <súbor>` z tabuľky pridá `env/<stroj>/repeat_guard.allow` mozgu s nástrojmi prevádzky, chýbajúci súbor sa preskočí; telo heredocu sa nepočíta); jediný hook mimo `hooks/`, v tabuľke `env/hooks.mjs` je cesta od koreňa klonu a beží pre `main`, `runs` aj `mac` (úloha 684) |

Zapojenie: `node <klon kódu>/hooks/<hook>.mjs` v `settings.json`. Hooky, ich
udalosti, matchery, časové limity a to, kde bežia (`main` interaktívne relácie na serveri,
`runs` behy správcu úloh, `mac` Mac, `agent` hook, ktorý si zapína repo agenta), nesie
jediná tabuľka `env/hooks.mjs`. Server píše `settings.json` skriptom
`env/server/install.sh`, Mac skriptom `env/mac/install.sh`, oba cez
`node env/hooks.mjs apply <druh> <settings.json>`: naše skupiny hookov nahradí, cudzie
kľúče a hooky nechá. `node check.mjs` porovná živý súbor Macu s generátorom. Hooky nájdu
tento repo a spoločný mozog cez `lib/paths.mjs` (`AGENT_WORKFLOW`, predvolene
`/opt/agentic-workflow`, na Macu `~/Work/agentic-workflow`; `AGENT_BRAIN_GLOBAL`,
predvolene `/opt/agentic-brain-global`, na Macu `~/Work/agentic-brain-global`)
a obal `tk` (`AGENT_TK`, inak `bin/tk` v klone kódu).
`agent_vlakno.sh` zapíše novému agentovi `AGENT_TASKER_USER` a skopíruje `AGENT_OPERATOR_NAME` a `TASKER_WEB_URL` z `runtime.env` správcu. Testy hookov sú `test/<hook>.test.mjs`, `test/agent_env.test.mjs`
a `test/deny.test.mjs`, všetky bežia s `HOME` v tmp a bez živého Taskera.

## Skripty a knižnice

Kód, ktorý používa viac repí, žije len tu. Repo pravidiel (súkromné) a repo
playbooku (verejné) ho nekopírujú: repo pravidiel ho berie cez tenké obaly
a re-exporty, playbook naň odkazuje odkazom na zdroj. Nič z toho nepredpokladá,
že leží v repe pravidiel, a nenesie mená agentov, ľudí ani strojov
(`node lib/public_check.mjs`).

| súbor | čo robí |
|---|---|
| `bin/rozhodni.sh` | jediný zápis rozhodnutia do `rozhodnutia/` repa s rozhodnutiami: pridelí číslo, zapíše súbor a `INDEX.md`, commitne pod menom agenta (`<Agent> (<stroj>)`), pushne, nepushnutý lokálny záznam po cudzom zápise s rovnakým číslom prečísluje, `--z-ulohy N` doplní zdroj a úlohu z Taskera, `--dry-run` nezapíše nič |
| `lib/rozhodnutia.mjs` | register: `list`, `show`, `check`, `index`, `zapis`; exportuje aj `configure({ repo, operatori, kontroly })`, ktorým repo pravidiel doplní meno operátora a vlastné kontroly záznamov |
| `skills/error/scripts/error.sh` | uznaná chyba agenta: pridá riadok `\| dátum \| trieda \| opis \| oprava \| test \|` do `errors/REGISTER.md` mozgu (`--brain <priečinok>`, inak z pracovného priečinka: `agentic-brain/errors`, `errors/` v koreni repa, nakoniec register spoločného mozgu cez `lib/paths.sh`); voľby `--class`, `--file` (commitnutý súbor opravy), `--mechanism` (povinná, `hook:<cesta>`, `test:<cesta>`, `deny:<vzor>` alebo `decision:D<nnnn>`, bez nej kód 1, `Správny postup:` a nič sa nezapíše), voliteľné `--description`, `--truth`, `--check`; pri druhom výskyte tej istej triedy v tom istom registri založí úlohu na kontrolu príkazom z `AGENT_TK` (bez neho napíše, že úloha sa nezakladá) a číslo úlohy zapíše do stĺpca opravy; vypíše hlásenie v štyroch vetách; `--open` vypíše riadky registra bez opravy, nič nezapíše. Skript je sebestačný, skopíruje sa aj do cudzieho mozgu (`adopt.sh --standalone`) |
| `lib/deny.sh`, `lib/deny_check.mjs` | `deny_postup` pre git hooky (dôvod a riadok "Správny postup:") a strážca, ktorý zlyhá na hooku so zamietnutím bez postupu (`denyProblems(koreň)`) |
| `lib/session_id.mjs` | `originalId()`: pôvodné id relácie claude vlákna T3 z príkazového riadku predkov procesu; `recordChain(dir, id, ids)` zapíše reťaz relácií do `<dir>/<id>.sessions`, `chainedSessions(dir, id)` ju prečíta (úloha 656) |
| `lib/path_check.mjs` | kontrola, že každá cesta v apostrofoch v `*.md` repa je v ňom alebo je uvedená v jeho `README.md` v sekcii "Čo v repe nie je" (`PATH_CHECK_ROOT` ukáže na iné repo) |
| `lib/public_check.mjs` | kontrola mien a adries pred commitom a pushom, aj pre iné verejné repo (`PUBLIC_CHECK_ROOT`, `PUBLIC_CHECK_LIST`) |
| `lib/paths.mjs`, `lib/paths.sh` | `workflowDir`, `brainGlobalDir`, `decisionsDir` (`workflow_dir`, `brain_global_dir`, `decisions_dir` v shelli): cesty ku klonu kódu, ku klonu spoločného mozgu a k registru rozhodnutí `<mozog>/decisions`; hodnota z `AGENT_WORKFLOW` a `AGENT_BRAIN_GLOBAL`, inak na macOS `~/Work/agentic-workflow` a `~/Work/agentic-brain-global`, inak `/opt/agentic-workflow` a `/opt/agentic-brain-global` |

Premenné:

| premenná | význam |
|---|---|
| `ROZHODNUTIA_DIR` | priečinok záznamov namiesto `decisionsDir()` (`<AGENT_BRAIN_GLOBAL>/decisions`), alebo parameter `--dir`; `rozhodni.sh` používa vždy `decisions_dir` |
| `ROZHODNI_SYNC_UNIT` | jednotka systemd, ktorú `rozhodni.sh` po pushi spustí, bez nej sa sync nespúšťa |
| `ROZHODNI_STROJ`, `ROZHODNI_TASKER` | meno stroja v mene autora commitu a príkaz Taskera pre `--z-ulohy` |
| `ERROR_AGENT`, `AGENT_TK` | meno agenta pre názov úlohy a príkaz Taskera (obal `bin/tk`), ktorým `error.sh` zakladá úlohu na kontrolu |
| `ERROR_REVIEWER` | riešiteľ úlohy na kontrolu z `error.sh` (predvolene `spravca-agentov`) |
| `AGENT_WORKFLOW` | klon tohto repa, z ktorého sa berie `bin/tk` a ostatné skripty (predvolene server `/opt/agentic-workflow`, Mac `~/Work/agentic-workflow`) |
| `AGENT_BRAIN_GLOBAL` | klon spoločného mozgu s priečinkom `decisions/` (`D0001.md`), `roles/agents.md` a `commit_guard/` (predvolene server `/opt/agentic-brain-global`, Mac `~/Work/agentic-brain-global`) |

Testy sú `test/rozhodnutia.test.mjs`, `test/error.test.mjs`, `test/deny_check.test.mjs`
a `test/path_check.test.mjs`, bežia v dočasných priečinkoch s falošným Taskerom.

## Premenné prostredia

Premenné čítajú služby z `EnvironmentFile` (`runtime.env`) a skripty z
prostredia. `reply.sh` si `runtime.env` agenta načíta sám.

| premenná | predvolene | význam |
|---|---|---|
| `AGENT_NAME` | `agent` | meno agenta, z neho sa odvodia cesty |
| `AGENT_TITLE` | meno s veľkým písmenom | titulok vlákna, "Si <Meno>." |
| `AGENT_BOX` | `/var/lib/<meno>` | schránka s `inbox`, `outbox`, `processed` |
| `AGENT_STATE` | `~/.local/state/<meno>` | stav budiča |
| `AGENT_TOPICS_FILE` | `$AGENT_BOX/topics.json` | zoznam tém |
| `AGENT_WORKDIR` | `~/agenti/<meno>` | klon repa agenta, projekt T3 pri `start_agent.mjs` |
| `AGENT_MODEL` | (povinné pre `start_agent.mjs`) | model Claude pre vlákno |
| `AGENT_T3_INSTANCE`, `AGENT_RUNTIME_MODE` | `claudeAgent`, `auto` | inštancia T3 a režim povolení |
| `AGENT_POLL_S` | 5 | perióda budiča |
| `AGENT_CLEAR_WATCH` | `0` | `1` zapne sledovač ostatných vlákien (na jednom T3 serveri len u jedného agenta) |
| `AGENT_CLEAR_WATCH_AGENTS` | súrodenci `$AGENT_STATE` s `thread_id` | zoznam cez dvojbodku |
| `AGENT_REPLY_CMD` | `AGENT_NAME=<meno> <workflowDir>/reply.sh` | príkaz odpovede v hlavičke správy |
| `AGENT_REPLY_ROUTE_<meno>` | | schránka odosielateľa, kam ide odpoveď navyše |
| `AGENT_REPLY_PREFIX` | meno agenta | predpona mena odpovede |
| `AGENT_INBOX_ONLY` | prázdne | mená cez dvojbodku: odpoveď im ide len do ich schránky (`/var/lib/<meno>/inbox`), nie do `outbox` |
| `AGENT_SWEEP_BOXES` | vlastná schránka a priečinky z `AGENT_REPLY_ROUTE_*` | schránky pre ranný súhrn |
| `AGENT_WORK_REPOS` | /root/tasker, agentic-workflow, agentic-brain-global a klony agentov s PERSONA.md pod domovským priečinkom (čiarka) | repá, z ktorých ranný súhrn počíta commity za 24 h |
| `AGENT_ROUTE_CMD` | `<workflowDir>/bin/tk` | zápis trasy do Taskera, prázdne vypne |
| `AGENT_T3_DB` | `/root/.t3/userdata/statev2.sqlite` | databáza T3 (len čítanie), z nej ranný súhrn počíta správy operátora z webu |
| `AGENT_TK` | `<workflowDir>/bin/tk` | obal `tasker` pre `tasker_work.mjs` a ďalšie hooky |
| `AGENT_OPERATOR_NAME` | `operátor` | meno operátora v textoch hookov pre model, tvary s príponami `-ovi` a `-a` ("Oskarovi", "Oskara") |
| `AGENT_RUNTIME_ENV` | `~/.config/<agent>/runtime.env` | súbor, z ktorého hooky čítajú premenné, keď ich proces `claude` nemá |
| `AR_ROZHODNUTIA` | prázdne | `1` zapne v `reply_guard.mjs` kontrolu "Čaká na teba" a nezapísaného rozhodnutia a v `rules_delta.mjs` sledovanie `decisions/` |
| `AR_STATE`, `AR_ENV`, `REPLY_GUARD_NO_NET` | stav v `~/.local/state/agentic-workflow`, `server` alebo `mac`, prázdne | skúšky a stroje bez siete: priečinok stavu hookov, názov prostredia v `rules_delta.mjs`, `1` vypne kontrolu odkazov v `reply_guard.mjs` |
| `AGENT_BATCH_WAIT_S`, `AGENT_BATCH_MAX_WAIT_S` | 30, 120 | tiché okno dávky |
| `AGENT_HELD_WARM_S` | 600 | držaná správa na vedomie odíde sama, keď posledný beh vlákna skončil najviac toľko sekúnd dozadu a nebol to `/clear` |
| `AGENT_HELD_MAX_S` | 86400 | držaná správa na vedomie odíde sama, keď čaká dlhšie; ranný súhrn ju presunie skôr (D0176) |
| `T3_URL` | `http://127.0.0.1:3773` | adresa T3 servera, napríklad `https://host.example.ts.net:8802`; vlákna založené cez MCP ju nededia, patrí do `runtime.env` |
| `T3_TOKEN_FILE` | `~/.config/<meno>/t3_token` | token T3 (600) |
| `TASKER_HOME`, `TASKER_DB`, `TASKER_BIN` | `~/.tasker`, `$TASKER_HOME/tasker.db`, `/opt/tasker/bin/tasker` | Tasker |
| `TASKER_WEB_URL` | `http://127.0.0.1:8801` | adresa webu Taskera v odkazoch správ a v hookoch (`reply_guard`, `tasker_read`), napríklad `https://host.example.ts.net:8801` |
| `TASKER_SELF` | `AGENT_NAME` | vlastník mostu z Taskera |
| `TASKER_EXTERNAL_AGENTS` | prázdne | agenti s vláknom T3 (cez dvojbodku), ktorým most posiela úlohy |
| `TASKER_OPERATORS` | `operator` | mená ľudí (cez dvojbodku), ktorých komentár nesie rozhodnutie |
| `TASKER_BOX_<meno>` | `/var/lib/<meno>` | schránka agenta z mosta |
| `AGENT_MANAGER` | (povinné pre `agent_vlakno.sh`, `github_repo.sh`, `github_foreign_repo.sh`, `github_device_login.sh`) | agent, v ktorého `~/.config/<meno>` sú tokeny GitHubu a `runtime.env` s trasami |
| `AGENT_RESERVED` | prázdne | mená cez dvojbodku, ktoré `agent_vlakno.sh` odmietne |
| `AGENT_GH_OWNER` | (povinné) | účet GitHubu, v ktorom sú repá agentov |
| `AGENT_GH_MACHINE` | (povinné) | strojový účet GitHubu s kľúčmi `/root/.ssh/<účet>_<meno>` |
| `AGENT_GH_EMAIL` | (povinné) | e-mail autora commitov (noreply účtu) |
| `AGENT_HOST` | (povinné) | označenie stroja v autorovi commitov, `<Meno> (<stroj>)` |
| `AGENT_TASKER_USER` | (povinné) | používateľ, pod ktorým bežia behy úloh a prehliadač; hooky: `own_rule_scope.mjs` kontroluje `/home/<používateľ>/agenti/<agent>/`, `tasker_read.mjs` hľadá DB v `/home/<používateľ>/.tasker/tasker.db`, keď nie je `TASKER_DB` ani `TASKER_HOME` |
| `AGENT_INBOX_GROUP` | `agent-inbox` | skupina schránok v `tmpfiles.d` |
| `AGENT_BROWSER_USER`, `AGENT_BROWSER_INST` | `AGENT_TASKER_USER`, `~/.cache/agent-browser` | prehliadač; pod rootom bez premenných v prostredí (vlákno T3) číta `browser.sh` `AGENT_BROWSER_USER` a `AGENT_TASKER_USER` z `runtime.env` agenta podľa `AGENT_RUNTIME_ENV`, `AGENT_NAME` alebo `PERSONA.md` v `CLAUDE_PROJECT_DIR` či aktuálnom priečinku (úloha 649) |
| `GH_CLIENT_ID` | (povinné pre `github_device_login.sh`) | client id aplikácie OAuth |
| `MAC_WAKE_AGENT` | (povinné pre `mac_wake.sh`) | agent na Macu, ktorého schránku `mac_wake.sh` sleduje; ďalej `MAC_WAKE_INBOX`, `MAC_WAKE_STATE`, `MAC_WAKE_CMD` |
| `ASK_VAR_LIB` | `/var/lib` | koreň schránok (skúšky) |
| `ASK_DEFAULT_TO`, `ASK_FROM` | `agent`, (povinné bez `AGENT_NAME`) | `ask_agent.sh`: predvolený adresát pri `--replies` a odosielateľ, keď nie je `AGENT_NAME` |
| `ASK_HOST`, `<ADRESÁT>_HOST` | (povinné na Macu) | `ask_agent.sh` z Macu: cieľ ssh `účet@adresa servera`, osobitný pre adresáta |
| `ASK_URGENT_ONLY`, `ASK_URGENT` | prázdne | adresáti (cez čiarku), ktorým z Macu smie ísť len súrna správa, a `1` pre súrnu správu |
| `ASK_WORKFLOW` | koreň repa skriptu | odkiaľ `ask_agent.sh` berie `route.mjs` |
| `TOPIC_STATE_DIR`, `TOPIC_MEMORY_DIR` | `.scratch/topics`, `memory` v repe agenta | stav a pamäť tém pre `hooks/topic.mjs` a `ask_agent.sh` (skúšky) |
| `AGENT_INBOX_HOSTS`, `AGENT_INBOX_OUTBOX` | prázdne, `/var/lib/<AGENT_NAME>/inbox` | `hooks/agent_inbox.mjs` (agent na Macu): adresy servera `účet@adresa` cez čiarku a jeho schránka; bez adries hook mlčí |
| `SERVER_WORK_AGENTS` | prázdne | `hooks/server_work.mjs`: mená agentov (cez čiarku), ktorých službu smie na serveri štartovať aj zástupca na Macu |
| `WEB_DESIGNER`, `WEB_MANUAL`, `WEB_MANUAL_BASE` | `designer`, `/home/<AGENT_TASKER_USER>/agenti/<dizajnér>/manualy/web.md`, `.../zaklad/` | brána mockupu `lib/web_gate.mjs` |
| `TK_USER`, `TK_HOME` | `AGENT_TASKER_USER` (inak `tasker`), `/home/<používateľ>/.tasker` | `bin/tk`: používateľ, pod ktorým beží `tasker`, a jeho databáza |

Kód Taskera a T3 (`/opt/tasker`) runtime
nenesie, len ich volá.

### Nový agent s hlavným vláknom

`agent_vlakno.sh <meno> "<Meno>" [--model M] [--repo R] [--thread ID] [--bez-behov]`
zriadi kľúč (aj jeho verejnú časť na `example-agent`), prístup do repa
(`github_repo.sh`), oba klony s `.githooks`, schránku, `runtime.env`,
`t3_token`, trasu hlavného agenta, budič a agenta v Taskeri. Je idempotentný, druhý
beh končí `zmien v tomto behu: 0`. Vlákno v T3 nezakladá, to robí správca agentov
nástrojmi MCP (`t3_project_create`, `t3_thread_launch`, pripnúť) a id
zapíše behom s `--thread`, ten vypne automatické odkladanie vlákna
skriptom `t3_autosettle.mjs` (príkaz `thread.auto-settle.set`, MCP ho
nemá). Postup
je skill `agent-vlakno`, skúška `test/agent_vlakno.test.mjs` beží
s predponou ciest `AV_ROOT` a podstavenými príkazmi bez živého systému.
Budiče iných agentov skript nereštartuje.

Voľba `--bez-behov` (osobný agent) preskočí klon behov pod
`AGENT_TASKER_USER` a agenta v Taskeri založí `disabled` s pracovným
priečinkom `/root/<meno>`, rovnako ako hlavný agent.

## Prehliadač

`browser.sh` spustí Chrome so sandboxom (`--no-sandbox` sa nepoužíva) a vráti
snímky obrazovky, text stránky a chyby konzoly. Pod rootom beží Chrome cez
`runuser` pod používateľom `AGENT_BROWSER_USER`. Pod bežným používateľom (agenti
Taskera) beží pod volajúcim, bez `runuser`, a `--user` iný než
volajúci skončí kódom 2 (úloha 579).

```
browser.sh (--url <url> | --file <html>) [--width 1440,390]
  [--height 900] [--full-page] [--text] [--gaps [px]]
  [--steps <súbor json | pole json>] [--out <priečinok>]
```

`--gaps [px]` po krokoch nájde texty nalepené pod sebou. Meria sa
samotný text (`Range.getClientRects()`, riadky jedného prvku zlúčené),
padding sa nepočíta. Dva texty, ktoré sa vodorovne prekrývajú nad 4 px
a nie sú predok a potomok, nesmú mať zvislú vzdialenosť pod `px`
(predvolene 6), záporná je prekrytie. Prvky na jednom riadku (vrch do
2 px), skryté prvky a `svg` sa preskočia. Nálezy idú do
`gaps-<šírka>.txt` a na výstup, každý s medzerou v px. Nález znamená kód 1. Logika je v `browser/gaps.mjs`,
skúška `test/gaps.test.mjs`.

Voľby `--user <meno>`, `--profile <názov>` a `--exec <skript.mjs>` (osobný
agent) spustia Chrome pod iným používateľom, s trvalým profilom v
`~<používateľ>/.local/share/agent-browser/profiles/<názov>` (práva 700, naraz jeden
beh) a s vlastným skriptom, ktorý otvorí prehliadač cez `browser/session.mjs`
(`openProfile`). Prostredie roota používateľ nedostane, premenné sa odovzdajú len
cez `--env NAME`. Skúšky sú v `test/browser.test.mjs`.

Predvolený `--out` je `scratch/browser/<čas>`, skript vypíše cesty
k súborom: `page-<šírka>.png`, `text-<šírka>.txt`, `console.txt`. Kroky
(`click`, `fill`, `press`, `wait`, `shot`) sú v hlavičke
`browser/browser.mjs`. Balík `playwright-core` (presná verzia
v `browser/package-lock.json`) skript nainštaluje do
`~<používateľ>/.cache/agent-browser` a pri zmene hashu zámku
preinštaluje. Prehliadače Playwright sú v `~<používateľ>/.cache/ms-playwright`
a ich verzia musí zodpovedať balíku. Skúška `test/browser.test.mjs`
beží na lokálnom HTML súbore.

## Tajomstvo od operátora

`secret_drop.sh --user <meno> --dir <priečinok> --field <súbor[:druh[:popis]]> ... [--serve]`
spustí jednorazovú stránku (`secret_drop.mjs`) na `127.0.0.1:8804`. S `--serve` ju
`tailscale serve --https=8804` na čas behu sprístupní v tailnete a po skončení cestu
zruší. operátor hodnotu vloží do poľa a stránka ju zapíše do súboru 600 pod používateľom,
bez výpisu a bez prepisu vlákna T3. Skill `tajomstvo-od-operatora`, skúška
`test/secret_drop.test.mjs`. Overené 24. 10. 2026 cez skutočný `tailscale serve`:
odkaz s platným certifikátom, zlý token 404, cesta po skončení zrušená.

## Nasadenie (správca servera)

Ako root:

0. Klony `agentic-workflow` (tento repo) a `agentic-brain-global` (spoločný mozog)
   v `/opt/` (`AGENT_WORKFLOW`, `AGENT_BRAIN_GLOBAL` menia cesty), v mozgu
   `env/server/config.env` podľa `env/server/config.env.example`. Potom
   `env/server/install.sh` z klonu kódu: `~/.claude/CLAUDE.md` rootu a
   používateľa behov (dva importy `RULES.md`), `CLAUDE.md` koreňa stromu agentov
   a domova používateľa behov ako odkaz na `env/server/RULES.md` mozgu, skilly
   z oboch klonov, `agents/`, `output-styles/`, `settings.json` z `env/hooks.mjs`,
   `user.email` a `core.hooksPath`, jednotky `agentic-workflow-sync.timer` a
   `.service` (každých 5 minút ťahá oba klony). Staré odkazy a jednotky z
   `LEGACY_PATHS` a `LEGACY_UNITS` odstráni, opakované spustenie nič nepokazí.
1. Skupina `agent-inbox`, člen `adam` (SSH zástupcu operátora z Macu),
   neskôr agenti servera, ktorí Adamovi píšu.
2. `systemd/agent-inbox.tmpfiles.conf` do `/etc/tmpfiles.d/agent-inbox.conf`
   a `systemd/mac-inbox.tmpfiles.conf` (schránka Cyrila `/var/lib/cyril`,
   rovnaká skupina) do `/etc/tmpfiles.d/mac-inbox.conf`,
   `systemd-tmpfiles --create`.
3. Klon repa agenta (`AGENT_GH_OWNER/agent-adam`) do `/root/adam` s kľúčom na push, token T3
   do `/root/.config/adam/t3_token` (600), `runtime.env` (600). Do
   `runtime.env` patrí `AGENT_REPLY_ROUTE_boris=/var/lib/boris/inbox` a
   `TASKER_HOME` Taskera na serveri (napríklad `/home/tasker-svc/.tasker`). Odpoveď
   príde Borisovi ako `adam-<správa>`, predponu mení `AGENT_REPLY_PREFIX`.
4. `node $AGENT_WORKFLOW/start_agent.mjs`, vypíše id vlákna.
5. Jednotky zo `systemd/` do `/etc/systemd/system/`, `systemctl
   daemon-reload`, `systemctl enable --now agent-driver@<adam>.service`.
   Udalosti Taskera zapne `systemctl enable --now
   agent-tasker-events.service`. Ranný súhrn beží cez plánovač T3
   (`morning.mjs --stdout`, časť "Ktorou cestou ide správa"),
   `agent-morning.timer` sa zapína len ako náhrada, keď plánovač T3 nebeží
   (`systemctl enable --now agent-morning.timer`, D0183).
6. Budenie agenta na Macu (úloha 466): `systemd/mac-wake.path`
   a `mac-wake.service` do `/etc/systemd/system/`, `systemctl enable --now
   mac-wake.path`. Pri zmene `/var/lib/cyril/inbox` spustí `mac_wake.sh`,
   ten pri novej správe `odpoveď: čakám` zavolá ako cyril webhook plánovanej
   úlohy T3 na Macu (URL v `/home/cyril/mac_webhook_url`, 600). Vybavené
   správy drží `/var/lib/mac-wake/notified`, po zlyhaní (Mac spí) skúsi
   znova pri ďalšej zmene schránky. Model na serveri sa nevolá.
7. Skúška: `ask_agent.sh adam adam_server "test"` z Macu (`bin/` klonu kódu),
   správa sa objaví vo vlákne, odpoveď príde cez `ask_agent.sh --replies`.

## Skúšky a kontrola mien

`node --test` v koreni repa spustí skúšky runtime aj `lib/public_check.test.mjs`
(Node 22.13 alebo novší, bez závislostí, falošný T3 server a dočasné priečinky,
živý systém sa nedotkne). Skúšky, ktoré volajú `ask_agent.sh` z repa pravidiel,
a skúšky prehliadača (`AGENT_BROWSER_USER` s nainštalovaným Chrome) sa bez nich
preskočia.

`./test/run.sh` spustí všetky testy repa (node testy, shellové testy, `test/brain/run.sh`,
`env/mac/install.test.sh`, `env/server/tests/run.sh`) a skončí pri prvom zlyhaní;
`./test/run.sh <súbor>...` len vybrané.

`node lib/public_check.mjs` prejde súbory repa a nahlási meno alebo adresu, ktoré
sem nepatria (vzory sú v `lib/public_check.txt` v base64), `--commits <rozsah>`
skontroluje meno autora a správy commitov. Hooky `.githooks/pre-commit` a
`.githooks/pre-push` ho spúšťajú, zapnutie: `git config core.hooksPath .githooks`.

## Mozog agentov (`brain/`)

`brain/` je šablóna mozgu: dáta, ktoré repo dostane (`RULES.md`, `artifacts/`,
`errors/REGISTER.md`, `decisions/`, `memory/MEMORY.md`, `scratch/`), a skripty
`brain/bin/` (`check.sh`, `adopt.sh`, `install.sh`, `decide.sh`, `pre-commit`,
`repeat_guard.mjs`). Kód mozgu ostáva v tomto repe a slúži repám bez kópie;
hook `repeat_guard.mjs` zapisuje do `settings.json` servera a Macu tabuľka `env/hooks.mjs`. Skilly
šablóny sú `skills/error` a `skills/task-end` tohto repa, nie `brain/skills/`.

Mozog má tri tvary:

| tvar | ako vznikne | čo je v cieli |
|---|---|---|
| repo s `agentic-brain/` (režim project, predvolený) | `brain/bin/adopt.sh <repo>` | len dáta: `agentic-brain/{RULES.md,skills/,artifacts/README.md,errors/REGISTER.md,decisions/README.md,memory/MEMORY.md,scratch/.gitkeep}`, symlinky `.claude/skills`, riadok `@agentic-brain/RULES.md` v `CLAUDE.md` a `AGENTS.md`, `.gitignore` |
| samostatná kópia pre cudzieho operátora | `adopt.sh --standalone <repo>` | navyše `agentic-brain/bin/`, skilly `error` a `task-end` a `.claude/settings.json` s `repeat_guard.mjs`; `install.sh --global` pridá import `RULES.md` a symlinky skillov do `~/.claude` |
| repo, ktorého celý obsah je mozog (režim global) | `adopt.sh --root <repo>` | `RULES.md`, `skills/`, `artifacts/`, `errors/`, `decisions/`, `memory/`, `scratch/` v koreni, `CLAUDE.md` s jediným riadkom `@RULES.md` |

`--project <cesta>` pridá k ľubovoľnému tvaru vrstvu projektu (riadok `project:` v
`RULES.md` a symlinky jej skillov). `adopt.sh` nič nezapíše do existujúcich súborov a nič
nescommituje.

Kontrola a hook sa spúšťajú z tohto repa s cieľom, kópia v cieli netreba:

```
brain/bin/check.sh [<repo alebo priečinok mozgu>]            # bez cieľa mozog, v ktorom skript leží
brain/bin/check.sh --install-hook [<repo>]                   # pre-commit hook repa
brain/bin/install.sh [<repo>]                                # check.sh <repo> a hook, bez cieľa repo z pracovného priečinka
```

Cieľ je koreň repa (mozog v `agentic-brain/`) alebo priečinok mozgu v koreni repa; folder
bez `RULES.md` a `errors/REGISTER.md` skončí chybou. Hook zapísaný do `.git/hooks`
volá `check.sh` z `bin/` mozgu repa, ak ho má, inak `check.sh` s absolútnou cestou
zapísanou pri inštalácii. Skill s riadkom `scripts: none` v hlavičke musí mať aj neprázdny
riadok `scripts-reason:` a `scripts/` nepotrebuje, inak má `scripts/` aspoň jeden súbor.
`skills/task-end/scripts/task-end.sh` spustí `check.sh` pre repo pracovného priečinka a
vypíše kontrolný zoznam z `RULES.md` mozgu, repo bez mozgu skončí kódom 1.

Register chýb zapisuje `skills/error/scripts/error.sh` (časť Skripty a knižnice).

### `requires:` hookov a mŕtvy kód

Druhý riadok každého hooku v `hooks/` (okrem testov a `*.replay.mjs`) je
`// requires: <hodnota>`: `none`, `tasker` (hook volá `tk` alebo `tasker`, číta databázu
Taskera alebo stráži jeho príkazy), `t3` (klient T3 alebo id vlákna T3), `inbox` (schránky
v `/var/lib`) alebo `mac` (hook len pre Mac). Viac hodnôt sa píše cez čiarku (`tasker, t3`),
`none` je vždy samo. Hodnotu určuje import a kód hooku, nie jeho názov. `node check.mjs`
nahlási hook bez riadku alebo s inou hodnotou (`lib/hook_requires.mjs`).

`node check.mjs` stráži aj mŕtvy kód (`lib/dead_code.mjs`): každý súbor `.mjs` a `.sh`
v `hooks/`, `lib/`, `bin/`, `brain/bin/`, `skills/*/scripts/` a v koreni repa musí byť
niekde mimo seba a mimo testov (`*.test.*`, `*.replay.mjs`, `test/`) importovaný, volaný
alebo menovaný v kóde, skripte, konfigurácii, systemd alebo v `SKILL.md`; zmienka v
README a v ostatných `.md` nestačí. Výnimka je riadok `<cesta> <dôvod>` v
`lib/dead_code_allow.txt`; výnimka bez dôvodu, na neexistujúci súbor alebo na súbor,
ktorý mŕtvy nie je, je chyba. Hook zapísaný v tabuľke `env/hooks.mjs` je menovaný,
hook mimo tabuľky potrebuje výnimku s dôvodom.

## Mapa repa

Repo je kód agentov: pravidlá, skilly, hooky, runtime a nasadenie prostredia. Dáta
nasadenia (mená, adresy, rozhodnutia, register chýb, zoznam agentov) sú v druhom repe,
v spoločnom mozgu (`AGENT_BRAIN_GLOBAL`). Cesty v tabuľkách sú relatívne ku koreňu repa.

### Pravidlá a roly

| cesta | čo to je |
|---|---|
| `RULES.md` | globálne pravidlá každého agenta, importuje ich `~/.claude/CLAUDE.md` (spolu s `RULES.md` mozgu) |
| `roles/ROLES.md` | zoznam rolí a pravidlo, že pravidlo hovorí o role, nie o mene agenta |
| `roles/*.md` | pravidlá jednej roly (`zastupca-operatora`, `spravca-agentov`, `spravca-servera`, `veduci-vyvoja`, `prva-linia`, `pracovny-agent`, `dizajner`, `osobny-asistent`); zoznam agentov podľa rolí je `roles/agents.md` v mozgu |
| `output-styles/operator.md` | output style `operator` (vyberá ho `outputStyle` v `settings.json`) |

### Skilly a agenti

| cesta | čo to je |
|---|---|
| `skills/<meno>/SKILL.md` | skill, nasadí ho `env/*/install.sh` odkazom do `~/.claude/skills`; skilly mozgu sú v jeho `skills/`, rovnaké meno v oboch je chyba |
| `skills/error/scripts/error.sh` | zápis uznanej chyby do registra mozgu |
| `skills/dokonci/scripts/dokonci.sh` | mechanické kroky skillu `dokonci` (ledger, merge `dev` do `main`) |
| `skills/task-end/scripts/task-end.sh` | koniec úlohy: kontrola mozgu a kontrolný zoznam |
| `agents/implementator.md` | definícia sub-agenta `implementator` (model `sonnet`), nasadí sa do `~/.claude/agents` |

### Mozog (šablóna)

| cesta | čo to je |
|---|---|
| `brain/` | šablóna mozgu: `RULES.md`, `artifacts/`, `errors/REGISTER.md`, `decisions/`, `memory/MEMORY.md`, `scratch/` (časť Mozog agentov) |
| `brain/bin/` | `check.sh`, `adopt.sh`, `install.sh`, `decide.sh`, `pre-commit`, `repeat_guard.mjs` |

### Hooky

| cesta | čo to je |
|---|---|
| `hooks/<hook>.mjs` | hook relácie claude; druhý riadok `// requires:` hovorí, čo hook potrebuje (`none`, `tasker`, `t3`, `inbox`, `mac`) |
| `hooks/*.test.mjs`, `hooks/guard.replay.mjs` | testy hookov a replay chyby |
| `env/hooks.mjs` | jediná tabuľka hookov: udalosť, matcher, timeout, requires a kde beží (`main`, `runs`, `mac`, `agent`); z nej píšu `settings.json` oba `install.sh` |
| `env/hooks.test.mjs` | test tabuľky: hook existuje, `requires` sedí s hlavičkou, každý hook je v tabuľke alebo v `lib/dead_code_allow.txt` |
| `git-hooks/global/` | globálne git hooky (`core.hooksPath` rootu a Macu), spúšťajú lokálny hook repa |
| `git-hooks/enable_repo_hooks.sh` | zapne globálne hooky lokálne v klonoch z `repo_authors.txt` mozgu |
| `agent-githooks/`, `.githooks/` | git hooky repa agenta a tohto repa (`public_check`, `check.mjs`) |

### Knižnice a kontroly

| cesta | čo to je |
|---|---|
| `lib/*.mjs`, `lib/*.sh` | knižnice hookov a skriptov: cesty ku klonom (`paths.mjs`, `paths.sh`), prostredie agenta (`agent_env.mjs`, `agent_name.mjs`), zamietnutie (`deny.*`), register rozhodnutí, kontroly (`public_check`, `path_check`, `dead_code`, `hook_requires`, `rule_dupes`, `word_cap`) |
| `lib/*.txt` | dáta kontrol: `public_check.txt`, `retired_*.txt`, `dead_code_allow.txt`, `rule_dupes_allow.txt`, `global_word_cap.txt`, vzory `git_email.txt` a `repo_authors.txt` |
| `check.mjs` | kontrola celého nasadenia: skilly, nastavenie z `env/hooks.mjs`, pravidlá, mŕtvy kód, zrušené mená |

### Skripty

| cesta | čo to je |
|---|---|
| `bin/tk` | obal `tasker` (používateľ a databáza podľa prostredia) |
| `bin/ask_agent.sh`, `bin/kontext.sh`, `bin/rozhodni.sh`, `bin/uloha-webu.sh` | správa inému agentovi, odovzdávka čistého kontextu, zápis rozhodnutia, úloha agentovi webu |
| `agent_vlakno.sh`, `github_repo.sh`, `github_device_login.sh`, `start_agent.mjs`, `setup_token.sh` | zriadenie agenta: kľúč, repo, vlákno T3, token |
| `browser.sh`, `browser/` | Chrome so sandboxom pre `browser.sh --gaps` |
| `secret_drop.sh`, `secret_drop.mjs` | jednorazová stránka na odovzdanie tajomstva |

### Runtime

| cesta | čo to je |
|---|---|
| `driver.mjs`, `lib.mjs`, `kontext.mjs`, `supervise.mjs`, `stuck.mjs`, `clear_watch.mjs`, `t3_autosettle.mjs` | budič (schránka do vlákna T3), klient T3, dozor behu, čistý kontext |
| `reply.sh`, `route.mjs` | odpoveď zo schránky a trasa odpovede do vlákna témy |
| `tasker_events.mjs`, `morning.mjs` | udalosti Taskera a ranný súhrn do schránky |
| `mac_wake.sh` | zobudenie agenta na Macu webhookom T3 |
| `systemd/` | šablóny jednotiek budiča, udalostí, ranného súhrnu a budenia Macu, `tmpfiles.d` schránok; `ExecStart` ide cez `${AGENT_WORKFLOW}` z `runtime.env`, predvolba `/opt/agentic-workflow` je v jednotke pred `EnvironmentFile` |

### Prostredie

| cesta | čo to je |
|---|---|
| `env/server/install.sh` | nasadenie na server (root): importy pravidiel, skilly, agenti, `settings.json` z `env/hooks.mjs` (`main` root, `runs` používateľ behov), git (aj `agentic.readonly true` v živých klonoch kódu a mozgu, `error.sh` do nich nezapíše), jednotky sync |
| `env/server/sync.sh` | časovač ťahá klon kódu aj mozgu a hlási zmenu `RULES.md` oboch a `env/server/` mozgu |
| `env/server/systemd/` | `agentic-workflow-sync.service` a `.timer` (šablóna so zástupnými znakmi, `install.sh` ich nahradí cestami klonov) |
| `env/server/config.env.example` | vzor `<mozog>/env/server/config.env` (`RUNS_USER`, `GIT_EMAIL`, `ENV_ROOT`, `LEGACY_PATHS`, `LEGACY_UNITS`) |
| `env/server/tests/` | testy `install.sh` a `sync.sh` v dočasných priečinkoch (`run.sh` spustí shellcheck aj testy) |
| `env/mac/install.sh` | nasadenie na Mac: importy pravidiel, `~/Work/CLAUDE.md`, skilly, agenti, `settings.json` z `env/hooks.mjs` (`mac`), gitignore, kontrola |
| `env/mac/install.test.sh` | test `install.sh` Macu s `HOME` v dočasnom priečinku |
| `env/mac/gitignore` | globálny gitignore Macu |

### Dokumentácia a testy

| cesta | čo to je |
|---|---|
| `docs/PLAYBOOK.md`, `docs/PLAYBOOK.en.md` | verejný playbook: ako postaviť agentov s pamäťou, pravidlami a hookmi |
| `docs/decisions-schema.md` | schéma záznamov rozhodnutí a rozsahov moci |
| `test/*.test.mjs` | testy runtime, hookov a skriptov, falošný T3 server `test/fake_t3.mjs` |
| `test/brain/` | testy mozgu (`adopt`, `check`, `install`, `task_end` a `repeat_guard`) |
| `test/fixtures/` | fixtúry registra rozhodnutí |
| `test/run.sh` | jediný spúšťač všetkých testov (bez živého systému) |
| `LICENSE` | licencia |

### Premenné nasadenia

| premenná | význam |
|---|---|
| `AGENT_WORKFLOW`, `AGENT_BRAIN_GLOBAL` | klon tohto repa a klon spoločného mozgu (predvolene `/opt/agentic-workflow` a `/opt/agentic-brain-global`, na Macu `~/Work/...`) |
| `AR_CLAUDE_DIR`, `AR_ENV_ROOT`, `AR_RUNS_HOME`, `AR_UNIT_DIR` | cesty `env/server/install.sh` pre test: `~/.claude` rootu, koreň stromu agentov, domov používateľa behov, jednotky systemd |
| `AR_NO_SYSTEMCTL`, `AR_SYSTEMCTL` | `1` vypne `systemctl` v `install.sh`; príkaz namiesto `systemctl` (test), `AR_UNIT_DIR` bez neho `systemctl` nevolá |
| `AR_BACKUPS`, `AR_NO_CHECK` | `env/mac/install.sh`: priečinok záloh a `1` vynechá `check.mjs` |
| `AR_CLONES`, `AR_INBOXES` | `env/server/sync.sh`: dva klony (kód, mozog) a schránky pre správu `pravidla-*` |
| `AR_READONLY_DIRS` | `deploy_readonly.mjs`: cesty (cez `:`), ktoré hook chráni namiesto `/opt/tasker` a klonov |
| `AR_PROJECT_ROOTS` | `project_branch.mjs`: priečinky repí projektov (cez `:`) |

Hodnoty s menami (používateľ behov, e-mail, staré cesty a jednotky) berie `install.sh`
len z `<mozog>/env/server/config.env` a `<mozog>/env/mac/config.env`, alebo z `runtime.env`.
Voliteľný `<mozog>/env/<prostredie>/settings.base.json` doplní do `settings.json` kľúče
mimo hookov (pluginy, jazyk), existujúca hodnota vyhráva.
