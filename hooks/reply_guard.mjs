#!/usr/bin/env node
// requires: tasker, t3
// reply_guard.mjs — odpoveď operátorovi je krátka a odkaz v nej funguje.
// Dňa 22. 10. 2026 vlákno projektu napísalo operátorovi odpoveď s piatimi
// odsekmi a odkazom na web, ktorý ešte nebežal. Operátor klikol, dostal chybu
// certifikátu, nahlásil ju a až potom dočítal, že web ešte nie je. Pravidlo
// global §2 (jedna až tri vety) existovalo a nestačilo, preto kontrola
// (global §4, druhý výskyt).
//
// Hodnoty zo prostredia (lib/agent_env.mjs, runtime.env agenta): adresa webu
// Taskera TASKER_WEB_URL, meno operátora AGENT_OPERATOR_NAME.
//
// Stop z settings.json prostredia. Prečíta poslednú odpoveď a zastaví ju,
// keď má viac ako 3 vety prózy (global §2; 6, keď posledná správa operátora
// žiada postup, podrobnosti, vysvetlenie alebo dokument, detailRequested), vetu
// nad 35 slov, položku zoznamu s viac vetami alebo adresu http(s), ktorá dnes
// neodpovedá. Zastaví na prvom probléme. Bloky kódu, inline kód, nadpisy,
// tabuľky, zoznamy, štyri vety hlásenia chyby zo skills/error/scripts/error.sh a riadky
// unslop:, identita:, Čaká na teba:, Príkaz pre teba a HOTOVO-KONTEXT (aj s režimom a kľúčom z kontext.sh) sa do
// prózy nepočítajú.
//
// Dňa 28. 10. 2026 vlákno témy projektu odpovedalo operátorovi štyrmi
// vetami o tom, čo nenapísalo, neposlalo a nevedelo zistiť (úloha 636).
// Strop 6 viet (D0031) to pustil, hoci global §2 hovorí jedna až tri vety.
// Operátor: agenti majú byť struční a vecní, omáčka okolo výsledku preč.
// Strop je preto 3 a dôvod zastavenia menuje, čo do odpovede nepatrí. Položky zoznamu sa kontrolujú zvlášť, každá je jedna
// veta. Pri REPLY_GUARD_NO_NET=1 sa adresy nekontrolujú (testy, stroj bez
// siete). Odpoveď agenta s PERSONA.md musí mať na prvom riadku samotné
// "<Meno>:" (meno ako v hooks/identity.mjs, koncové medzery smú byť), druhý
// riadok prázdny, správa ide od tretieho; riadky unslop: a identita: v úvode
// oddeľuje prázdny riadok. Riadok s menom sa pred ostatnými kontrolami
// odstráni. Pri druhom zastavení v rade (stop_hook_active) mlčí, aby sa
// nezacyklil.
//
// Dňa 22. 10. 2026 agent napísal návrh na rozhodnutie s vetou "Či sa dá
// premenovať na tasker, som neoveril, zistí sa pri nasadení". Operátor ju
// rozporoval: overenie uskutočniteľnosti patrí pred rozhodnutie, inak sa
// nasadzuje naslepo. Tretí neoverený predpoklad v ten deň, preto deferredCheck
// zastaví próza, ktorá odkladá overenie na nasadenie alebo prvý beh.
//
// Dňa 23. 10. 2026 agent predstavil operátorovi druhú verziu návrhu s vetou
// "Či hook vystrelí aj na commit sub-agenta, je zatiaľ neoverené" a operátor
// namietol: "Ak máš niečo neoverené, nemôžeš potvrdiť
// plán". deferredCheck chytá len odklad na nasadenie, preto unverifiedPlan
// zastaví odpoveď, ktorá ponúka návrh alebo plán na schválenie a zároveň
// nesie neoverenú položku. Výnimka: veta uvedie, prečo sa to teraz overiť
// nedá, a odpoveď povie, že návrh nie je pripravený na schválenie (obe naraz).
//
// Dňa 23. 10. 2026 agent poslal operátorovi odkaz http://127.0.0.1:8801/... na
// web Taskera. Operátor číta z Macu a z telefónu cez Tailscale, localhost
// servera mu nefunguje, a deadLinks lokálne adresy preskakuje. Preto localLinks
// zastaví adresu s hostom localhost, 127.x.x.x, 0.0.0.0 alebo [::1] mimo kódu,
// bez siete, a na Macu (darwin) ju pustí, tam je localhost operátorov vlastný.
//
// Dňa 23. 10. 2026 operátor chce, aby bola každá zmienka úlohy Taskera v texte
// pre neho klikateľný odkaz na jej stránku. Skript odpoveď modelu prepísať nevie, preto
// taskLinks zastaví neprepojenú zmienku ("úloha 380", "úlohy 369 a 370",
// "task #7") a v dôvode dá hotové náhrady, model ich len vloží. Beží bez
// siete, aj pri REPLY_GUARD_NO_NET=1. Adresu webu berie z TASKER_WEB_URL.

