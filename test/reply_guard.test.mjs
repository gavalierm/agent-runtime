#!/usr/bin/env node
// Testy reply_guard.mjs. Prvý prípad je odpoveď vlákna domov z 22. 10. 2026,
// ktorú operátor dostal s odkazom na web, ktorý ešte nebežal.

import { deadLinks, resolveArgs, deferredCheck, detailRequested, intentProblem, unverifiedPlan, localLinks, taskLinks, prose, replyProblem, sentences } from "../hooks/reply_guard.mjs";

// Odpoveď vlákna témy projektu z 28. 10. 2026 (úloha 636): štyri vety o tom,
// čo nenapísalo, neposlalo a nevedelo zistiť. Operátor: agenti majú byť struční a vecní.
const REAL28 = "[Úloha 636](https://x.ts.net:8801/tasks/636) patrí správcovi agentov, je riešiteľ, a v tejto relácii nemám jeho identitu, takže rozhodnutie cez `rozhodni.sh` ani odpoveď v úlohe pod jeho menom nepíšem a správu som mu ani nepreposlal. "
  + "Tvoja námietka podľa mňa platí aj mimo tejto úlohy: odpoveď od klienta dokazuje, že schránka info@example.sk poštu prijíma, a správca agentov mal najprv pozrieť dôkaz, ktorý už bol k dispozícii, a až potom písať neoverené.\n\n"
  + "Úloha čaká na správcu agentov v stave handoff. Nevedel som zistiť, či mu Tasker túto správu doručil aj do jeho vlákna.";
const SHORT28 = "[Úloha 636](https://x.ts.net:8801/tasks/636) nepatrí mne, ale správcovi agentov. Ja ju neriešim a doručenie správy sem je chyba workflow.";
const CHYBA = "Tvrdil alebo urobil som: že schránka je neoverená.\nPravda bola: klient odpísal hneď.\nZmenil sa súbor hooks/reply_guard.mjs, commit abc1234.\nNabudúce to zastaví: hook reply_guard.mjs.\n\nHotovo, commit abc1234.";

const REAL = "Spustil som to cez Tasker a agent domov-web beží na modeli Sonnet sám, bez teba.\n\n"
  + "Úloha 353 je audit súčasného webu a už beží. Doslovne vypíše všetky texty, frázy, kontakty a ponuky a k tomu farebnú paletu v hex a písma. "
  + "Doplní aj obrázky do archívu, lebo po prepnutí domény starý web zmizne. Výsledok bude v `projekt/audit-webu.md`.\n\n"
  + "Úloha 354 je nová verzia webu na https://dev.domov.example a začne, keď audit skončí. Texty prevezme doslovne z auditu, farby zachová, dizajn bude nový. "
  + "Na dev doméne bude značka noindex, aby ju nenašli vyhľadávače. Pošta a súčasný web na domov.example ostanú bez zmeny. "
  + "Preklepy a zastarané údaje agent neopraví sám, zapíše ich do README ako otázky pre klienta.\n\n"
  + "Moja úloha 351 (presun do Cloudflare a nový web) je zablokovaná, kým nie je hotová úloha 354. Potom sa na dev verziu pozrieš a rozhodneš o prepnutí hlavnej domény.";

const status = "Hotovo:\n" + Array.from({ length: 4 }, (_, i) => `- úloha ${i + 1} je zavretá`).join("\n")
  + "\n\nBeží:\n" + Array.from({ length: 3 }, (_, i) => `- agent ${i + 1} píše testy`).join("\n")
  + "\n\nČaká na teba:\n" + Array.from({ length: 3 }, (_, i) => `- rozhodnutie ${i + 1} (rozhodnutie)`).join("\n");

const forty = Array.from({ length: 40 }, (_, i) => `slovo${i}`).join(" ");

