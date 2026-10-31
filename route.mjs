#!/usr/bin/env node
// Trasa odpovede: správa, ktorú agent pošle z vlákna témy, dostane záznam
// meno správy -> id vlákna, a budič doručí odpoveď na ňu do toho vlákna,
// nie do hlavného. Hlavné vlákno trasu nepotrebuje, záznam preň sa nepíše
// a starší záznam s tým istým kľúčom alebo témou sa zmaže.
//
// Stav je $AGENT_STATE/routes.json: `routes` (kľúč správy, druhá strana,
// téma, vlákno, čas), `sessions` (id relácie claude -> id vlákna, aby
// každé volanie nečítalo detail všetkých vlákien) a `sent` (kľúč správy
// -> čo agent od odpovede čaká, `cakam` true len pri `odpoveď: čakám`;
// budič podľa toho správu `na vedomie` k tomu kľúču zobudí alebo drží).
// Záznam starší ako MAX_AGE_MS vypadne pri ďalšom zápise.
//
// Kľúč správy je jej meno bez predpôn oboch strán (ako jadro v reply.sh):
// adam-pravidla-20261018-195432.md aj boris-adam-pravidla-20261018-195432.md
// majú kľúč pravidla-20261018-195432.md, celá výmena na jednu správu tak
// ide do jedného vlákna. Správa, ktorá nie je odpoveďou (nové meno
// odosielateľa s tou istou témou), ide podľa témy: boris-pravidla-<čas>.md
// do vlákna, ktoré naposledy písalo agentovi boris s témou pravidla.
//
// Vlákno odosielateľa: vlákno T3, ktorého providerThreads majú
// nativeThreadRef.nativeId rovné id relácie claude (CLAUDE_CODE_SESSION_ID
// v prostredí vlákna; po /clear má proces novú reláciu, vtedy platí
// --resume=<id> z príkazového riadku procesu CLAUDE_PID).
//
// Zoznam tém: $AGENT_BOX/topics.json (na serveri /var/lib/<agent>/topics.json,
// mimo gitu, skupina schránky ho číta) mapuje meno témy na vlákno T3, ktoré
// ju vedie. Novú správu k téme (<odosielateľ>-<téma>-<čas>) bez trasy
// budič doručí do toho vlákna, bin/ask_agent.sh (repo pravidiel) tému mimo zoznamu
// adresáta ani odosielateľa neodošle. Téma je presná a vlákno vedie jednu
// tému (D0211, chyba 28. 10. 2026: `remember` zapísal novú tému
// agentic_brain bežiacemu vláknu iného zadania). Zápis robí len výslovné
// `topic set` z vlákna témy: odmietne hlavné vlákno, holý názov projektu
// Taskera, tému, ktorú už vedie iné vlákno, a vlákno, ktoré už vedie inú
// tému (obe bez `--force "<dôvod>"`; s ním sa vypíše staré aj nové vlákno).
// `remember` tému nezapisuje, pre tému mimo zoznamu vypíše, že treba nové
// vlákno T3. Nová téma dostane nové vlákno, `hooks/topic_task.mjs` ho dá
// vláknu bez témy pri prvej založenej úlohe. Formát je plochý objekt
// s odsadením jednej medzery,
// `{ "<téma>": { "thread": ..., "at": ... } }`, bin/ask_agent.sh hľadá riadok
// ` "<téma>": {` cez grep.
//
// Použitie: route.mjs remember <meno správy> [--thread <id vlákna>] [--peer <agent>] [--mode čakám|nečakám|vedomie]
//           route.mjs show <meno správy>
//           route.mjs waiting <meno správy>   (kód 0, keď agent na odpoveď čaká)
//           route.mjs topic set <téma> [--thread <id vlákna>] [--force "<dôvod>"]   (--force dovolí druhú tému vlákna)
//           route.mjs topic send <téma>   (kontrola odosielateľa pre ask_agent.sh: téma v jeho zozname a vedie ju vlákno, z ktorého píše)
//           route.mjs topic rm <téma>
//           route.mjs topic tasks <téma> <id>...   (pridá koreňové úlohy; správy úlohy a jej podúloh idú do vlákna témy)
//           route.mjs topic list [--file <topics.json>]
//           route.mjs topic check <téma> [--file <topics.json>]   (kód 0, keď je téma v zozname alebo zoznam nie je)
import { chownSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchTasks } from "./lib/tasker_read.mjs";
import { config, normalizeMode, parseName, readJson, T3Client, writeJsonAtomic, ensureDir } from "./lib.mjs";