// Dňa 23. 10. 2026 agent na otázku "Čo ma čaká?" vymenoval tri veci, z ktorých
// nečakala ani jedna (návrh úlohy 390, K3). Kontroly
// waitingProblem a decisionProblem sú vypnuté, kým prostredie nemá
// AR_ROZHODNUTIA=1 (lib/agent_env.mjs, zapnute). Zapne ich nasadenie U5
// jednou premennou v bloku env súboru settings.json (env/server/install.sh,
// env/mac/install.sh, tabuľka env/hooks.mjs). Bez prepínača sa správanie hooku nemení.

// Dňa 25. 10. 2026 zhrnutie behu úlohy 573 znelo "Čaká na operátorovo A/B k zápisu" a operátor
// nevedel, čo sa ho pýta (úloha 575). waitingItemProblem (lib/human_question.mjs) zastaví
// položku "(rozhodnutie)" v "Čaká na teba:" bez vety s `?` alebo s písmenom voľby bez `A) ...`.
// accountItemProblem zastaví položku "(tvoj účet)" bez riadku "Overené:", tvrdenie o stave
// operátorovho účtu musí niesť, čím ho agent overil (D0194, organizácia Console).

import { execFileSync } from "node:child_process";
import { accountItemProblem, waitingItemProblem } from "../lib/human_question.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { personaFor } from "../lib/agent_name.mjs";
import { workflowDir } from "../lib/paths.mjs";
import { lastReply } from "./no_operator_commands.mjs";
import { blockStop } from "../lib/deny.mjs";
import { lastTurn } from "./objection_fix.mjs";
import { hookEnv, operatorForms, zapnute } from "../lib/agent_env.mjs";
import { DEFAULT_WEB, fetchTasks } from "../lib/tasker_read.mjs";

export const MAX_SENTENCES = 3;
export const MAX_SENTENCES_DETAIL = 6;
export const MAX_WORDS = 35;

// Riadky hlásenia uznanej chyby (skills/error/scripts/error.sh, global §4) sa do prózy nerátajú.
const SKIP_LINE = /^(unslop:|overené:|identita:|čaká na teba:|príkaz pre teba|hotovo-kontext|tvrdil alebo urobil som:|pravda bola:|zmenil sa súbor |nabudúce to zastaví:)/i;

// Operátor žiada dlhšiu odpoveď: postup, kroky, podrobnosti, vysvetlenie,
// dokument, súhrn, návrh, analýzu alebo porovnanie (global §2, "Longer only
// when the user asks for steps, details or a document"). Text je posledná
// správa operátora (lastTurn z objection_fix.mjs), bez kódu.
const DETAIL = /(?<![\p{L}])(?:vysvetl\p{L}*|podrobn\p{L}*|detail\p{L}*|postup\p{L}*|krok\p{L}*|dokument\p{L}*|súhrn\p{L}*|zhrň\p{L}*|zhrnutie|rozpíš\p{L}*|opíš\p{L}*|popíš\p{L}*|analýz\p{L}*|audit\p{L}*|navrhni|návrh\p{L}*|plán\p{L}*|porovna\p{L}*|explain\p{L}*|steps|details?|document\p{L}*|summar\p{L}*|describe|proposal|plan|compare|analy[sz]\p{L}*)(?![\p{L}])/iu;
export function detailRequested(userText) {
  return DETAIL.test(withoutInline(withoutFences(String(userText ?? ""))));
}
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
// Skratky, za ktorými bodka vetu nekončí.
const ABBR = new Set(["napr", "tzv", "resp", "atď", "str", "s", "č", "j", "t", "tj", "pozn", "cca"]);