let bad = 0;
// [text, čo musí dôvod obsahovať, alebo null pre prejde]
const cases = [
  [REAL, "viet prózy"],
  ["Token platí do 31. 12. 2026, overené 22. 10. o 18:20. Čaká Zone: Edit.", null],
  [status, null],
  ["Stav:\n- Prvá vec je hotová. Druhá vec tiež.\n- Tretia vec beží.", "položka zoznamu"],
  [`Verdikt je nie. ${forty}.`, "40 slovami"],
  [`Stav:\n- ${forty}`, "40 slovami"],
  ["Hotovo, commit abc123.\n\nunslop: slovník prešiel. Tento riadok sa nepočíta. A ani tento.\nidentita: Adam, role x. Aj tento riadok.\nČaká na teba: nič. Ani toto.\nHOTOVO-KONTEXT", null],
  ["Hotovo, commit abc123.\n\nHOTOVO-KONTEXT pokracuj 0123456789abcdef", null],
  ["Jedna. Dve. Tri.\nHOTOVO-KONTEXT pokracuj 0123456789abcdef", null],
  ["Jedna. Dve. Tri.", null],
  ["Jedna. Dve. Tri. Štyri.", "4 viet"],
  [REAL28, "4 viet"],
  [SHORT28, null],
  [CHYBA, null],
  ["Pozri napr. súbor a t. j. cestu, tzv. mapu, resp. index, atď. Je to jedna veta, str. 5, č. 3 a s. 7.", null],
  ["Jedna. Dve. Tri.\n\n```\nJedna. Dve. Tri. Štyri. Päť. Šesť. Sedem. Osem.\n```\n\n# Nadpis\n| a | b |\n", null],
  ["Jedna. Dve. Tri. `Štyri. Päť. Šesť.`", null],
];
// Operátor žiadal podrobnosti: strop 6.
const detail = [
  ["Jedna. Dve. Tri. Štyri. Päť. Šesť.", null],
  ["Jedna. Dve. Tri. Štyri. Päť. Šesť. Sedem.", "7 viet"],
];
for (const [text, want] of detail) {
  const got = replyProblem(text, null, { maxSentences: 6 });
  const ok = want === null ? got === null : typeof got === "string" && got.includes(want);
  if (!ok) { bad++; console.log(`✗ podrobnosti: chcem ${want}, mám ${got}: ${text.slice(0, 40)}`); }
}
const asked = [
  ["Vysvetli mi, prečo to tak je.", true],
  ["Napíš postup nasadenia.", true],
  ["Daj mi podrobnosti k úlohe 5.", true],
  ["Explain the steps.", true],
  ["Preco pises ze je to neoverene, ked kubo odpisal hned?", false],
  ["Je to hotové?", false],
  ["Pozri `postup.md` a povedz áno/nie.", false],
];
for (const [text, want] of asked) {
  if (detailRequested(text) !== want) { bad++; console.log(`✗ žiadosť o podrobnosti: chcem ${want}: ${text}`); }
}
for (const [text, want] of cases) {
  const got = replyProblem(text);
  const ok = want === null ? got === null : typeof got === "string" && got.includes(want);
  if (!ok) { bad++; console.log(`✗ chcem ${want}, mám ${got}: ${text.slice(0, 60)}`); }
}

// Pomocné funkcie.
const unit = [
  [JSON.stringify(sentences("Dňa 22. 10. 2026 sme začali. Je to č. 5, napr. 3. krok! Naozaj? Áno.")), JSON.stringify(["Dňa 22. 10. 2026 sme začali.", "Je to č. 5, napr. 3. krok!", "Naozaj?", "Áno."])],
  [JSON.stringify(sentences("Súbor audit.md je v docs/. Adresa dev.x.sk beží.")), JSON.stringify(["Súbor audit.md je v docs/.", "Adresa dev.x.sk beží."])],
  [prose("Ahoj `kód` svet.\n- položka\n1. druhá\n# nadpis\n| t |\n```\nx\n```\nKoniec."), "Ahoj  svet.\n\nKoniec."],
  [prose("unslop: ok\nidentita: x\nČaká na teba: nič\nPríkaz pre teba, lebo x\nHOTOVO-KONTEXT"), ""],
  [prose("Hotovo.\nHOTOVO-KONTEXT spanok 0123456789abcdef"), "Hotovo."],
];
for (const [got, want] of unit) {
  if (got !== want) { bad++; console.log(`✗ chcem ${want}, mám ${got}`); }
}

