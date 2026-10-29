#!/usr/bin/env node
// idle_wake.mjs — Stop hook: zobudenie zo schránky, po ktorom agent nič
// nezapísal, sa samo zapíše ako chyba mechanizmu (úloha 492). Detekcia nie je
// na modeli: hook prejde záznam relácie od poslednej výzvy `<schranka ...>`
// a hľadá zapisujúci nástroj (Edit, Write, MultiEdit, NotebookEdit, Agent,
// Bash, ktorý nie je čisto čítací). Zápis do Taskera, schránky, gitu alebo
// súboru je vždy Bash alebo Edit, takže zvlášť udalosť v Taskeri netreba.
// Keď nič nenájde, založí úlohu (projekt agenti, riešiteľ = agent) s id
// správy, vláknom a dôvodom. Úloha založená agentom pre seba ho nezobudí
// (bridgeTrigger, test bridge_trigger), hlásenie sa tak nezacyklí. Jedna
// správa dá najviac jednu úlohu (stav v ${IDLE_WAKE_STATE}).
// Správa `odpoveď="na vedomie"` (hlásenie, nepíše sa na ňu) sa nepočíta.
// Pri akejkoľvek chybe kód 0 bez výstupu, hook nikdy neblokuje.
//
// poistka: zobudenie bez práce. Jadro je odosielateľ a budič, ktoré budia len
// správou, z ktorej plynie práca (úloha 519).
//
// Prostredie: AGENT_NAME (inak "# Meno" z PERSONA.md v cwd), IDLE_WAKE_STATE
// (predvolene ~/.local/state/idle_wake), IDLE_WAKE_TK (test, nahradí
// bin/tk tohto repa).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workflowDir } from "../lib/paths.mjs";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

const TK = process.env.IDLE_WAKE_TK || join(workflowDir(), "bin", "tk");
const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Agent", "Task"]);
const READ_CMDS = new Set(["ls", "cat", "head", "tail", "grep", "rg", "find", "wc", "stat", "echo", "pwd", "date", "sleep", "node", "test", "diff", "ps", "id", "tmux", "sort", "cut", "jq", "python3"]);

function text(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text").map((b) => b.text).join("\n");
}

// Čisto čítací príkaz: každý podpríkaz začína čítacím programom alebo
// `git status|log|diff|show|fetch|rev-parse` či `tk task show|list`,
// bez presmerovania do súboru, `-i` a `tee`.
export function readOnlyCommand(cmd) {
  const c = String(cmd || "");
  if (/(^|[^>&])>(?!&)|\btee\b|\bsed\b[^|;&]*\s-i|\brm\b|\bmv\b|\bcp\b|\bgit\s+(commit|push|rebase|add|reset|checkout|merge)\b|\bnode\b[^|;&]*(--test|route\.mjs|reply|ask)|reply\.sh|ask_agent|\bpython3?\b[^|;&]*-c/.test(c)) return false;
  return c.split(/&&|\|\||;|\||\n/).map((s) => s.trim()).filter(Boolean).every((s) => {
    const words = s.replace(/^(\w+=\S+\s+)+/, "").split(/\s+/);
    const w = words[0].replace(/^.*\//, "");
    if (w === "git") return /^(status|log|diff|show|fetch|rev-parse|branch|ls-files)$/.test(words.find((x, i) => i > 0 && !x.startsWith("-")) || "");
    if (w === "tk" || w === "tasker") return /\b(show|list|summary)\b/.test(s) && !/\b(comment|done|wait|resume|block|assign|add|work|route|ask|result|cancel|reopen)\b\s+\d/.test(s);
    if (w === "sed") return words.includes("-n");
    return READ_CMDS.has(w);
  });
}

// Z jsonl záznamu: posledná výzva používateľa (nie tool_result) a nástroje po nej.
export function lastTurn(lines) {
  let prompt = null;
  let tools = [];
  for (const l of lines) {
    let d;
    try { d = JSON.parse(l); } catch { continue; }
    if (d.isSidechain) continue;
    if (d.type === "user" && d.message) {
      const t = text(d.message.content);
      const isResult = Array.isArray(d.message.content) && d.message.content.some((b) => b?.type === "tool_result");
      if (isResult || !t.trim() || d.isMeta) continue;
      prompt = t;
      tools = [];
    } else if (d.type === "assistant" && Array.isArray(d.message?.content)) {
      for (const b of d.message.content) if (b?.type === "tool_use") tools.push({ name: b.name, command: b.input?.command });
    }
  }
  return { prompt, tools };
}

// Správy schránky vo výzve: [{ id, mode }], bez `na vedomie`.
export function inboxMessages(prompt) {
  if (!/^\s*<schranka\b/.test(String(prompt || ""))) return [];
  const out = [];
  for (const m of String(prompt).matchAll(/<schranka\b([^>]*)>/g)) {
    const id = m[1].match(/\bid="([^"]+)"/)?.[1];
    const mode = m[1].match(/odpoveď="([^"]*)"/)?.[1] || "";
    if (id && mode !== "na vedomie") out.push({ id, mode });
  }
  return out;
}

