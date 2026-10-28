// Meno agenta a persona pre hooky: TASKER_USER, AGENT_NAME, inak "# Meno"
// z PERSONA.md v projekte (malými). Vlákno T3 agenta nemá TASKER_USER ani
// AGENT_NAME, meno nesie len persona (úloha Taskera 425).
//
// Vlákno témy agenta (28. 10. 2026, úloha 636) beží v klone projektu bez
// PERSONA.md, po kompakcii zabudlo, kto je, a správu Taskera "úloha pre
// teba" odmietlo ako cudziu. personaFor preto bez PERSONA.md v koreni nájde
// vlákno relácie v T3 (pôvodné id relácie claude, lib/session_id.mjs) a jeho
// tému v topics.json agentov (/var/lib/<agent>/topics.json); persona je
// /root/<agent>/PERSONA.md. Vyhľadanie vlákna používa aj hooks/topic_task.mjs.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { originalId } from "./session_id.mjs";

export const T3_DB = "/root/.t3/userdata/statev2.sqlite";
export const TOPICS_DIR = "/var/lib";
export const HOMES_DIR = "/root";

export function agentName(input = {}, env = process.env) {
  if (env.TASKER_USER) return env.TASKER_USER;
  if (env.AGENT_NAME) return env.AGENT_NAME;
  return readPersona(env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd())?.agent ?? null;
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

// { name, agent, root, persona, topic: null } z PERSONA.md v koreni, inak null.
export function readPersona(root) {
  try {
    const persona = readFileSync(join(root, "PERSONA.md"), "utf8");
    const name = persona.match(/^# (.+)$/m)?.[1].trim();
    return name ? { name, agent: name.toLowerCase(), root, persona, topic: null } : null;
  } catch { return null; }
}

// { agent, topic } z topics.json agentov pre vlákna T3 relácie, inak null.
export function topicOwner(threads, { topicsDir = TOPICS_DIR } = {}) {
  if (!threads?.length) return null;
  let agents = [];
  try { agents = readdirSync(topicsDir); } catch { return null; }
  for (const agent of agents) {
    let topics;
    try { topics = JSON.parse(readFileSync(join(topicsDir, agent, "topics.json"), "utf8")); } catch { continue; }
    const topic = topicOfThreads(topics, threads);
    if (topic) return { agent, topic };
  }
  return null;
}

// Persona relácie: vlastná z koreňa projektu, inak persona agenta, ktorého
// vlákno témy to je (pole topic nesie meno témy). Skúšky: `threads` alebo
// AGENT_THREADS (id vlákien cez čiarku), AGENT_TOPICS_DIR, AGENT_HOMES_DIR;
// inak T3, /var/lib a /root. Pri chybe null, nikdy nepadne.
export function personaFor(input = {}, env = process.env, { threads, topicsDir = env.AGENT_TOPICS_DIR || TOPICS_DIR, homesDir = env.AGENT_HOMES_DIR || HOMES_DIR, dbPath = T3_DB } = {}) {
  const own = readPersona(env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
  if (own) return own;
  try {
    const list = threads ?? (env.AGENT_THREADS !== undefined ? env.AGENT_THREADS.split(",").filter(Boolean) : threadsForNative(originalId(), dbPath));
    const owner = topicOwner(list, { topicsDir });
    if (!owner) return null;
    const p = readPersona(join(homesDir, owner.agent));
    return p ? { ...p, agent: owner.agent, topic: owner.topic } : null;
  } catch { return null; }
}
