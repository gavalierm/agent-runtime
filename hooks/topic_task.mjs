#!/usr/bin/env node
// topic_task.mjs — PostToolUse pre Bash: úloha založená `tasker task add`
// vo vlákne témy sa sama zapíše do poľa `tasks` témy v topics.json, aby
// správy mostu Taskera o nej šli do vlákna témy, nie do hlavného (úloha 421).
// Vlákno relácie: pôvodné id relácie claude z predkov procesu (originalId
// z clear_bridge.mjs repa pravidiel) -> riadok provider_threads v SQLite T3
// (len na čítanie) -> thread_id. Vlákna `thread:project:...` aj `mcp:...`
// sú v tej istej tabuľke a v topics.json majú `thread` v rovnakom tvare.
// Hlavné vlákno tému nemá, vtedy hook nerobí nič. Vlákno mimo hlavného a bez
// témy dostane tému `<projekt>_<koniec id vlákna>` (úloha 492): správy
// o úlohe, ktorú založilo, idú do neho, nie do hlavného vlákna. Meno nenesie
// holý projekt, aby téma nepresmerovala správy všetkých úloh projektu.
// Vlákno sub-agenta (`thread:provider:`) tému nedostane. Pri akejkoľvek chybe
// skončí kódom 0 bez výstupu, nikdy neblokuje.
//
// Použitie: hook číta JSON zo stdin. `--dry-run` zápis nerobí, len vypíše tému.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { setTopic, TOPIC_RE } from "../route.mjs";
import { agentName } from "../lib/agent_name.mjs";

const RUNTIME = join(dirname(fileURLToPath(import.meta.url)), "..");
export const T3_DB = "/root/.t3/userdata/statev2.sqlite";

// Objekty JSON na najvyššej úrovni výstupu (pretty výstup `--json`, aj viac
// objektov za sebou). Reťazce so zátvorkami počíta správne.
function jsonObjects(text) {
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"' && depth > 0) inStr = true;
    else if (c === "{") { if (depth++ === 0) start = i; }
    else if (c === "}" && depth > 0 && --depth === 0) {
      try { out.push(JSON.parse(text.slice(start, i + 1))); } catch {}
    }
  }
  return out;
}

// Čísla úloh z výstupu príkazu s `tasker task add`: `--json` vypíše objekt
// úlohy s poľom id, bez neho jeden riadok s číslom (tasker lib/cli.mjs).
// Samotné číslo platí aj pri `--json`, model si id často vytiahne cez rúru.
export function isTaskAdd(command) {
  return typeof command === "string" && /\b(?:tasker|tk)\b[^\n]*\btask\s+add\b/.test(command);
}

export function newTaskIds(command, response) {
  if (!isTaskAdd(command)) return [];
  const stdout = typeof response === "string" ? response : response?.stdout;
  if (typeof stdout !== "string") return [];
  const ids = jsonObjects(stdout).filter((o) => Number.isInteger(o.id) && o.id > 0).map((o) => o.id);
  if (!ids.length) {
    for (const l of stdout.split("\n")) if (/^\d+$/.test(l.trim())) ids.push(Number(l.trim()));
  }
  return [...new Set(ids)];
}

// Okno, v ktorom je úloha "práve založená" (ms). Hook beží hneď po príkaze.
export const RECENT_MS = 60000;

function defaultTk(agent) {
  return (args) => execFileSync(process.env.TK_BIN || "/opt/agent-rules/bin/tk", args, { env: { ...process.env, AGENT_NAME: agent }, encoding: "utf8", timeout: 15000, maxBuffer: 64 * 1024 * 1024 });
}

