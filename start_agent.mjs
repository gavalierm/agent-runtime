#!/usr/bin/env node
// Založí trvalé vlákno agenta v T3 Code serveri a jeho id
// uloží do $AGENT_STATE/thread_id, odkiaľ ho číta budič. Spúšťa ho vlastník
// T3 servera raz pri nasadení, nie pri každom štarte stroja: vlákno aj jeho
// front správ prežijú reštart T3 servera. Náhradné nové vlákno, keď T3 /clear
// pri čistom kontexte odmietne, zakladá budič sám (supervise.mjs) tou istou
// funkciou launchAgentThread.
//
// 1. Keď thread_id ukazuje na živé vlákno, nerobí nič (kód 0). --new
//    založí nové aj tak, staré ostane v T3 a treba ho archivovať ručne.
// 2. Projekt T3 je adresár klonu repa agenta (AGENT_WORKDIR). Existujúci
//    projekt s tým adresárom použije, inak ho založí.
// 3. orchestration.launchThread s úvodnou správou, ktorá agenta naštartuje
//    podľa jeho persony.
//
// Premenné AGENT_*: AGENT_NAME (agent), AGENT_TITLE,
// AGENT_WORKDIR (~/agenti/<meno>), AGENT_MODEL (povinné, model Claude),
// AGENT_T3_INSTANCE (claudeAgent), AGENT_RUNTIME_MODE (auto).
// Použitie: start_agent.mjs [--new]
import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config, ensureDir, T3Client } from "./lib.mjs";

export function startPrompt(title = "Agent", replyCmd = "reply.sh") {
  return [
    `Si ${title}. Toto vlákno je tvoj trvalý beh na serveri.`,
    "Prečítaj PERSONA.md, CLAUDE.md a memory/MEMORY.md v tomto repe a urob štart relácie podľa nich (git fetch a rebase, pamäť).",
    `Správy zo schránky prichádzajú ako <schranka od=... id=...>. Na každú, ktorá chce odpoveď, odpovedz príkazom z jej hlavičky (${replyCmd}).`,
    "Na túto správu odpovedz jednou vetou, že bežíš.",
  ].join("\n");
}

export const START_PROMPT = startPrompt();

// Titulok vlákna s dátumom a časom, napríklad "Agent 2026-10-18 14:05".
export function datedTitle(title, d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${title} ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// orchestration.launchThread. Rovnaké commandId vráti to isté vlákno
// (ThreadLaunchService.ts, reusableLaunchReceipt), opakovanie po páde
// budiča preto nezaloží druhé.
export async function launchAgentThread(client, { commandId, projectId, title, modelSelection, runtimeMode, interactionMode = "default", text }) {
  const res = await client.launchThread({
    commandId,
    projectId,
    title,
    modelSelection,
    runtimeMode,
    interactionMode,
    workspaceStrategy: { type: "root" },
    initialMessage: { text, attachments: [] },
  });
  if (!res?.threadId) throw new Error(`launchThread nevrátil threadId: ${JSON.stringify(res).slice(0, 300)}`);
  return res.threadId;
}

// Zápis id vlákna cez dočasný súbor a rename, budič nikdy nečíta polovičné id.
export function writeThreadId(state, threadId) {
  const path = join(state, "thread_id");
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${threadId}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

export async function start(cfg, client, env = process.env, { forceNew = false } = {}) {
  const c = { ...config(env), ...cfg };
  ensureDir(c.state);
  const statePath = join(c.state, "thread_id");
  let current = "";
  try { current = readFileSync(statePath, "utf8").trim(); } catch {}
  if (current && !forceNew) {
    const t = await client.thread(current);
    if (t && !t.archived) return { threadId: current, created: false };
  }
  if (!c.model) throw new Error("Chýba AGENT_MODEL (model Claude pre vlákno agenta).");

  let project = (await client.projects()).find((p) => p.workspaceRoot === c.workdir && !p.deletedAt);
  if (!project) project = await client.createProject({ title: c.title, workspaceRoot: c.workdir });

  const threadId = await launchAgentThread(client, {
    commandId: randomUUID(),
    projectId: project.id,
    title: c.title,
    modelSelection: { instanceId: c.t3Instance, model: c.model },
    runtimeMode: c.runtimeMode,
    text: startPrompt(c.title, c.replyCmd),
  });
  writeThreadId(c.state, threadId);
  return { threadId, projectId: project.id, created: true };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = config();
  try {
    const r = await start(cfg, T3Client.fromConfig(cfg), process.env, { forceNew: process.argv.includes("--new") });
    console.log(r.created ? `Vlákno ${cfg.title} založené: ${r.threadId} (projekt ${r.projectId})` : `Vlákno ${cfg.title} už beží: ${r.threadId}`);
  } catch (e) {
    console.error(`start_agent: ${e.message}`);
    process.exit(1);
  }
}
