#!/usr/bin/env node
// requires: tasker
// tasker_work.mjs — práca sub-agenta alebo hlavného vlákna na úlohe Taskera sa
// zapíše do Taskera príkazom `tasker work` (úloha Taskera 414, 472). Je to
// záznam kto kedy pracoval. Podľa D0164 (úloha 485) `tasker work` stav úlohy
// nemení a o koliesku na webe nerozhoduje: stav menia len príkazy (prevzatie,
// ask, block, wait, done) a koliesko znamená len živý beh (beh dispečera alebo
// vlákno T3 s bežiacim behom pri stave rozpracované). Hook preto stav
// nepredpokladá a pri `needs_human` len komentuje podľa pravidla nižšie.
//
// Tvar vstupu (Claude Code 2.1.309, skúška 23. 10. 2026 v relácii `claude -p`
// s HOME v /tmp, aj pre run_in_background):
//  - PreToolUse, tool_name "Agent" (starý názov "Task"): session_id, cwd,
//    tool_use_id, tool_input.{description, prompt, run_in_background}.
//    Bez agent_id, hook nevie, ktorý sub-agent z neho vznikne.
//  - SubagentStart: session_id, agent_id, agent_type. Bez zadania.
//  - SubagentStop: session_id, agent_id, agent_transcript_path, bez zadania.
//    Beží aj pre sub-agenta na pozadí, v čase konca jeho behu. Zadanie je
//    prvá správa v agent_transcript_path (jsonl), popis a tool_use_id
//    v súbore vedľa neho (agent-<id>.meta.json).
//
// PreToolUse nájde v zadaní číslo úlohy a zavolá `tasker work N --thread
// <session_id>`, uloží záznam <tool_use_id> -> N. SubagentStop záznam zmaže
// a keď v relácii nezostal iný sub-agent s tou istou úlohou, zavolá
// `tasker work N --stop`. Bez čísla úlohy, bez mena agenta alebo pri chybe
// hook mlčí, nikdy nezablokuje nástroj, kód 0. Na Macu nie je runuser ani
// tasker, hook tam nerobí nič.
//
// Práca v hlavnom vlákne (úloha Taskera 472): UserPromptSubmit nájde číslo
// úlohy vo výzve a uloží ho ako aktuálnu úlohu relácie (výzva bez čísla stav
// nemení). Prvý zapisujúci nástroj (Bash, Edit, Write, MultiEdit,
// NotebookEdit) potom ohlási `tasker work N --thread <relácia>`, najviac raz za
// 60 minút. Ak je úloha `needs_human` a jej riešiteľ je agent, hook ju najprv
// vráti do poradia (handoff) komentárom od agenta (`tasker comment`, komentár riešiteľa
// úlohu zobudí do poradia a budič ho nepošle späť agentovi). Výnimka: výzva, ktorá
// je správa schránky (`<schranka ...`, napríklad od Taskera k úlohe 482), nie
// je odpoveď operátora. Hook k číslu uloží príznak `inbox` a pri `needs_human`
// nepíše komentár ani `work`, otázka na operátora ostáva. Príznak zruší
// ďalšia výzva bez schránky (s číslom aj bez). Úlohu v poradí (queued, scheduled, handoff, unassigned) s riešiteľom agentom
// hook pri prvom zápise prevezme príkazom `tasker start N` (úloha Taskera 491). Stav:
// ${XDG_CACHE_HOME:-$HOME/.cache}/agentic-workflow/tasker_work_current/<relácia>.
//
// Zámok úlohy (úloha Taskera 510): PreToolUse pre Agent so zadaním "úloha N"
// zamietne spustenie, keď úloha N má v udalostiach `work` (`tasker task show N
// --json`) živú prácu inej relácie: `start`/`extend` s `until` v budúcnosti a
// `thread` inej relácie než tá, čo spúšťa sub-agenta, bez neskoršieho `work_stop`
// toho istého aktéra a bez neskoršej zmeny stavu na done, cancelled, needs_human
// alebo waiting (tá prácu ukončí). Vlastná relácia prejde. Rovnaká kontrola stojí
// pri prevzatí v hlavnom vlákne (writeTool, úloha 491): úloha držaná inou reláciou
// sa neprevezme (bez `start`, komentára a `work`), nástroj prejde a hook
// vypíše additionalContext, kto úlohu drží. Chyba čítania
// Taskera, neplatný JSON alebo záznam bez `thread` zámok nespustí (fail open).
// Relácia toho istého vlákna po /clear (T3 dá nové session_id, transcript jedného
// id je symlink na druhý) nie je cudzia (sameSession). Chyba 25. 10. 2026 pri
// úlohe 595: vlastné vlákno po /clear ohlásilo, že úlohu drží jeho stará relácia.
// Chyba 28. 10. 2026 (úloha 656): po druhom /clear je predošlý prepis obyčajný
// súbor, symlinky nestačia. clear_bridge.mjs zapisuje reťaz id do
// `<pôvodné id>.sessions` v priečinku prepisov a sameSession ju číta
// (chainedSessions z lib/session_id.mjs).
//
// Meno agenta: AGENT_NAME, inak "# Meno" z PERSONA.md v projekte (malými).
// Obal `tk` je AGENT_TK, inak `bin/tk` v klone kódu (workflowDir v lib/paths.mjs). TASKER_WORK_CMD (test) ho nahradí priamym spustením
// zadaného príkazu s TASKER_USER v prostredí.
// Stav: ${XDG_CACHE_HOME:-$HOME/.cache}/agentic-workflow/tasker_work/<relácia>/<tool_use_id>.