// Odkazy. Sonda je podvrh, sieť sa nepoužije.
const calls = [];
const probeOf = (r) => (url) => { calls.push(url); if (r instanceof Error) throw r; return r; };
const links = [
  ["Web: https://a.sk/x.", probeOf(200), false],
  ["Web: https://a.sk/x.", probeOf(404), true],
  ["Web: https://a.sk/x.", probeOf(new Error("certifikát")), true],
  ["Web: https://a.sk/x.", probeOf(403), false],
  ["Web: https://a.sk/x.", probeOf(401), false],
  ["Web: https://a.sk/x.", probeOf(500), true],
  ["Príklad:\n```\ncurl https://a.sk/x\n```", probeOf(404), false],
  ["Príklad `https://a.sk/x` v kóde.", probeOf(404), false],
  ["Server http://gma.lan:8080/x a http://localhost:3000 a http://127.0.0.1/a.", probeOf(404), false],
  ["Web [odkaz](https://a.sk/x) a bez zátvorky.", probeOf(404), true],
];
for (const [text, probe, want] of links) {
  const got = deadLinks(text, probe);
  if (Boolean(got) !== want) { bad++; console.log(`✗ odkaz: chcem ${want}, mám ${got}: ${text.slice(0, 50)}`); }
}
calls.length = 0;
deadLinks("https://a.sk/x a znova https://a.sk/x, https://a.sk/x.", probeOf(200));
if (calls.length !== 1) { bad++; console.log(`✗ rovnaká adresa sa mala skontrolovať raz, volaní ${calls.length}`); }
const msg = deadLinks("https://dev.domov.example", probeOf(new Error("certifikát")));
if (!msg?.includes("adresa https://dev.domov.example dnes neodpovedá (certifikát)")) { bad++; console.log(`✗ text dôvodu: ${msg}`); }

// Odložené overenie. [text, má zastaviť]
const deferred = [
  ["Či sa dá premenovať na \"tasker\", som neoveril, zistí sa pri nasadení.", true],
  ["Zistí sa pri nasadení.", true],
  ["Overí sa pri nasadení.", true],
  ["Overíme to pri nasadení.", true],
  ["Ukáže sa až pri prvom štarte.", true],
  ["Overí sa pri prvom behu.", true],
  ["Zistíme po nasadení.", true],
  ["We'll verify on deploy.", true],
  ["We will find out at deployment.", true],
  ["Will find out at deployment.", true],
  ["Verify after deploying.", true],
  ["Pri nasadení sa ukáže, či to ide.", true],
  ["Stav:\n- Port overíme pri nasadení.", true],
  ["Nasadenie prebehlo, overil som ho curl.", false],
  ["Pri nasadení som overil port.", false],
  ["Overené pred nasadením.", false],
  ["I verified it before deploy.", false],
  ["Verified on the test instance, deploy is next.", false],
  ["Spustím `overí sa pri nasadení` a hotovo.", false],
  ["Príklad:\n```\n# zistí sa pri nasadení\n```", false],
];
for (const [text, want] of deferred) {
  const got = deferredCheck(text);
  if (Boolean(got) !== want) { bad++; console.log(`✗ odklad: chcem ${want}, mám ${got}: ${text.slice(0, 60)}`); }
}
const dmsg = deferredCheck(deferred[0][0]);
if (!dmsg?.startsWith("odklad overenia na nasadenie: \"") || !dmsg.includes("Overenie uskutočniteľnosti patrí pred návrh alebo rozhodnutie.")) { bad++; console.log(`✗ text dôvodu odkladu: ${dmsg}`); }

