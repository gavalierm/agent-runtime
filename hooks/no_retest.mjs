#!/usr/bin/env node
// no_retest.mjs — hlavné vlákno nespúšťa testy, ktoré sub-agent práve spustil
// a vrátil ich výstup (global §6). Úloha Taskera 507, 24. 10. 2026:
// po sub-agentovi s "# pass 369, # fail 0" hlavné vlákno spustilo tie isté
// testy znova, druhé volanie modelu s veľkým kontextom a minúty čakania.
//
// PreToolUse pre Bash. Vstup s agent_id (volá sub-agent) hook pustí. Zamietne
// testovací príkaz, keď posledná správa sub-agenta (výsledok nástroja Agent
// alebo Task, alebo <task-notification> sub-agenta na pozadí) nesie výstup
// testov a hlavné vlákno po nej nič nezapísalo. Chyba čítania: pustí.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { denyTool } from "../lib/deny.mjs";
import { bashWrites, toolUses, readEntries } from "./sonnet_delegation.mjs";
import { stripHeredocs } from "./no_model_wait.mjs";
import { segments } from "./rm_target.mjs";

export const TEST_CMD =
  /\bnpm\s+test\b|\bnpm\s+run\s+test\b|\bnode\s+(?:\S+\s+)*--test\b|\bnode\s+check\.mjs\b|\bpytest\b|\bgo\s+test\b|\bcargo\s+test\b/;

// Obálky, za ktorými príkaz pokračuje: `timeout 300 npm test`, `sudo -u X node --test`.
const WRAP = new Set(["env", "time", "nohup", "command", "exec", "nice", "ionice", "stdbuf", "sudo", "runuser", "timeout", "!", "{", "if", "then", "elif", "else", "do", "while", "until"]);
const SHELL = /^(?:ba|da|z)?sh$/;
const base = (t) => t.replace(/^.*\//, "");
const TEST_AT_START = new RegExp(`^(?:${TEST_CMD.source})`);

// Úloha 601: testovací príkaz sa hľadá len v pozícii príkazu (začiatok, za
// `;`, `&&`, `||`, `|`, `(`, `$(`, za `cd X &&`, premennými `A=b` a obálkami),
// nie v úvodzovkách ani v heredoc. Chyba 25. 10. 2026: `tk done --summary
// "... node --test ..."` a `grep -n "node --test"` boli zamietnuté. Skutočné
// spustenie pod `bash -c "npm test"` a v `$(...)` zamietam tiež, test ide.
export function isTestCommand(raw, depth = 0) {
  if (depth > 3) return false;
  for (const toks of segments(stripHeredocs(String(raw ?? "")))) {
    let i = 0;
    while (i < toks.length) {
      const b = base(toks[i].val);
      if (/^[A-Za-z_]\w*=/.test(toks[i].val)) { i++; continue; }
      if (!WRAP.has(b)) break;
      i++;
      while (i < toks.length && /^-/.test(toks[i].val)) {
        const o = toks[i].val;
        i++;
        if (/^-(u|g|n|s)$/.test(o) && (b === "sudo" || b === "runuser" || b === "ionice" || b === "nice")) i++;
      }
      if (b === "timeout" && /^\d/.test(toks[i]?.val ?? "")) i++;
      if (b === "runuser" && toks[i]?.val === "--") i++;
    }
    for (const t of toks) {
      for (const m of t.exp.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) if (isTestCommand(m[1] ?? m[2], depth + 1)) return true;
    }
    if (i >= toks.length) continue;
    if (SHELL.test(base(toks[i].val))) {
      const c = toks.findIndex((x, k) => k > i && /^-[a-z]*c$/.test(x.val));
      if (c >= 0 && toks[c + 1] && isTestCommand(toks[c + 1].val, depth + 1)) return true;
      continue;
    }
    if (TEST_AT_START.test(toks.slice(i).map((x) => x.val).join(" "))) return true;
  }
  return false;
}

export const TEST_OUTPUT = [
  /#\s*pass\s+\d+/i,
  /\d+\s+passed/i,
  /pass\s+\d+[\s\S]{0,80}?fail\s+0/i,
  /check:\s*v poriadku/i,
  /tests?\s+\d+[\s\S]{0,80}?pass/i,
];

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

export const MESSAGE =
  "Sub-agent tieto testy spustil a vrátil ich výstup, hlavné vlákno ich neopakuje (global §6).";
export const POSTUP =
  "over správu sub-agenta proti plánu a diff (`git show --stat`); testy spusti znova, len keď si po sub-agentovi menil súbory " +
  "alebo správa výstup testov nemá; čo sub-agent overiť nemohol (živý systém), over ty.";

function textOf(c) {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.map((b) => (typeof b === "string" ? b : b?.type === "text" ? b.text : b?.type === "tool_result" ? textOf(b.content) : "")).join("\n");
}

// Text poslednej správy sub-agenta, za ktorou hlavné vlákno nič nezapísalo, inak "".
export function subagentReport(entries) {
  const main = entries.filter((e) => (e?.type === "user" || e?.type === "assistant") && !e.isSidechain);
  const agentIds = new Set();
  for (const e of main) for (const b of toolUses(e)) if (b.name === "Agent" || b.name === "Task") agentIds.add(b.id);
  for (let i = main.length - 1; i >= 0; i--) {
    const e = main[i];
    if (e.type === "assistant") {
      for (const b of toolUses(e)) {
        if (WRITE_TOOLS.has(b.name) || (b.name === "Bash" && bashWrites(b.input?.command))) return "";
      }
      continue;
    }
    const c = e.message?.content;
    if (typeof c === "string" || (Array.isArray(c) && c.some((b) => b?.type === "text"))) {
      const t = textOf(c);
      if (/<task-notification>/.test(t)) return t;
      return ""; // skutočný vstup používateľa
    }
    if (Array.isArray(c)) {
      for (const b of c) {
        if (b?.type === "tool_result" && agentIds.has(b.tool_use_id)) {
          const t = textOf(b.content);
          if (/^\s*Async agent launched/.test(t)) continue;
          return t;
        }
      }
    }
  }
  return "";
}

export function carriesTestOutput(t) {
  return TEST_OUTPUT.some((r) => r.test(t));
}

// true, keď treba zamietnuť.
export function shouldDeny(input, entries) {
  if (!input || input.agent_id) return false;
  if (input.tool_name !== "Bash" || !isTestCommand(input.tool_input?.command)) return false;
  return carriesTestOutput(subagentReport(entries));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let deny = false;
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    if (input?.transcript_path && !input.agent_id && isTestCommand(input.tool_input?.command)) {
      deny = shouldDeny(input, readEntries(input.transcript_path));
    }
  } catch {}
  if (deny) denyTool(MESSAGE, POSTUP);
}