import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, rmSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { denyTool } from "../lib/deny.mjs";
import { hookEnv } from "../lib/agent_env.mjs";
import { workflowDir } from "../lib/paths.mjs";
import { chainedSessions } from "../lib/session_id.mjs";

const TIMEOUT_MS = 2500;
// "úloha N", "úlohy N", "úlohe N", "úlohu N", "úlohou N", "/tasks/N", "#N".
const TASK_RE = /(?<![\p{L}\d])úloh(?:a|y|e|u|ou)\s+#?(\d+)|\/tasks\/(\d+)|(?<![\p{L}\d&])#(\d+)/giu;

// Všetky čísla úloh v texte v poradí výskytu bez opakovania, aj výčet
// "úlohy 485 a 486", "úlohy 485, 486", "úloha 485 aj #486" (úloha Taskera 492).
const LIST_RE = /(?<![\p{L}\d])úloh(?:a|y|e|u|ou)\s+(#?\d+(?:\s*(?:,|a|aj|i|\+|\/)\s*#?\d+)*)/giu;
export function taskNumbers(text) {
  const t = String(text || "");
  const found = [];
  const add = (n) => { if (Number.isFinite(n) && !found.includes(n)) found.push(n); };
  const hits = [];
  for (const m of t.matchAll(LIST_RE)) for (const d of m[1].matchAll(/\d+/g)) hits.push([m.index, Number(d[0])]);
  TASK_RE.lastIndex = 0;
  for (const m of t.matchAll(TASK_RE)) hits.push([m.index, Number(m[1] || m[2] || m[3])]);
  TASK_RE.lastIndex = 0;
  for (const [, n] of hits.sort((a, b) => a[0] - b[0])) add(n);
  return found;
}

// Prvé číslo úlohy v texte alebo null.
export function taskNumber(text) {
  TASK_RE.lastIndex = 0;
  const found = TASK_RE.exec(String(text || ""));
  TASK_RE.lastIndex = 0;
  return found ? Number(found[1] || found[2] || found[3]) : null;
}

export function agentName(input, env = process.env) {
  if (env.AGENT_NAME) return env.AGENT_NAME;
  try {
    const root = env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
    return readFileSync(join(root, "PERSONA.md"), "utf8").match(/^# (.+)$/m)?.[1].trim().toLowerCase() || null;
  } catch {
    return null;
  }
}

// Spustí `tk <argv>` (alebo TASKER_WORK_CMD) a vráti stdout alebo "".
export function tk(agent, argv, env = process.env) {
  const cmd = env.TASKER_WORK_CMD;
  const henv = hookEnv({}, { AGENT_NAME: agent, ...env });
  const run = cmd ? [cmd, argv] : [henv.AGENT_TK || join(workflowDir(henv), "bin", "tk"), argv];
  const r = spawnSync(run[0], run[1], { env: { ...env, AGENT_NAME: agent, TASKER_USER: agent }, timeout: TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });
  return r.stdout || "";
}

const tasker = (agent, args, env = process.env) => void tk(agent, ["work", ...args], env);

function stateDir(session, env = process.env) {
  const base = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
  return join(base, "agentic-workflow", "tasker_work", String(session).replace(/[^\w-]/g, "_"));
}

const safeId = (s) => String(s || "").replace(/[^\w-]/g, "_");

const WRITE_TOOLS = new Set(["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"]);
const REPORT_EVERY_MS = 60 * 60_000;

export function currentFile(session, env = process.env) {
  const base = env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache");
  return join(base, "agentic-workflow", "tasker_work_current", String(session).replace(/[^\w-]/g, "_"));
}

function saveCurrent(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(value));
  renameSync(`${file}.tmp`, file);
}

// Výzva je správa schránky (budič ju vloží ako `<schranka ...>`), nie slovo operátora.
const isInbox = (text) => /^\s*<schranka\b/.test(String(text || ""));

function userPrompt(input) {
  if (!input.session_id) return;
  const n = taskNumber(input.prompt);
  const inbox = isInbox(input.prompt);
  const file = currentFile(input.session_id);
  let cur = null;
  try { cur = JSON.parse(readFileSync(file, "utf8")); } catch {}
  if (n === null) {
    // Slovo operátora bez čísla zruší príznak schránky, číslo ostáva (aj `at`).
    if (cur && cur.inbox && !inbox) saveCurrent(file, { n: cur.n, reportedAt: 0, ...(cur.at ? { at: cur.at } : {}) });
    return;
  }
  if (cur && cur.n === n && !!cur.inbox === inbox) return;
  // `at`: čas, odkedy relácia na úlohe pracuje (nové číslo), hook task_fresh.mjs z neho
  // počíta záznamy úlohy, ktoré relácia ešte nečítala. Rovnaké číslo si čas ponechá.
  const at = cur && cur.n === n && cur.at ? cur.at : Date.now();
  saveCurrent(file, inbox ? { n, reportedAt: 0, inbox: true, at } : { n, reportedAt: 0, at });
}

// Práca v hlavnom vlákne: ohlási aktuálnu úlohu relácie pri zapisujúcom nástroji.
function writeTool(input) {
  if (!input.session_id) return;
  const file = currentFile(input.session_id);
  let cur;
  try { cur = JSON.parse(readFileSync(file, "utf8")); } catch { return; }
  if (!cur || !Number.isFinite(cur.n)) return;
  const now = Date.now();
  if (cur.reportedAt && now - cur.reportedAt < REPORT_EVERY_MS) return;
  const agent = agentName(input);
  if (!agent) return;
  // Zápis pred volaním: pomalý alebo padnutý Tasker nespôsobí volanie pri každom nástroji.
  saveCurrent(file, { ...cur, reportedAt: now });
  const n = String(cur.n);
  try {
    const t = JSON.parse(tk(agent, ["task", "show", n, "--json"]));
    // Zámok (úloha 510): úlohu drží iná relácia, bez `start`, komentára aj `work`, hlásenie bez zamietnutia nástroja.
    const h = foreignHolder(t.events, input.session_id, Date.now(), ownCheck(input));
    if (h) {
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext:
        `Úlohu ${n} drží relácia ${h.thread} do ${new Date(h.until).toISOString()} (udalosť work v Taskeri). Táto relácia ${input.session_id} ju neprevzala (bez tasker start a work). Nechaj ju tej relácii alebo počkaj na jej koniec (\`tk task show ${n} --json\`).` } }));
      return;
    }
    if (t.status === "needs_human" && String(t.assignee || "").toLowerCase() === agent) {
      // Správa schránky nie je odpoveď operátora, otázka na neho ostáva.
      if (cur.inbox) return;
      tk(agent, ["comment", n, "--body", "Pracujem na úlohe vo vlákne. Komentár ju vracia z needs_human do poradia, keď ju nedrží bloker."]);
    }
    // Prevzatie (úloha 491): úloha v poradí s riešiteľom agentom ide príkazom `start` do in_progress.
    if (["queued", "scheduled", "handoff", "unassigned"].includes(t.status) && String(t.assignee || "").toLowerCase() === agent) tk(agent, ["start", n]);
  } catch {}
  tasker(agent, [n, "--thread", String(input.session_id)]);
}