export const MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const PREFIX_RE = /^[a-z][a-z0-9_]{0,30}-/;
export const TOPIC_RE = /^[a-z][a-z0-9_]{1,40}$/;
// Odosielatelia skriptov, ich správa tému nemá a do zoznamu tém nepatrí.
// Výnimka: tasker-<téma>-... (tasker_events.mjs, úloha projektu s témou)
// tému má, tasker správa bez témy ju nemá, lebo čas nie je meno témy.
const SYSTEM_SENDERS = ["ranny", "pravidla"];

export function topicsPath(cfg) {
  return cfg.topicsFile || join(cfg.box, "topics.json");
}

export function readTopics(path) {
  const t = readJson(path, {});
  return t && typeof t === "object" && !Array.isArray(t) ? t : {};
}

// Zápis s právami 640 a skupinou priečinka, skupina schránky (používateľ cez SSH,
// iný agent) zoznam číta.
function writeTopics(path, topics) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(topics, null, 1) + "\n", { mode: 0o640 });
  try { chownSync(tmp, -1, statSync(dirname(path)).gid); } catch {}
  renameSync(tmp, path);
}

// Zapíše tému vláknu. Volá ju len výslovné `topic set` a hook topic_task.mjs
// pre vlákno bez témy, `remember` ju nevolá (D0211).
export function setTopic(cfg, topic, thread, { now = Date.now() } = {}) {
  if (!TOPIC_RE.test(topic)) throw new Error(`téma '${topic}' nie je snake_case`);
  const path = topicsPath(cfg);
  const topics = readTopics(path);
  topics[topic] = { thread, at: new Date(now).toISOString() };
  writeTopics(path, topics);
  return true;
}

// Témy, ktoré vlákno vedie podľa zoznamu.
export function topicsOfThread(topics, thread) {
  return Object.entries(topics).filter(([, v]) => v?.thread === thread).map(([k]) => k);
}

const normProject = (p) => String(p).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// Názvy projektov Taskera (v tvare témy), alebo null, keď sa zoznam nedá
// prečítať (bez Taskera, chyba čítania): kontrola vtedy mlčí.
export async function projectNames() {
  try {
    return new Set((await fetchTasks()).map((t) => t.project).filter(Boolean).map(normProject));
  } catch { return null; }
}

export function removeTopic(cfg, topic) {
  const path = topicsPath(cfg);
  const topics = readTopics(path);
  if (!topics[topic]) return false;
  delete topics[topic];
  writeTopics(path, topics);
  return true;
}

// Téma novej správy, ktorú budič hľadá v zozname tém: <odosielateľ>-<téma>-<čas>.
// Odpoveď na správu agenta (<odosielateľ>-<ja>-...) a správa skriptu tému nemajú.
export function messageTopic(name, me) {
  const { sender, topic } = parseName(name);
  if (!topic || topic === me || SYSTEM_SENDERS.includes(sender)) return null;
  return topic;
}

export function routesPath(cfg) {
  return join(cfg.state, "routes.json");
}

export function readRoutes(cfg) {
  const r = readJson(routesPath(cfg), {});
  const obj = (x) => (x && typeof x === "object" ? x : {});
  return { routes: Array.isArray(r.routes) ? r.routes : [], sessions: obj(r.sessions), sent: obj(r.sent) };
}