export function didWrite(tools) {
  return tools.some((t) => WRITE_TOOLS.has(t.name) || (t.name === "Bash" && !readOnlyCommand(t.command)));
}

function agentName(input) {
  if (process.env.AGENT_NAME) return process.env.AGENT_NAME;
  try { return readFileSync(join(input.cwd || process.cwd(), "PERSONA.md"), "utf8").match(/^# (.+)$/m)?.[1].trim().toLowerCase() || null; } catch { return null; }
}

// Vráti { msgs, tools } keď ide o zbytočné zobudenie, inak null.
export function detect(lines) {
  const { prompt, tools } = lastTurn(lines);
  const msgs = inboxMessages(prompt);
  if (!msgs.length || didWrite(tools)) return null;
  return { msgs, tools };
}

export function report(input, agent, found, stateDir) {
  const key = found.msgs.map((m) => m.id).join("+").replace(/[^\w.+-]/g, "_").slice(0, 200);
  const marker = join(stateDir, key);
  if (existsSync(marker)) return null;
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(marker, new Date().toISOString());
  const ids = found.msgs.map((m) => m.id).join(", ");
  const body = [
    "Chyba mechanizmu: zobudenie zo schránky, po ktorom agent nič nezapísal (žiadny zapisujúci nástroj, žiadna zmena v Taskeri). Zobudenie je pálenie tokenov (operátor 24. 10. 2026, úloha 492).",
    `Správa: ${ids}`,
    `Vlákno (relácia claude): ${input.session_id || "?"}`,
    `Nástroje v ťahu: ${found.tools.length ? found.tools.map((t) => t.name).join(", ") : "žiadne"} (všetky čítacie)`,
    "Dôvod: ťah po správe skončil bez zápisu. Zisti, prečo správa agenta zobudila (bridgeTrigger v runtime/tasker_events.mjs, doručenie v runtime/driver.mjs) a oprav príčinu, nie správu.",
  ].join("\n");
  const r = spawnSync(TK, ["task", "add", "--project", "agenti", "--assign", agent, "--title", `Zbytočné zobudenie: ${ids}`.slice(0, 200), "--body", body], {
    env: { ...process.env, AGENT_NAME: agent, TASKER_USER: agent }, encoding: "utf8", timeout: 8000,
  });
  return r.status === 0 ? r.stdout.trim() : null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const agent = agentName(input);
    if (agent && input.transcript_path && existsSync(input.transcript_path)) {
      const found = detect(readFileSync(input.transcript_path, "utf8").split("\n"));
      if (found) report(input, agent, found, process.env.IDLE_WAKE_STATE || join(homedir(), ".local/state/idle_wake"));
    }
  } catch {}
  process.exit(0);
}