const withoutFences = (text) => text.replace(/```[\s\S]*?(```|$)/g, "\n");
const withoutInline = (text) => text.replace(/`[^`\n]*`/g, "");

// Rozdelí odpoveď na riadky prózy a položky zoznamu.
function parse(text) {
  const proseLines = [];
  const items = [];
  for (const raw of withoutFences(text).split("\n")) {
    const line = raw.trim();
    if (!line) { proseLines.push(""); continue; }
    if (line.startsWith("#") || line.startsWith("|")) continue;
    if (SKIP_LINE.test(line.replace(/^(\*\*|__)/, ""))) continue;
    const m = LIST_ITEM.exec(line);
    if (m) { items.push(withoutInline(m[1]).trim()); continue; }
    proseLines.push(withoutInline(line));
  }
  return { prose: proseLines.join("\n").replace(/\n{3,}/g, "\n\n").trim(), items };
}

// Próza bez kódu, nadpisov, tabuliek, zoznamov a riadkov, ktoré sa nepočítajú.
export function prose(text) {
  return parse(text).prose;
}

// Rozdelí text na vety. Riadok končiaci dvojbodkou a prázdny riadok vetu
// ukončia, ostatné zalomenia sú medzera.
export function sentences(text) {
  const out = [];
  const paragraphs = text.replace(/:[ \t]*\n/g, ":\n\n").split(/\n\s*\n/);
  for (const p of paragraphs) {
    const para = p.replace(/\s*\n\s*/g, " ").trim();
    let start = 0;
    for (const m of para.matchAll(/[.!?]+["'”’)»\]]*(?=\s|$)/g)) {
      if (/^\.(?!\.)/.test(m[0])) {
        const before = para.slice(start, m.index);
        const tok = (before.match(/(\S+)$/)?.[1] ?? "").replace(/^[^\p{L}\p{N}]+/u, "").toLowerCase();
        if (/^\d+$/.test(tok) || ABBR.has(tok)) continue;
      }
      out.push(para.slice(start, m.index + m[0].length).trim());
      start = m.index + m[0].length;
    }
    if (para.slice(start).trim()) out.push(para.slice(start).trim());
  }
  return out.filter((s) => /[\p{L}\p{N}]/u.test(s));
}

// Počet slov vety bez adries.
const wordCount = (s) => s.replace(/(https?:\/\/|www\.)\S+/g, " ").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

const clip = (s) => (s.length > 60 ? `${s.slice(0, 57)}...` : s);

// Odpoveď agenta s menom má na prvom riadku (po trimStart) len "<Meno>:",
// koncové medzery smú byť, druhý riadok je prázdny a text ide od tretieho
// (global §2, D0062, nahradilo D0039 s menom a textom na jednom riadku). T3
// vykreslí odpoveď ako markdown, jeden znak nového riadku je mäkký zlom a
// "Meno:\nText" sa zobrazí na jednom riadku (operátor 23. 10. 2026). Vráti text
// od druhého riadku, alebo null, keď prvý riadok nie je samotné meno.
export function stripName(text, name) {
  const t = text.trimStart();
  const nl = t.indexOf("\n");
  const first = nl < 0 ? t : t.slice(0, nl);
  if (first.trimEnd() !== `${name}:`) return null;
  return nl < 0 ? "" : t.slice(nl + 1);
}

// Vráti dôvod zastavenia alebo null. Pri zadanom mene (nadpis PERSONA.md, bez
// persony null) najprv skontroluje predponu a odstráni ju, aby riadok
// "unslop:" ostal preskočený a meno sa nerátalo do viet.
export function replyProblem(text, name = null, { maxSentences = MAX_SENTENCES } = {}) {
  if (name && text.trim()) {
    const rest = stripName(text, name);
    if (rest === null) return `odpoveď nezačína menom, napíš na prvý riadok samotné "${name}:", prázdny riadok a text od tretieho riadku`;
    const lines = rest.split("\n");
    if (lines[0].trim() !== "")
      return `za riadkom "${name}:" musí ísť prázdny riadok, T3 spojí riadky bez neho do jedného. Napíš "${name}:", prázdny riadok a text od tretieho riadku`;
    // Úvod prvej odpovede: riadky unslop: a identita: oddelené prázdnym riadkom.
    for (let i = 0; i < lines.length - 1; i++)
      if (/^(unslop|identita):/i.test(lines[i].trim()) && lines[i + 1].trim() !== "")
        return `za riadkom "${clip(lines[i].trim())}" musí ísť prázdny riadok, inak ho T3 zlepí s ďalším. Oddeľ prázdnym riadkom meno, unslop:, identita: aj prvú vetu`;
    text = rest;
  }
  const { prose: p, items } = parse(text);
  const sents = sentences(p);
  const counted = sents.filter((s) => !s.endsWith(":"));
  if (counted.length > maxSentences)
    return `odpoveď má ${counted.length} viet prózy, strop je ${maxSentences} (global §2). Napíš verdikt, dôvod a čo treba urobiť. `
      + "Čo si neurobil, prečo si to neurobil, čo si nevedel zistiť a tvoj názor do odpovede nepatria. "
      + "Podrobnosti patria do súboru v docs/ a odpoveď nesie jeho cestu, dlhšia odpoveď len na žiadosť o postup, podrobnosti alebo dokument.";
  for (const s of [...sents, ...items.flatMap((i) => sentences(i))]) {
    const n = wordCount(s);
    if (n > MAX_WORDS) return `veta so ${n} slovami je súvetie, rozdeľ ju alebo zmaž: "${clip(s)}"`;
  }
  for (const i of items) {
    const n = sentences(i).length;
    if (n > 1) return `položka zoznamu "${clip(i)}" má ${n} viet, položka je jedna veta`;
  }
  return null;
}

const L = "\\p{L}";

// Priebežná správa hlási zámer (úloha 631, námietka 27. 10. 2026): veta začína
// slovesom prvej osoby v budúcom čase ("Prečítam hook štartu", "Pozriem, čo
// máme", "I'll check the hook"). Krok sa píše hotový s názvom súboru alebo
// príkazu a účelom ("Načítal som hooks/x.mjs, aby som ..."). Kontroluje sa
// celý ťah od poslednej správy operátora, nie len posledná odpoveď.
const SK_INTENT_VERBS = "prečítam|načítam|pozriem|overím|skontrolujem|zistím|spustím|otvorím|nájdem|vyhľadám|prejdem|pripravím|urobím|začnem|opravím|zmením|pošlem|založím|zapíšem|preverím|skúsim|pustím|idem|pokúsim|porovnám|naštudujem|prezriem|zapnem|nasadím|doplním|upravím|prepíšem|vložím|odstránim|zmažem|dopíšem|prehľadám|vypíšem|stiahnem";
const SK_LEAD = "(?:(?:teraz|najprv|potom|ešte|hneď|ďalej|následne)\\s+)?";
const INTENT = [
  new RegExp(`^${SK_LEAD}(?:${SK_INTENT_VERBS})(?![${L}])`, "iu"),
  new RegExp(`^(?:(?:now|next|first|then)[,\\s]+)?(?:i['’]ll|i will|i['’]m going to|let me|going to)(?![${L}])`, "iu"),
];

// Vráti dôvod zastavenia alebo null. text je celý text ťahu agenta.
export function intentProblem(text) {
  const { prose: p, items } = parse(text);
  for (const s of [...sentences(p), ...items.flatMap((i) => sentences(i))]) {
    if (INTENT.some((re) => re.test(s))) return `priebežná správa hlási zámer namiesto hotového kroku: "${clip(s)}"`;
  }
  return null;
}

// Overenie odložené na nasadenie alebo prvý beh, po slovensky aj po anglicky.
// Sloveso overenia a čas nasadenia v jednej vete, v oboch poradiach.
const SK_VERB = `(?<![${L}])(?:over(?:í|íme|ím|íš|ia)|zist(?:í|íme|ím|íš|ia)|ukáž(?:e|u)|skontroluj(?:eme|em|e)|vyskúš(?:ame|am|a)|uvidí(?:me|m)?)(?![${L}])`;
const SK_WHEN = `(?<![${L}])(?:až\\s+)?(?:pri|po|počas)\\s+(?:(?:nasaden\\p{L}*|deploy\\p{L}*)|(?:prvom|prvým|ostrom)\\s+(?:štarte|behu|spustení|nasadení|nasadením|štartu))(?![${L}])`;
const EN_VERB = `(?<![${L}])(?:verify|validate|confirm|find\\s+out|discover|(?:we['’]ll|we\\s+will|will)\\s+see)(?![${L}])`;
const EN_WHEN = `(?<![${L}])(?:on|at|during|after|upon|in)\\s+(?:the\\s+)?(?:(?:first|initial)\\s+(?:run|start\\p{L}*|launch\\p{L}*|deploy\\p{L}*)|deploy\\p{L}*|rollout|go-?live)(?![${L}])`;
const GAP = "[^.!?\\n]{0,60}?";
const DEFERRED = [[SK_VERB, SK_WHEN], [EN_VERB, EN_WHEN]]
  .flatMap(([v, w]) => [new RegExp(`${v}${GAP}${w}`, "iu"), new RegExp(`${w}${GAP}${v}`, "iu")]);

// Vráti dôvod zastavenia alebo null. Kód a inline kód sa nekontrolujú.
export function deferredCheck(text) {
  const { prose: p, items } = parse(text);
  const body = [p, ...items].join("\n");
  for (const re of DEFERRED) {
    const m = re.exec(body);
    if (m) return `odklad overenia na nasadenie: "${clip(m[0])}". Overenie uskutočniteľnosti patrí pred návrh alebo rozhodnutie. `
      + "Over to teraz (skúšobná inštancia, dokumentácia, kód) alebo napíš, prečo sa to overiť nedá.";
  }
  return null;
}

// Neoverená položka v odpovedi, ktorá ponúka návrh alebo plán na schválenie.
const UNVERIFIED = new RegExp(`(?<![${L}])(?:neoveren${L}*|neoveril${L}*|zatiaľ\\s+nevieme|nie\\s+je\\s+overen${L}*|unverified|not\\s+(?:yet\\s+)?verified|haven['’]t\\s+verified|have\\s+not\\s+verified)(?![${L}])`, "iu");
const PLAN = new RegExp(`(?<![${L}])(?:návrh${L}*|plán${L}*|plan|proposal|schváliš|schváľ${L}*|súhlasíš|potvrdíš|potvrď|approve|sign\\s+off)(?![${L}])`, "iu");
const CANT_VERIFY = /nedá\s+(?:sa\s+)?overiť|nemožno\s+overiť|cannot\s+be\s+verified|can['’]t\s+be\s+verified|no\s+way\s+to\s+verify/iu;
const NOT_READY = /nie\s+je\s+(?:pripravený|hotový)\s+na\s+schválenie|not\s+ready\s+for\s+approval/iu;

// Vráti dôvod zastavenia alebo null. Kód a inline kód sa nekontrolujú.
export function unverifiedPlan(text) {
  const { prose: p, items } = parse(text);
  const parts = [p, ...items];
  if (!PLAN.test(parts.join("\n"))) return null;
  for (const s of parts.flatMap((x) => sentences(x))) {
    if (!UNVERIFIED.test(s)) continue;
    if (CANT_VERIFY.test(s) && NOT_READY.test(parts.join("\n"))) continue;
    return `neoverená položka v návrhu: "${clip(s)}". Návrh ide na schválenie, až keď je všetko overené (global/CLAUDE.md §1). `
      + "Over to teraz alebo napíš, prečo sa to overiť nedá, a že návrh nie je pripravený na schválenie.";
  }
  return null;
}

// IPv4 adresa tailnetového mena cez tailscale CLI, alebo null. Bez CLI null.
export function tailscaleLookup(name) {
  try {
    const out = execFileSync("tailscale", ["ip", "-4", name],
      { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
    return out.split("\n")[0].trim() || null;
  } catch { return null; }
}

// Argumenty `--resolve` pre host *.ts.net. 23. 10. 2026: server má Tailscale
// s CorpDNS false, meno sa lokálne nepreloží a curl skončil kódom 6, hoci adresa
// funguje. Bez IP z `lookup` (iný stroj, žiadne tailscale) je výsledok prázdny.
export function resolveArgs(url, lookup = tailscaleLookup) {
  let u;
  try { u = new URL(url); } catch { return []; }
  if (!/\.ts\.net$/i.test(u.hostname)) return [];
  const ip = lookup(u.hostname.split(".")[0]);
  if (!ip) return [];
  const port = u.port || (u.protocol === "http:" ? "80" : "443");
  return ["--resolve", `${u.hostname}:${port}:${ip}`];
}

// Odpovie kódom HTTP, pri zlyhaní hodí chybu.
export function curlProbe(url) {
  const out = execFileSync("curl", ["-sIL", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "5", ...resolveArgs(url), url],
    { encoding: "utf8", timeout: 7000, stdio: ["ignore", "pipe", "ignore"] });
  return Number.parseInt(out, 10);
}

const LOCAL_HOST = /^(localhost|127(\.\d+){3}|0\.0\.0\.0|\[::1\])$/i;

// Adresa webu Taskera cez Tailscale pre príklady v dôvodoch a postupoch:
// z TASKER_WEB_URL, keď nie je localhost, inak zástupný text.
export function webExample(webUrl) {
  try {
    const u = new URL(webUrl);
    if (!LOCAL_HOST.test(u.hostname)) return `${u.protocol}//${u.host}`;
  } catch {}
  return "https://<host>.<tailnet>.ts.net:8801";
}
const webHost = (webUrl) => webExample(webUrl).replace(/:\d+$/, "");

// Vráti dôvod pre prvú adresu s hostom localhost servera, alebo null. Na Macu
// je localhost operátorov vlastný, tam sa nekontroluje. Kód a inline kód nie.
export function localLinks(text, platform = process.platform, webUrl = process.env.TASKER_WEB_URL) {
  if (platform === "darwin") return null;
  for (const m of withoutInline(withoutFences(text)).matchAll(/https?:\/\/(?:\[[0-9a-f:]+\]|[^\s<>)"'`\]\/]+)[^\s<>)"'`\]]*/gi)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    let host;
    try { host = new URL(url).hostname; } catch { continue; }
    if (LOCAL_HOST.test(host)) {
      return `adresa ${url} je localhost servera, operátor ju z Macu ani telefónu neotvorí. `
        + `Daj adresu cez Tailscale (tailscale serve status), napríklad ${webExample(webUrl)}.`;
    }
  }
  return null;
}

// Zmienka úlohy: slovo (úloha v ľubovoľnom páde, task, Tasker), voliteľné
// "#" a číslo, potom ďalšie čísla vymenovania. Číslo pred slovom ("51 úloh")
// nie je zmienka, rovnako číslo pred slovom úloh ("a 51 úloh" je počet).
// Čiarkou oddelené číslo, za ktorým ide ďalšie slovo ("380, 12 agentov"),
// a dátum ("380, 23. 10.") do vymenovania nepatria. Číslo s viac ako šiestimi
// číslicami je commit zo samých číslic ("Tasker 8581310"), nie úloha.
const HEAD = /(?<![\p{L}\p{N}])(?:úloh(?:a|y|e|u|ou|ám|ách|ami)?|tasks?|tasker)(?![\p{L}\p{N}])/giu;
const NUM = "(\\[)?(#)?(\\d{1,6})(?!\\d|\\p{L}|\\.\\s*\\d|[:/]\\d|\\s+(?:[Úú]loh|[Tt]asks?(?![\\p{L}\\p{N}])))(\\](?:\\([^)\\s]*\\))?)?";
const FIRST = new RegExp(`(\\s+)${NUM}`, "uy");
const NEXT = new RegExp(`(\\s*,\\s*(?:(?:a|aj|alebo|i)\\s+)?|\\s+(?:a|aj|alebo|i|ani)\\s+)${NUM}`, "uy");
const COMMA_TAIL = /^\s+(?!(?:a|aj|alebo|i|ani)\s)\p{Ll}/u;

// Vráti dôvod pre neprepojené zmienky úloh Taskera s hotovými náhradami, alebo
// null. Zmienka je prepojená, keď číslo leží v texte markdown odkazu na
// `/tasks/<to isté číslo>` alebo za ním ide holá adresa `/tasks/<číslo>`.
export function taskLinks(text, base = process.env.TASKER_WEB_URL || DEFAULT_WEB) {
  const t = withoutInline(withoutFences(text));
  const root = base.replace(/\/+$/, "");
  const url = (id) => `${root}/tasks/${id}`;
  const links = [...t.matchAll(/\[([^\]\n]*)\]\(([^)\s]+)\)/g)].flatMap((m) => {
    const id = /\/tasks\/(\d+)\/?$/.exec(m[2])?.[1];
    return id ? [{ from: m.index + 1, to: m.index + 1 + m[1].length, id }] : [];
  });
  const isLinked = (i) =>
    links.some((l) => l.id === i.id && i.pos >= l.from && i.pos < l.to)
    || new RegExp(`^(?:[\\s(\\[:,]|[-–—])*https?://\\S*?/tasks/${i.id}(?!\\d)`, "i").test(t.slice(i.end));
  const fixes = new Set();
  for (const h of t.matchAll(HEAD)) {
    const items = [];
    let at = h.index + h[0].length;
    for (let re = FIRST, m; (re.lastIndex = at, m = re.exec(t)); re = NEXT) {
      at = re.lastIndex;
      const [all, sep, pre = "", hash = "", id, post = ""] = m;
      if (items.length && /^\s*,/.test(sep) && COMMA_TAIL.test(t.slice(at))) break;
      items.push({ sep, pre, hash, id, post, pos: m.index + sep.length + pre.length + hash.length, end: at, all });
      // Odkaz, ktorý sa začal pred číslom, tu končí a vymenovanie s ním.
      if (!pre && post.includes("](")) break;
    }
    if (!items.length || items.every(isLinked)) continue;
    const orig = h[0] + items.map((i) => i.all).join("");
    const fix = items.length === 1
      ? `[${h[0]}${items[0].sep}${items[0].hash}${items[0].id}](${url(items[0].id)})`
      : h[0] + items.map((i) => i.sep + (isLinked(i) ? i.pre + i.hash + i.id + i.post : `[${i.hash}${i.id}](${url(i.id)})`)).join("");
    fixes.add(`${orig} -> ${fix}`);
  }
  if (!fixes.size) return null;
  return `zmienka úlohy Taskera bez odkazu, operátor ju má dostať ako klikateľný odkaz. Vlož tieto náhrady: ${[...fixes].slice(0, 8).join("; ")}.`;
}

// K3a: položka "Čaká na teba" nesie odkaz na úlohu Taskera v needs_human.
// Spúšťač je riadok "Čaká na teba:" alebo veta "na teba čaká/čakajú ..."
// ("nečaká" ho nespustí). Jednotka je položka zoznamu pod ním, alebo veta
// samotná, keď nekončí dvojbodkou. Jednotka "nič" alebo "žiadne" prejde.
const WAIT_HEAD = /^\s*(?:\p{L}+:\s+)?(?:[-*+]\s+|\d+[.)]\s+)?(?:\*\*|__)?čaká na teba:(?:\*\*|__)?\s*(.*)$/iu;
const WAIT_SENT = /(?<![\p{L}])(?:na\s+teba\s+čak(?:á|ajú)|čak(?:á|ajú)\s+na\s+teba)(?![\p{L}])/iu;
const NOTHING = /^(?:nič|žiadn\p{L}*|nikto)[\s.]*$/iu;
const TASK_ID = /\/tasks\/(\d+)/g;

// Vráti jednotky, ktoré tvrdia, že na operátora niečo čaká.
export function waitingUnits(text) {
  const lines = withoutInline(withoutFences(text)).split("\n");
  const units = [];
  const itemsAfter = (i) => {
    const out = [];
    for (let j = i + 1; j < lines.length; j++) {
      const m = LIST_ITEM.exec(lines[j]);
      if (m) out.push(m[1].trim());
      else if (lines[j].trim()) break;
    }
    return out;
  };
  for (let i = 0; i < lines.length; i++) {
    const head = WAIT_HEAD.exec(lines[i]);
    if (head) {
      if (head[1].trim()) units.push(head[1].trim());
      units.push(...itemsAfter(i));
      continue;
    }
    for (const s of sentences(lines[i])) {
      if (!WAIT_SENT.test(s)) continue;
      if (s.endsWith(":")) units.push(...itemsAfter(i)); else units.push(s);
    }
  }
  return units.filter((u) => u && !NOTHING.test(u));
}

// Vráti dôvod zastavenia alebo null. `lookup(ids)` vráti úlohy Taskera
// (lib/tasker_read.mjs), pri chybe hodí a odpoveď sa nepustí.
export async function waitingProblem(text, lookup = (ids) => fetchTasks({ ids })) {
  const units = waitingUnits(text);
  if (!units.length) return null;
  const hint = "Polož otázku ako úlohu: tasker ask <id> --body \"otázka, cesty A a B, odporúčanie\" a v odpovedi daj jej odkaz. "
    + "Stav práce (kto na čo čaká) drží Tasker, nie veta v odpovedi.";
  const bare = units.find((u) => !/\/tasks\/\d+/.test(u));
  if (bare) return `"Čaká na teba" bez odkazu na úlohu Taskera: "${clip(bare)}". ${hint}`;
  const ids = [...new Set(units.flatMap((u) => [...u.matchAll(TASK_ID)].map((m) => Number(m[1]))))];
  let rows;
  try { rows = await lookup(ids); } catch { return "Tasker neodpovedal, nepoznám stav úloh v \"Čaká na teba\". Skús znova, položky bez overenia nepustím."; }
  for (const id of ids) {
    const t = rows.find((r) => r.id === id);
    if (!t) return `úloha ${id} v \"Čaká na teba\" v Taskeri neexistuje. ${hint}`;
    if (t.status !== "needs_human") return `úloha ${id} v \"Čaká na teba\" je v stave ${t.status}, nie needs_human. ${hint}`;
  }
  return null;
}

// K3b: "<operátor> rozhodol/schválil/určil/zadal" o novej veci bez zápisu
// (meno operátora je AGENT_OPERATOR_NAME).
// Vety s číslom záznamu D0000 alebo s dátumom (stará vec) prejdú. Zápis je
// v tomto ťahu príkaz bin/rozhodni.sh alebo `tasker ask`. `cmds` sú príkazy
// Bash od poslednej správy operátora (lastTurn z objection_fix.mjs).
const decided = (env) => new RegExp(`(?<![\\p{L}])${operatorForms(env).nom.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(?:(?:už|dnes|práve|potom|vo\\s+vlákne|vlákne)\\s+)*(?:rozhodol|schválil|určil|zadal)(?![\\p{L}])`, "iu");
const RECORDED = /\brozhodni\.sh\b|\btasker\s+ask\b/;
export function decisionProblem(text, cmds, env = process.env) {
  const DECIDED = decided(env);
  if (cmds.some((c) => RECORDED.test(c))) return null;
  const { prose: p, items } = parse(text);
  for (const s of [...sentences(p), ...items.flatMap((i) => sentences(i))]) {
    if (!DECIDED.test(s) || /D\d{4}/.test(s) || /\d{1,2}\.\s*\d{1,2}\./.test(s)) continue;
    return `veta "${clip(s)}" hlási nové rozhodnutie operátora, ale v tomto ťahu nebežal bin/rozhodni.sh ani tasker ask. `
      + "Zapíš rozhodnutie (bin/rozhodni.sh, v odpovedi daj jeho číslo D) alebo polož otázku ako úlohu (tasker ask). "
      + "Ide o staré rozhodnutie, uveď jeho číslo D alebo dátum.";
  }
  return null;
}

const LOCAL = /^(localhost|127\.|.*\.lan$)/;

// Vráti dôvod pre prvú adresu, ktorá dnes neodpovedá, alebo null. Kód 401,
// 403 a 405 znamená, že server odpovedá.
export function deadLinks(text, probe = curlProbe) {
  const seen = new Set();
  for (const m of withoutInline(withoutFences(text)).matchAll(/https?:\/\/[^\s<>)"'`\]]+/g)) {
    const url = m[0].replace(/[.,;:!?]+$/, "");
    let host;
    try { host = new URL(url).hostname; } catch { continue; }
    if (LOCAL.test(host) || seen.has(url)) continue;
    seen.add(url);
    let detail = null;
    try {
      const code = Number(probe(url));
      if (!(code > 0) || (code >= 400 && ![401, 403, 405].includes(code))) detail = `kód ${code || "žiadny"}`;
    } catch (e) {
      detail = e?.status ? `curl skončil s kódom ${e.status}` : String(e?.message ?? e).split("\n")[0].slice(0, 80);
    }
    if (detail) return `adresa ${url} dnes neodpovedá (${detail}). Odkaz dávaj len na adresu, ktorá funguje teraz, `
      + "inak ju napíš bez https:// a dodaj, že ešte nebeží.";
  }
  return null;
}

// Správny postup k dôvodu zastavenia (D0141). Prvá zhoda vyhráva, dôvody
// vyrába replyProblem, deferredCheck, unverifiedPlan, localLinks, taskLinks, waitingProblem,
// decisionProblem a deadLinks vyššie.
const ASK = "polož otázku ako úlohu `tasker ask <id> --body \"otázka, cesty A a B, odporúčanie\"` a v odpovedi daj jej odkaz";
export const POSTUPY = [
  [/^odpoveď nezačína menom|^za riadkom "/, "prepíš odpoveď: prvý riadok samotné `<Meno>:`, druhý prázdny, text od tretieho riadku (global/CLAUDE.md §2)"],
  [/viet prózy/, "skráť odpoveď na verdikt, dôvod a čo urobiť (najviac 3 vety prózy, zoznamy sa nerátajú); vynechaj, čo si neurobil a prečo, čo si nevedel zistiť a svoj názor; podrobnosti ulož do súboru v docs/ a v odpovedi uveď jeho cestu"],
  [/^veta so \d+ slovami/, "rozdeľ vetu na kratšie alebo ju zmaž a odpoveď prepíš"],
  [/^položka zoznamu/, "skráť položku zoznamu na jednu vetu a odpoveď prepíš"],
  [/^priebežná správa hlási zámer/, "napíš krok hotový v minulom čase s názvom súboru alebo príkazu a účelom (\"Načítal som hooks/x.mjs, aby som ...\"), alebo správu pred nástrojom vynechaj; pravidlo je v Jadre skillu unslop"],
  [/^odklad overenia/, "over to teraz (skúšobná inštancia mimo živého systému, kód alebo dokumentácia) a výsledok napíš do odpovede, alebo napíš, prečo sa to overiť nedá"],
  [/^neoverená položka v návrhu/, "over položku teraz (skúška, kód, dokumentácia) a výsledok napíš do odpovede, alebo napíš, prečo sa to teraz overiť nedá, a vetu, že návrh nie je pripravený na schválenie; návrh nedávaj na schválenie s neoverenou položkou"],
  [/je localhost servera/, "nahraď adresu adresou z `tailscale serve status`: {HOST}:<port>"],
  [/^zmienka úlohy Taskera bez odkazu/, "vlož náhrady vypísané v dôvode (tvar `[úloha N]({WEB}/tasks/N)`) a odpoveď prepíš"],
  [/^položka "Čaká na teba" \(rozhodnutie\)/, "prepíš položku ako jednu vetu končiacu `?` (vec, voľba, odporúčanie), písmeno voľby (A/B) definuj ako `A) ...`; podrobnosti a čo spôsobí každá odpoveď patria do úlohy `tasker ask <id> --body \"...\"`"],
  [/^položka "Čaká na teba" \(tvoj účet\)/, "pridaj riadok `Overené: <čo o stave operátorovho účtu si overil a ktorým príkazom alebo stránkou>; neoverené: <čo nevidíš>`; tvrdenie o jeho účte bez overenia napíš ako predpoklad, nie fakt (global/CLAUDE.md §1)"],
  [/^"Čaká na teba" bez odkazu|v "Čaká na teba" v Taskeri neexistuje|v "Čaká na teba" je v stave/, ASK + "; stav práce drží Tasker, nie veta v odpovedi"],
  [/^Tasker neodpovedal/, `over Tasker \`${join(workflowDir(), "bin", "tk")} task list\` a odpoveď pošli znova`],
  [/^veta ".*" hlási nové rozhodnutie/, "zapíš rozhodnutie `bin/rozhodni.sh --nazov ... --kluc ...` (text na stdin) a v odpovedi uveď jeho číslo D, alebo polož otázku `tasker ask <id> --body \"...\"`; staré rozhodnutie označ číslom D alebo dátumom"],
  [/^adresa .* dnes neodpovedá/, "over adresu `curl -sI <url>`, odkaz dávaj len na adresu, ktorá odpovedá, inak ju napíš bez https:// a dodaj, že ešte nebeží"],
];
// {HOST} a {WEB} v postupe sú adresa webu Taskera z TASKER_WEB_URL (webExample).
export function postupFor(reason, webUrl = process.env.TASKER_WEB_URL) {
  for (const [re, step] of POSTUPY) if (re.test(reason)) return step.replaceAll("{HOST}", webHost(webUrl)).replaceAll("{WEB}", webExample(webUrl));
  return "prepíš odpoveď podľa dôvodu vyššie, pravidlá odpovede sú v global/CLAUDE.md §2";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  if (input.stop_hook_active) process.exit(0);
  let text = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
  if (!text && input.transcript_path) {
    try { text = lastReply(readFileSync(input.transcript_path, "utf8")); } catch {}
  }
  const name = personaFor(input)?.name ?? null;
  const env = hookEnv(input);
  let cmds = null;
  let turnText = text;
  let maxSentences = MAX_SENTENCES;
  if (input.transcript_path) {
    try {
      const turn = lastTurn(readFileSync(input.transcript_path, "utf8"));
      if (zapnute(env)) cmds = turn.cmds;
      if (turn.text) turnText = turn.text;
      if (detailRequested(turn.userText)) maxSentences = MAX_SENTENCES_DETAIL;
    } catch {}
  }
  const reason = waitingItemProblem(text) ?? accountItemProblem(text) ?? replyProblem(text, name, { maxSentences }) ?? intentProblem(turnText) ?? deferredCheck(text) ?? unverifiedPlan(text) ?? localLinks(text, process.platform, env.TASKER_WEB_URL)
    ?? taskLinks(text, env.TASKER_WEB_URL || DEFAULT_WEB)
    ?? (zapnute(env) ? (await waitingProblem(text, (ids) => fetchTasks({ ids, env })) ?? (cmds ? decisionProblem(text, cmds, env) : null)) : null)
    ?? (env.REPLY_GUARD_NO_NET === "1" ? null : deadLinks(text));
  if (reason) blockStop(`Odpoveď operátorovi: ${reason}`, postupFor(reason, env.TASKER_WEB_URL));
}