function writeRoutes(cfg, data, now = Date.now()) {
  ensureDir(cfg.state);
  const fresh = (x) => now - Date.parse(x.at) < MAX_AGE_MS;
  const sessions = Object.fromEntries(Object.entries(data.sessions).filter(([, v]) => fresh(v)));
  const sent = Object.fromEntries(Object.entries(data.sent ?? {}).filter(([, v]) => fresh(v)));
  writeJsonAtomic(routesPath(cfg), { routes: data.routes.filter(fresh), sessions, sent });
}

// Kľúč správy: meno bez predpôn mena agenta a odosielateľa, aspoň jedna
// pomlčka musí ostať (dátum v mene).
export function routeKey(name, me) {
  const { sender } = parseName(name);
  let core = name;
  while (PREFIX_RE.test(core)) {
    const head = core.slice(0, core.indexOf("-"));
    if (head !== sender && head !== me) break;
    const rest = core.slice(head.length + 1);
    if (!rest.includes("-")) break;
    core = rest;
  }
  return core;
}

// Zapíše trasu pre správu. Vlákno rovné hlavnému (thread_id) trasu
// nedostane a zruší staršie záznamy s tým istým kľúčom alebo témou.
// Druhá strana (peer) je odosielateľ správy, pri vlastnej správe ju dá
// volajúci (ask_agent.sh pozná adresáta), bez nej platí len kľúč.
// mode je prvý riadok odoslanej správy: zapíše sent[kľúč], vlastná
// odpoveď na kľúč ho prepíše (odpoveď na vedomie kľúč zavrie, --cakam
// ho znova otvorí). Zapíše sa aj z hlavného vlákna.
export function rememberRoute(cfg, { name, thread, peer, mode = null, now = Date.now() }) {
  const me = cfg.name ?? "agent";
  const key = routeKey(name, me);
  const { sender, topic } = parseName(name);
  peer ||= sender !== me ? sender : null;
  const data = readRoutes(cfg);
  let main = "";
  try { main = readFileSync(join(cfg.state, "thread_id"), "utf8").trim(); } catch {}
  data.routes = data.routes.filter((r) => r.key !== key && !(topic && peer && r.peer === peer && r.topic === topic));
  const isMain = !thread || thread === main;
  if (!isMain) data.routes.push({ key, id: name, peer, topic, thread, from: name, at: new Date(now).toISOString() });
  const m = normalizeMode(mode);
  if (m) data.sent[key] = { id: name, cakam: m === "čakám", mode: m, at: new Date(now).toISOString() };
  writeRoutes(cfg, data, now);
  // Tému správy remember do zoznamu nezapíše (D0211). Keď zoznam existuje
  // a téma v ňom nie je, volajúci vypíše, že treba nové vlákno T3.
  const t = messageTopic(name, me);
  let unlisted = null;
  if (!isMain && t && TOPIC_RE.test(t) && cfg.box && existsSync(topicsPath(cfg)) && !readTopics(topicsPath(cfg))[t]) unlisted = t;
  return { key, thread: isMain ? null : thread, main: isMain, mode: m, unlisted };
}

// Záznam, ktorý patrí správe s id `k` z hlavičky (`k: <id pôvodnej správy>`).
// Odpoveď nesie id pôvodnej správy presne, meno súboru odpovede môže byť
// ľubovoľné (Mac píše novú správu s novým menom). Záznam bez `id` (starší
// ako hlavičky) sa nájde cez kľúč.
function byId(items, k, me) {
  const key = routeKey(k, me);
  return items.filter((r) => r.id === k || (!r.id && r.key === key));
}