// Záloha pre výstup, z ktorého sa id nedá prečítať (príkaz ho prefiltroval
// rúrou, presmeroval alebo zahodil): úlohy, ktorých udalosť `created` je
// z posledných RECENT_MS a jej aktér je tento agent (`human:<meno>`). Číta
// len cez `tk task list|show --json`. Pri `--title` zadanom ako holý
// reťazec v úvodzovkách musí sedieť aj názov. Bez mena agenta nič nehádam.
// Vráti [{ id, project }], pri akejkoľvek chybe [].
export function recentTasks(command, { agent, now = Date.now(), tk = defaultTk(agent), windowMs = RECENT_MS } = {}) {
  if (!agent) return [];
  try {
    const list = JSON.parse(tk(["task", "list", "--json"]));
    const title = String(command || "").match(/--title[= ]\s*(?:"([^"$`\\]*)"|'([^']*)')/);
    const wanted = title ? (title[1] ?? title[2]) : null;
    const out = [];
    for (const t of Array.isArray(list) ? list : []) {
      if (!Number.isInteger(t?.id) || !(t.created_at >= now - windowMs)) continue;
      if (wanted !== null && t.title !== wanted) continue;
      const events = JSON.parse(tk(["task", "show", String(t.id), "--json"])).events ?? [];
      if (events.some((e) => e.kind === "created" && e.actor === `human:${agent}` && e.at >= now - windowMs)) out.push({ id: t.id, project: t.project || null });
    }
    return out;
  } catch { return []; }
}

// Vlákna T3, ktorých providerThread nesie dané natívne id relácie claude.
export function threadsForNative(nativeId, dbPath = T3_DB) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare("SELECT DISTINCT thread_id FROM orchestration_v2_projection_provider_threads WHERE json_extract(payload_json, '$.nativeThreadRef.nativeId') = ? AND thread_id IS NOT NULL").all(nativeId).map((r) => r.thread_id);
  } finally { db.close(); }
}

export function topicOfThreads(topics, threads) {
  for (const [name, v] of Object.entries(topics ?? {})) if (v?.thread && threads.includes(v.thread)) return name;
  return null;
}

function defaultMainFile() {
  const state = process.env.AGENT_STATE || join(process.env.HOME || "/root", `.local/state/${process.env.AGENT_NAME || "agent"}`);
  return join(state, "thread_id");
}

// Projekt založenej úlohy: pole `project` z `--json`, inak `--project X` z príkazu.
export function newTaskProject(command, response) {
  const stdout = typeof response === "string" ? response : response?.stdout;
  const fromJson = typeof stdout === "string" ? jsonObjects(stdout).find((o) => typeof o.project === "string" && o.project)?.project : null;
  return fromJson || String(command || "").match(/--project[= ]\s*["']?([\w-]+)/)?.[1] || null;
}

// Meno témy pre vlákno bez témy: projekt a koniec id vlákna, vždy snake_case.
export function topicNameFor(project, thread, topics = {}) {
  const tail = String(thread).replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-6) || "vlakno";
  const base = String(project || "uloha").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^[^a-z]+/, "").slice(0, 30) || "uloha";
  let name = `${base}_${tail}`;
  for (let i = 2; topics[name] && topics[name].thread !== thread; i++) name = `${base}_${tail}${i}`;
  return TOPIC_RE.test(name) ? name : null;
}

function defaultNativeId() {
  return import("file:///opt/agent-rules/hooks/clear_bridge.mjs").then((m) => m.originalId(process.ppid));
}

function defaultTopicsFile() {
  return process.env.AGENT_TOPICS_FILE || join(process.env.AGENT_BOX || `/var/lib/${process.env.AGENT_NAME || "agent"}`, "topics.json");
}

// Vráti { topic, ids } alebo null. Zápis cez `route.mjs topic tasks`.
export async function handle(input, { nativeId, dbPath = T3_DB, topicsFile = defaultTopicsFile(), mainFile = defaultMainFile(), dryRun = false, write, tk, now, agent } = {}) {
  const command = input?.tool_input?.command;
  if (!isTaskAdd(command)) return null;
  let ids = newTaskIds(command, input?.tool_response);
  const id = nativeId === undefined ? await defaultNativeId() : nativeId;
  if (!id) return null;
  const threads = threadsForNative(id, dbPath);
  if (!threads.length) return null;
  let fallbackProject = null;
  // Záloha (tk) sa volá až po kontrole vlákna: hlavné vlákno a sub-agent ju nespustia.
  const resolveIds = () => {
    if (ids.length) return;
    const found = recentTasks(command, { agent: agent === undefined ? agentName(input) : agent, ...(tk && { tk }), ...(now !== undefined && { now }) });
    ids = found.map((t) => t.id);
    fallbackProject = found.find((t) => t.project)?.project ?? null;
  };
  const topics = existsSync(topicsFile) ? JSON.parse(readFileSync(topicsFile, "utf8")) : {};
  let topic = topicOfThreads(topics, threads);
  let created = false;
  if (!topic) {
    let main = "";
    try { main = readFileSync(mainFile, "utf8").trim(); } catch {}
    const thread = threads.find((t) => t !== main && !t.startsWith("thread:provider:"));
    if (!thread || threads.includes(main)) return null;
    resolveIds();
    if (!ids.length) return null;
    topic = topicNameFor(newTaskProject(command, input.tool_response) || fallbackProject, thread, topics);
    if (!topic) return null;
    if (!dryRun) setTopic({ topicsFile }, topic, thread);
    topics[topic] = { thread };
    created = true;
  }
  resolveIds();
  if (!ids.length) return null;
  const have = Array.isArray(topics[topic].tasks) ? topics[topic].tasks.map(Number) : [];
  const fresh = ids.filter((n) => !have.includes(n));
  if (!fresh.length) return { topic, ids: [], dryRun, created };
  if (!dryRun) {
    (write ?? ((t, list, file) => execFileSync("node", [join(RUNTIME, "route.mjs"), "topic", "tasks", t, ...list.map(String), "--file", file], { stdio: "ignore", timeout: 10000 })))(topic, fresh, topicsFile);
  }
  return { topic, ids: fresh, dryRun, created };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const dryRun = process.argv.includes("--dry-run");
    const r = await handle(input, { dryRun });
    if (r?.ids.length) {
      const text = `${r.ids.length > 1 ? "úlohy" : "úloha"} ${r.ids.join(", ")} ${dryRun ? "by sa zapísala" : "zapísaná"} do témy ${r.topic}${r.created ? " (téma založená pre toto vlákno)" : ""}`;
      process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } }) + "\n");
    } else if (r && dryRun) process.stdout.write(`téma ${r.topic}\n`);
  } catch {}
  process.exit(0);
}