// Neoverená položka v návrhu. [text, má zastaviť]
const unverified = [
  ["Viktor:\n\nDruhá verzia návrhu je v `docs/navrh-znalosti.md`. Skúškou som overil, že sub-agent `CLAUDE.md` dostane, prompt Taskera však nie. Či hook vystrelí aj na commit sub-agenta, je zatiaľ neoverené.", true],
  ["Hlavný nález je v zozname. Neoverené: či klon sa aktualizuje. Ak návrh schváliš, zapíšem ho do `manualy/README.md`.", true],
  ["Príčina neoverená, pozriem log.", false],
  ["Návrh: X. Všetko som overil curl.", false],
  ["Návrh: X. Či klon sa aktualizuje, je neoverené a nedá sa overiť bez nasadenia. Návrh nie je pripravený na schválenie.", false],
  ["Návrh: X. Či klon sa aktualizuje, je neoverené a nedá sa overiť bez nasadenia. Ak návrh schváliš, zapíšem ho.", true],
  ["Návrh: X. Hook `neoverené` je v kóde.", false],
  ["Proposal attached. Whether the hook fires is unverified.", true],
  ["Please approve. I haven't verified the clone refreshes.", true],
  ["The cause is not yet verified, checking the log.", false],
  ["Plan: X. Everything was verified with curl.", false],
];
for (const [text, want] of unverified) {
  const got = unverifiedPlan(text);
  if (Boolean(got) !== want) { bad++; console.log(`✗ neoverený návrh: chcem ${want}, mám ${got}: ${text.slice(0, 60)}`); }
}
const umsg = unverifiedPlan(unverified[0][0]);
if (!umsg?.startsWith("neoverená položka v návrhu: \"") || !umsg.includes("RULES.md §1")) { bad++; console.log(`✗ text dôvodu neoverenej položky: ${umsg}`); }

// Lokálne adresy. [text, platforma, má zastaviť]
const local = [
  ["Web: http://127.0.0.1:8801/tasks/7", "linux", true],
  ["Web: http://localhost:3773", "linux", true],
  ["Web: http://0.0.0.0:80/x a http://[::1]:8801/", "linux", true],
  ["Web: http://[::1]:8801/", "linux", true],
  ["Web: http://127.0.0.1:8801/tasks/7", "darwin", false],
  ["Web: http://localhost:3773", "darwin", false],
  ["Príklad `http://localhost:3773` v kóde.", "linux", false],
  ["Príklad:\n```\ncurl http://127.0.0.1:8801/x\n```", "linux", false],
  ["Web: https://host.example.ts.net:8801", "linux", false],
];
for (const [text, platform, want] of local) {
  const got = localLinks(text, platform);
  if (Boolean(got) !== want) { bad++; console.log(`✗ lokálna adresa: chcem ${want}, mám ${got}: ${text.slice(0, 50)}`); }
}
const lmsg = localLinks("Web: http://127.0.0.1:8801/tasks/7.", "linux", "https://host.example.ts.net:8801");
if (!lmsg?.startsWith("adresa http://127.0.0.1:8801/tasks/7 je localhost servera") || !lmsg.includes("napríklad https://host.example.ts.net:8801.")) { bad++; console.log(`✗ text dôvodu lokálnej adresy: ${lmsg}`); }
// Bez TASKER_WEB_URL (alebo s localhostom) je v príklade zástupný text, nie localhost.
for (const web of [undefined, "http://127.0.0.1:8801"]) {
  const m = localLinks("Web: http://127.0.0.1:8801/tasks/7.", "linux", web);
  if (!m?.includes("napríklad https://<host>.<tailnet>.ts.net:8801.")) { bad++; console.log(`✗ zástupný text adresy pre ${web}: ${m}`); }
}