// Čaká agent na odpoveď k správe? Páruje sa len podľa `k:` z hlavičky
// (id pôvodnej správy), null, keď o tom id nič nevie alebo správa `k:` nemá.
export function waitingFor(cfg, name, now = Date.now(), k = null) {
  if (!k) return null;
  const me = cfg.name ?? "agent";
  const { sent } = readRoutes(cfg);
  const key = routeKey(k, me);
  const rec = Object.entries(sent).filter(([kk, v]) => v?.id === k || (!v?.id && kk === key)).at(-1)?.[1];
  return rec ? Boolean(rec.cakam) : null;
}

// Trasa pre správu zo schránky: len podľa `k:` z hlavičky (id pôvodnej
// správy), správa bez `k:` trasu nemá.
export function routeFor(cfg, name, k = null) {
  if (!k) return null;
  const me = cfg.name ?? "agent";
  return byId(readRoutes(cfg).routes, k, me).at(-1) ?? null;
}

export function sessionIds(env = process.env) {
  const ids = [];
  if (env.CLAUDE_CODE_SESSION_ID) ids.push(env.CLAUDE_CODE_SESSION_ID);
  if (env.CLAUDE_PID) {
    try {
      const m = readFileSync(`/proc/${env.CLAUDE_PID}/cmdline`, "utf8").match(/--resume[=\0]([0-9a-f-]{36})/);
      if (m && !ids.includes(m[1])) ids.push(m[1]);
    } catch {}
  }
  return ids;
}

// Vlákno T3 podľa id relácie claude, s pamäťou v routes.json.
export async function threadForSession(cfg, client, ids, now = Date.now()) {
  const data = readRoutes(cfg);
  for (const id of ids) if (data.sessions[id]) return data.sessions[id].thread;
  const found = await client.threadForNativeId(ids);
  if (!found) return null;
  data.sessions[found.nativeId] = { thread: found.threadId, at: new Date(now).toISOString() };
  writeRoutes(cfg, data, now);
  return found.threadId;
}

// Vlákno volajúceho podľa relácie claude. Vráti { thread } alebo { fail }.
async function callerThread(cfg) {
  const ids = sessionIds();
  if (ids.length === 0) return { fail: "bez CLAUDE_CODE_SESSION_ID" };
  try {
    const thread = await threadForSession(cfg, T3Client.fromConfig(cfg), ids);
    return thread ? { thread } : { fail: `vlákno pre reláciu ${ids.join(", ")} som v T3 nenašiel` };
  } catch (e) { return { fail: e.message }; }
}

// Kontrola odosielateľa pre ask_agent.sh (nová správa, nie odpoveď): téma
// musí byť v zozname tém odosielateľa a z vlákna témy ju smie poslať len
// vlákno, ktoré ju vedie. Bez zoznamu odosielateľa, z hlavného vlákna a keď sa
// vlákno nedá zistiť, kontrola vlákna mlčí (D0211).
async function sendCheck(cfg, topic, file) {
  if (!existsSync(file)) return 0;
  const topics = readTopics(file);
  const names = Object.keys(topics);
  if (!topics[topic]) {
    process.stderr.write(`Téma '${topic}' nie je v zozname tém odosielateľa (${file}). Platné témy: ${names.length ? names.join(", ") : "žiadna"}. Správny postup: tému ${topic} nemá žiadne vlákno, založ pre ňu nové vlákno T3 a z neho spusti route.mjs topic set ${topic} (D0211).\n`);
    return 1;
  }
  const c = await callerThread(cfg);
  if (c.fail) return 0;
  let main = "";
  try { main = readFileSync(join(cfg.state, "thread_id"), "utf8").trim(); } catch {}
  if (c.thread === main || topics[topic].thread === c.thread) return 0;
  const mine = topicsOfThread(topics, c.thread);
  process.stderr.write(`Vlákno ${c.thread} ${mine.length ? `vedie tému ${mine.join(", ")}` : "nevedie žiadnu tému"}, tému '${topic}' vedie vlákno ${topics[topic].thread}. Správny postup: o téme ${topic} píš z jej vlákna ${topics[topic].thread}${mine.length ? `, z tohto vlákna len o ${mine.join(", ")}` : ""}, novú tému začni v novom vlákne T3 a z neho spusti route.mjs topic set <téma> (D0211).\n`);
  return 1;
}

