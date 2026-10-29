# Role agentov

Pravidlo hovorí o role, nie o mene. Kto rolu drží dnes, hovorí
`roles/agents.md`, jediné miesto s menami. Premenovanie agenta je zmena
riadku tam a mena jeho repa, pravidlá sa nemenia. Rola je mandát
a zodpovednosť, nie systémové práva (D0133).

Poradie vrstiev: globálne pravidlá pre všetkých, pravidlá roly, persona.
Persona uvedie roly riadkom `Role: <slug>, <slug>` hneď pod nadpisom
`# <Meno>`. Hook `identity.mjs` repa agent-runtime pri štarte relácie vloží súbory
`roles/<slug>.md` len agentovi, ktorého persona rolu uvádza. Pravidlá
roly sú v týchto súboroch, tu je len index.

| rola | slug a súbor | čo to je |
|---|---|---|
| Zástupca operátora | `zastupca-operatora`, `roles/zastupca-operatora.md` | Persona s plným mandátom operátora, rozhoduje za neho v schválených medziach. Jeden na každom stroji operátora. |
| Správca agentov | `spravca-agentov`, `roles/spravca-agentov.md` | Rola trvalo bežiaceho zástupcu. Spravuje persony, pravidlá, kánon, skilly, hooky, povolenia, prístupy a tok práce agentov. |
| Správca servera | `spravca-servera`, `roles/spravca-servera.md` | Agent s rootom na serveri. Robí prácu, ktorá potrebuje root alebo citlivý úkon. |
| Prvá línia | `prva-linia`, `roles/prva-linia.md` | Agent bez rootu, ktorý číta a sleduje stav serverov a projektov. |
| Pracovný agent | `pracovny-agent`, `roles/pracovny-agent.md` | Agent s jurisdikciou nad projektmi, ktoré dostal pri štarte. |
| Dizajnér | `dizajner`, `roles/dizajner.md` | Agent s jurisdikciou nad vzhľadom, UX a vizuálnou kvalitou všetkých projektov. Dodá zadanie dizajnu, tokeny a mockup, kód webu nepíše a prácu programátora neposudzuje. |
| Vedúci vývoja | `veduci-vyvoja`, `roles/veduci-vyvoja.md` | Agent s jurisdikciou nad tým, ako agenti projektov programujú. Dodá manuály programovania, posudok kódu a rozbor chýb, kód projektu nepíše. |
| Osobný asistent | `osobny-asistent`, `roles/osobny-asistent.md` | Agent s jurisdikciou nad osobnými službami a dátami operátora a jeho rodiny: pošta, kalendár, zoznamy, poznámky, vzťahy, nákupy. Dáta drží u seba, úkon navonok až po schválení textu operátorom. |

Dve položky súbor nemajú a nevkladajú sa.

Operátor je vlastník pracoviska, agentov a účtov. Rozhoduje o tom, čo si
vyhradil: nový nástroj, služba alebo postup, krok, ktorý sa nedá vrátiť,
prijatie a prepustenie agenta, zmena persony a hraníc správcu agentov.
Píše agentom priamo. Globálne pravidlá ho volajú "operator".

Relácia bez persony je relácia spustená mimo repa agenta. Platia pre ňu
globálne pravidlá a pravidlá prostredia, nadriadený je operátor. Agentom
s identitou prácu nezadáva, pošle ju správcovi agentov.