// --resolve pre *.ts.net. [url, lookup, čakané argumenty]
const resolves = [
  ["https://host.example.ts.net:8801/tasks/7", () => "100.64.0.7", ["--resolve", "host.example.ts.net:8801:100.64.0.7"]],
  ["https://host.example.ts.net/x", () => "100.64.0.7", ["--resolve", "host.example.ts.net:443:100.64.0.7"]],
  ["http://host.example.ts.net/x", () => "100.64.0.7", ["--resolve", "host.example.ts.net:80:100.64.0.7"]],
  ["https://host.example.ts.net/x", () => null, []],
  ["https://a.sk/x", () => { throw new Error("nemalo sa volať"); }, []],
];
for (const [url, lookup, want] of resolves) {
  const got = resolveArgs(url, lookup);
  if (JSON.stringify(got) !== JSON.stringify(want)) { bad++; console.log(`✗ resolveArgs ${url}: ${JSON.stringify(got)}`); }
}

// Zmienky úloh Taskera. [text, má zastaviť]
const B = "https://host.example.ts.net:8801";
const task = [
  ["Hotová je úloha 380.", true],
  ["Úloha 380 je hotová.", true],
  ["Hotové sú úlohy 372, 373 a 374.", true],
  ["Zadal som úlohy 369 a 370.", true],
  ["K úlohe #380 pribudol komentár.", true],
  ["Moja úloha #380 beží.", true],
  ["Podľa task 7 je to tak.", true],
  ["Tasker #7 stojí.", true],
  ["Stav:\n- úloha 5 je zavretá", true],
  [`Hotová je [úloha 380](${B}/tasks/380).`, false],
  [`Hotová je úloha [380](${B}/tasks/380).`, false],
  [`Hotové sú úlohy [372](${B}/tasks/372), [373](${B}/tasks/373) a [374](${B}/tasks/374).`, false],
  [`Hotové sú úlohy [372](${B}/tasks/372) a 373.`, true],
  [`Hotová je úloha 380 (${B}/tasks/380).`, false],
  [`Hotová je úloha 380: ${B}/tasks/380`, false],
  [`Hotová je [úloha 380](${B}/tasks/381).`, true],
  [`Hotová je úloha 380 (${B}/tasks/381).`, true],
  ["Hotová je `úloha 380`.", false],
  ["Príklad:\n```\núloha 380 je hotová\n```", false],
  ["Zavrel som 51 úloh.", false],
  ["Zavrel som 51 úloh a ďalších 3.", false],
  ["Úloha 380, 12 agentov beží.", true],
  ["Správca úloh beží.", false],
  [`Pozri [úloha 380](${B}/tasks/380) a 51 úloh spevníka.`, false],
  [`Pozri [úloha 380](${B}/tasks/380) a 51 tasks.`, false],
  [`Pozri [úloha 380](${B}/tasks/380) a 52.`, false],
  ["Úlohy 372 a 51 úloh spevníka.", true],
  ["Zavrel som úlohy 372 a 373 a 51 úloh spevníka.", true],
  ["V /opt/tasker beží Tasker 49c70c8 nasadený.", false],
  ["Tasker e3a3401 je nasadený.", false],
  ["Tasker 49c70c8 a úloha 386 bez odkazu.", true],
  ["Nasadil som Tasker 8581310.", false],
  ["Commit 1234567 a úloha 408 bez odkazu.", true],
  ["úloha 408", true],
];
for (const [text, want] of task) {
  const got = taskLinks(text, B);
  if (Boolean(got) !== want) { bad++; console.log(`✗ úloha: chcem ${want}, mám ${got}: ${text.slice(0, 50)}`); }
}
const tmsg = taskLinks("Hotové sú úlohy 372, 373 a 374 a úloha #380.", B);
for (const frag of [`úlohy 372, 373 a 374 -> úlohy [372](${B}/tasks/372), [373](${B}/tasks/373) a [374](${B}/tasks/374)`, `úloha #380 -> [úloha #380](${B}/tasks/380)`]) {
  if (!tmsg?.includes(frag)) { bad++; console.log(`✗ text dôvodu úlohy: chýba "${frag}" v ${tmsg}`); }
}
if (!taskLinks("úloha 7", "https://x.test/")?.includes("[úloha 7](https://x.test/tasks/7)")) { bad++; console.log("✗ základ adresy z parametra"); }
{
  const old = process.env.TASKER_WEB_URL;
  process.env.TASKER_WEB_URL = "https://env.test:9";
  const e = taskLinks("úloha 7");
  if (old === undefined) delete process.env.TASKER_WEB_URL; else process.env.TASKER_WEB_URL = old;
  if (!e?.includes("[úloha 7](https://env.test:9/tasks/7)")) { bad++; console.log(`✗ základ adresy z TASKER_WEB_URL: ${e}`); }
}