async function topicCmd(cfg, sub, args) {
  const topic = args[0]?.startsWith("--") ? undefined : args[0];
  const rest = topic === undefined ? args : args.slice(1);
  const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : ""; };
  const file = opt("--file") || topicsPath(cfg);
  if (sub === "list") {
    for (const [k, v] of Object.entries(readTopics(file))) process.stdout.write(`${k} ${v.thread}${Array.isArray(v.tasks) && v.tasks.length ? ` úlohy ${v.tasks.join(",")}` : ""}\n`);
    return 0;
  }
  if (sub === "check") {
    if (!existsSync(file)) return 0;
    const topics = readTopics(file);
    if (topic && topics[topic]) return 0;
    const names = Object.keys(topics);
    process.stderr.write(`Téma '${topic ?? ""}' nie je v zozname tém adresáta (${file}). Platné témy: ${names.length ? names.join(", ") : "žiadna"}.\n`);
    return 1;
  }
  if (!topic || !TOPIC_RE.test(topic)) { process.stderr.write(`route: téma '${topic ?? ""}' nie je snake_case\n`); return 2; }
  if (sub === "rm") {
    process.stdout.write(removeTopic(cfg, topic) ? `route: téma ${topic} zmazaná zo zoznamu\n` : `route: téma ${topic} v zozname nie je\n`);
    return 0;
  }
  if (sub === "tasks") {
    const ids = rest.filter((x) => /^\d+$/.test(x)).map(Number);
    if (!ids.length) { process.stderr.write("route: topic tasks <téma> <id>... chce aspoň jedno číslo úlohy\n"); return 2; }
    const topics = readTopics(file);
    if (!topics[topic]) { process.stderr.write(`route: téma ${topic} v zozname nie je\n`); return 1; }
    topics[topic].tasks = [...new Set([...(Array.isArray(topics[topic].tasks) ? topics[topic].tasks : []), ...ids])];
    writeTopics(file, topics);
    process.stdout.write(`route: téma ${topic} má úlohy ${topics[topic].tasks.join(", ")}\n`);
    return 0;
  }
  if (sub === "send") return sendCheck(cfg, topic, file);
  if (sub !== "set") return null;
  let thread = opt("--thread");
  if (!thread) {
    const r = await callerThread(cfg);
    if (r.fail) { process.stderr.write(`route: ${r.fail}, tému ${topic} som nezapísal\n`); return 1; }
    thread = r.thread;
  }
  let main = "";
  try { main = readFileSync(join(cfg.state, "thread_id"), "utf8").trim(); } catch {}
  if (thread === main) { process.stderr.write(`route: hlavné vlákno tému nevedie, tému ${topic} som nezapísal\n`); return 1; }
  const projects = await projectNames();
  if (projects?.has(normProject(topic))) {
    process.stderr.write(`route: téma ${topic} je holý názov projektu Taskera, tému som nezapísal. Správny postup: tému pomenuj podľa práce vlákna (napríklad ${topic}_<predmet>), holý projekt by presmeroval správy všetkých jeho úloh do jedného vlákna (D0211).\n`);
    return 1;
  }
  const topics = readTopics(file);
  const led = topicsOfThread(topics, thread).filter((x) => x !== topic);
  const owner = topics[topic]?.thread && topics[topic].thread !== thread ? topics[topic].thread : null;
  const force = rest.includes("--force");
  if (force && !String(opt("--force") ?? "").trim()) { process.stderr.write(`route: --force chce dôvod: --force "<dôvod>"\n`); return 2; }
  if (owner && !force) {
    process.stderr.write(`route: tému ${topic} vedie vlákno ${owner}, tému som nezapísal. Správny postup: tému ${topic} vedie vlákno ${owner}, píš o nej tam; prevzatie s dôvodom dovolí --force "<dôvod>" (D0211).\n`);
    return 1;
  }
  if (led.length && !force) {
    process.stderr.write(`route: vlákno ${thread} už vedie tému ${led.join(", ")}, tému ${topic} som nezapísal. Správny postup: založ pre tému ${topic} nové vlákno T3 a z neho spusti route.mjs topic set ${topic}; výnimku s dôvodom dovolí --force "<dôvod>" (D0211).\n`);
    return 1;
  }
  setTopic(cfg, topic, thread);
  process.stdout.write(`route: téma ${topic} -> ${thread}\n`);
  if (owner) process.stdout.write(`route: tému ${topic} som prevzal od vlákna ${owner} (staré vlákno ${owner}, nové vlákno ${thread}, --force: ${opt("--force")})\n`);
  if (led.length) process.stdout.write(`route: vlákno ${thread} teraz vedie témy ${[...led, topic].join(", ")} (--force: ${opt("--force")})\n`);
  return 0;
}