// Rovnaká relácia: rovnaké id, alebo transcripty oboch id v priečinku `dir` ukazujú na ten istý
// súbor (po /clear je jeden symlink na druhý), alebo ich spája reťaz v `*.sessions`
// (po druhom /clear, úloha 656). Chyba realpath: cudzia (fail open).
export function sameSession(a, b, dir) {
  if (String(a) === String(b)) return true;
  try {
    if (realpathSync(join(dir, `${a}.jsonl`)) === realpathSync(join(dir, `${b}.jsonl`))) return true;
  } catch {}
  return chainedSessions(dir, a).has(String(b)) || chainedSessions(dir, b).has(String(a));
}

// Porovnanie držiteľa s touto reláciou: podľa priečinka transcriptu, bez neho len reťazce.
function ownCheck(input) {
  const session = String(input.session_id);
  if (!input.transcript_path) return (t) => t === session;
  const dir = dirname(String(input.transcript_path));
  return (t) => sameSession(t, session, dir);
}

// Živá práca inej relácie na úlohe z udalostí Taskera: { thread, until } alebo null.
export function foreignHolder(events, session, nowMs = Date.now(), isOwn = (t) => t === String(session)) {
  const held = new Map(); // aktér -> { thread, until }
  const ordered = [...(events || [])].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  for (const e of ordered) {
    if (e.kind === "work") {
      const m = String(e.detail || "").match(/^(start|extend) until (\S+)(?: thread (\S+))?/);
      const until = m ? Date.parse(m[2]) : NaN;
      if (!m || !Number.isFinite(until)) continue;
      const prev = held.get(e.actor);
      held.set(e.actor, { thread: m[3] || (m[1] === "extend" ? prev?.thread : null) || null, until });
    } else if (e.kind === "work_stop") held.delete(e.actor);
    else if (["done", "cancelled", "needs_human", "waiting"].includes(e.to_status)) held.clear();
  }
  for (const h of held.values()) if (h.thread && !isOwn(h.thread) && h.until > nowMs) return h;
  return null;
}