const named = [
  ["Adam:\n\nHotovo.", "Adam", null],
  ["Adam: \n\nText.", "Adam", null],
  ["  \nAdam:\n\nHotovo.", "Adam", null],
  ["Adam:\nHotovo.", "Adam", "prázdny riadok"],
  ["Adam:\n \nHotovo.", "Adam", null],
  ["Adam:", "Adam", null],
  ["Adam: Hotovo.", "Adam", "samotné \"Adam:\""],
  ["Hotovo.", "Adam", "nezačína menom"],
  ["Adam:\n\nunslop: načítané, hook, verzia abc\n\nidentita: Adam, persona x, relácia y. Ešte veta.\n\nText.", "Adam", null],
  ["Adam:\nunslop: načítané, hook, verzia abc\n\nidentita: x.\n\nText.", "Adam", "prázdny riadok"],
  ["Adam:\n\nunslop: načítané, hook, verzia abc\nidentita: x.\n\nText.", "Adam", "unslop: načítané"],
  ["Adam:\n\nunslop: načítané, hook, verzia abc\n\nidentita: x.\nText.", "Adam", "identita: x."],
  ["Hotovo.", null, null],
  ["Adam: Hotovo.", null, null],
  ["Boris:\n\nHotovo.", "Adam", "nezačína menom"],
  ["Adam:\n\nJedna. Dve. Tri. Štyri. Päť. Šesť. Sedem.", "Adam", "7 viet"],
];
for (const [text, name, want] of named) {
  const got = replyProblem(text, name);
  const ok = want === null ? got === null : typeof got === "string" && got.includes(want);
  if (!ok) { bad++; console.log(`✗ meno ${name}: chcem ${want}, mám ${got}: ${text.slice(0, 50)}`); }
}

// Priebežná správa so zámerom (námietka 27. 10. 2026), prvý prípad je skutočná veta Huga.
const intent = [
  ["Prečítam hook štartu relácie v /opt/agentic-workflow, aby som overil, čo pri štarte vkladá a odkiaľ berie stav odovzdávky.", "hlási zámer"],
  ["Pozriem, čo máme.", "hlási zámer"],
  ["Teraz skontrolujem test.", "hlási zámer"],
  ["I'll check the hook first.", "hlási zámer"],
  ["Let me read the file.", "hlási zámer"],
  ["Hotovo. Teraz overím test.", "hlási zámer"],
  ["Načítal som hooks/reply_guard.mjs, aby som doplnil kontrolu.", null],
  ["Spustil som node --test, 12 prípadov prešlo.", null],
  ["Veta \"Prečítam hook\" je zámer, nie krok.", null],
  ["Hook `overím` nepustí.", null],
  ["Overíme to zajtra na Macu.", null],
];
for (const [text, want] of intent) {
  const got = intentProblem(text);
  const ok = want === null ? got === null : typeof got === "string" && got.includes(want);
  if (!ok) { bad++; console.log(`✗ zámer: chcem ${want}, mám ${got}: ${text.slice(0, 50)}`); }
}

const total = intent.length + named.length + task.length + 3 + resolves.length + cases.length + detail.length + asked.length + unit.length + links.length + 2 + deferred.length + 1 + unverified.length + 1 + local.length + 1;
console.log(bad ? `${bad}/${total} zlyhalo` : `${total} prípadov v poriadku`);
process.exit(bad ? 1 : 0);