async function main() {
  const [cmd, name, ...rest] = process.argv.slice(2);
  const cfg = config();
  const opt0 = (k) => { const i = process.argv.indexOf(k); return i >= 0 ? process.argv[i + 1] : null; };
  if (cmd === "topic") {
    const code = await topicCmd(cfg, name, rest);
    if (code !== null) process.exit(code);
  }
  if (cmd === "show") {
    const r = routeFor(cfg, name ?? "", opt0("--k"));
    process.stdout.write(r ? `${r.thread}\n` : "");
    process.exit(r ? 0 : 1);
  }
  if (cmd === "waiting") {
    const w = waitingFor(cfg, name ?? "", Date.now(), opt0("--k"));
    process.stdout.write(w === null ? "neznáme\n" : w ? "čakám\n" : "nečakám\n");
    process.exit(w ? 0 : 1);
  }
  if (cmd !== "remember" || !name) {
    process.stderr.write("Použitie: route.mjs remember <meno správy> [--thread <id>] [--peer <agent>] [--mode čakám|nečakám|vedomie] | show <meno správy> | waiting <meno správy> | topic set|rm|list|check|send <téma>\n");
    process.exit(2);
  }
  const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : ""; };
  let thread = opt("--thread");
  const peer = opt("--peer");
  const mode = normalizeMode(opt("--mode"));
  if (opt("--mode") && !mode) { process.stderr.write(`route: neznámy --mode ${opt("--mode")}\n`); process.exit(2); }
  // Záznam sent sa zapíše aj bez vlákna: budič ho potrebuje, aj keď trasa nie je.
  let fail = "";
  if (!thread) {
    const c = await callerThread(cfg);
    if (c.fail === "bez CLAUDE_CODE_SESSION_ID") fail = "route: bez CLAUDE_CODE_SESSION_ID, trasa sa nezapísala (hlavné vlákno ju nepotrebuje)";
    else if (c.fail) fail = `route: ${c.fail}, odpoveď príde do hlavného vlákna`;
    else thread = c.thread;
  }
  const r = rememberRoute(cfg, { name, thread: thread || null, peer, mode });
  const tail = r.mode ? ` (odpoveď: ${r.mode})` : "";
  if (r.unlisted) process.stderr.write(`route: téma ${r.unlisted} v zozname tém nie je, založ pre ňu nové vlákno T3 a z neho spusti route.mjs topic set ${r.unlisted} (D0211)\n`);
  if (fail) { process.stderr.write(fail + tail + "\n"); process.exit(fail.includes("bez CLAUDE_CODE_SESSION_ID") ? 0 : 1); }
  process.stdout.write(r.main ? `route: hlavné vlákno, bez trasy (${r.key})${tail}\n` : `route: ${r.key} -> ${r.thread}${tail}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { await main(); } catch (e) { process.stderr.write(`route: ${e.message}, odpoveď príde do hlavného vlákna\n`); process.exit(1); }
}