// Zamietne spustenie sub-agenta na úlohe, ktorú drží iná relácia. Vráti true pri zamietnutí.
function lockedByOther(input, agent, ns) {
  for (const n of ns) {
    let t;
    try { t = JSON.parse(tk(agent, ["task", "show", String(n), "--json"])); } catch { continue; }
    const h = foreignHolder(t?.events, input.session_id, Date.now(), ownCheck(input));
    if (!h) continue;
    denyTool(
      `Úlohu ${n} drží relácia ${h.thread} do ${new Date(h.until).toISOString()} (udalosť work v Taskeri). Sub-agent z relácie ${input.session_id} by ju robil súbežne s ňou.`,
      `nezadávaj úlohu ${n} sub-agentovi, nechaj ju relácii ${h.thread} a pozri \`tk task show ${n} --json\` (udalosti work). Zadaj ju, až keď práca skončí (work_stop, zmena stavu) alebo uplynie čas do.`,
    );
    return true;
  }
  return false;
}

function preToolUse(input) {
  if (WRITE_TOOLS.has(input.tool_name)) return writeTool(input);
  if (input.tool_name !== "Agent" && input.tool_name !== "Task") return;
  const ti = input.tool_input || {};
  const ns = taskNumbers(`${ti.prompt || ""}\n${ti.description || ""}`);
  const agent = agentName(input);
  if (!ns.length || !agent || !input.session_id) return;
  if (lockedByOther(input, agent, ns)) return;
  const dir = stateDir(input.session_id);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, safeId(input.tool_use_id || `n${Date.now()}`));
  writeFileSync(`${file}.tmp`, ns.join("\n"));
  renameSync(`${file}.tmp`, file);
  for (const n of ns) tasker(agent, [String(n), "--thread", String(input.session_id)]);
}

// Čísla úloh zo záznamu stavu sub-agenta (jedno na riadok, starý tvar jedno číslo).
const readNs = (file) => readFileSync(file, "utf8").split("\n").map(Number).filter((n) => Number.isFinite(n) && n > 0);

// Číslo úlohy a tool_use_id sub-agenta z jeho záznamu.
function subagentTask(input) {
  const path = String(input.agent_transcript_path || "");
  let toolUseId = null;
  let text = "";
  try {
    const meta = JSON.parse(readFileSync(path.replace(/\.jsonl$/, ".meta.json"), "utf8"));
    toolUseId = meta.toolUseId || null;
    text = meta.description || "";
  } catch {}
  try {
    const first = JSON.parse(readFileSync(path, "utf8").split("\n", 1)[0]);
    const c = first?.message?.content;
    const prompt = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => b?.text || "").join("\n") : "";
    text = `${prompt}\n${text}`;
  } catch {}
  return { toolUseId, ns: taskNumbers(text) };
}

function subagentStop(input) {
  if (!input.session_id) return;
  const dir = stateDir(input.session_id);
  let entries;
  try {
    entries = readdirSync(dir).filter((f) => !f.endsWith(".tmp"));
  } catch {
    return;
  }
  const { toolUseId, ns: fromText } = subagentTask(input);
  const own = toolUseId && entries.includes(safeId(toolUseId)) ? safeId(toolUseId) : null;
  let mine = own;
  let ns = fromText;
  if (own) ns = readNs(join(dir, own));
  else {
    // Bez vlastného záznamu: prvý záznam, ktorý nesie niektoré z čísel v zadaní.
    mine = entries.find((f) => readNs(join(dir, f)).some((x) => ns.includes(x))) || null;
    if (mine) ns = readNs(join(dir, mine));
  }
  if (!ns.length || !mine) return;
  rmSync(join(dir, mine), { force: true });
  const agent = agentName(input);
  if (!agent) return;
  for (const n of ns) {
    const held = entries.some((f) => f !== mine && readNs(join(dir, f)).includes(n));
    if (!held) tasker(agent, [String(n), "--stop"]);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    if (input.hook_event_name === "UserPromptSubmit") userPrompt(input);
    else if (input.hook_event_name === "PreToolUse") preToolUse(input);
    else if (input.hook_event_name === "SubagentStop") subagentStop(input);
  } catch {}
  process.exit(0);
}
