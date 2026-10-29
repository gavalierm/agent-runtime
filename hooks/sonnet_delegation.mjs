#!/usr/bin/env node
// sonnet_delegation.mjs — pripomienka global/CLAUDE.md §6: relácia na Opuse
// alebo Fable dáva implementáciu sub-agentovi implementator (Sonnet). Nikdy neblokuje.
// Úloha Taskera 501 (Ronova žiadosť, 24. 10. 2026).
//
// PreToolUse pre Bash, Edit, Write, MultiEdit, NotebookEdit. V aktuálnom ťahu
// (od posledného textu používateľa) spočíta zápisové kroky. Pri každom
// N-tom (N, 2N, ...) bez Agenta s model "sonnet" alebo s typom implementator pridá do kontextu pripomienku.
// Sub-agent (vstup s agent_id), chýbajúci transkript alebo iný model: nič.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const N = 6;

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const BASH_WRITE =
  /\bsed\s+(-\w*\s+)*-i|\btee\b|\bgit\s+commit\b|(^|[\s;&|])(mv|cp|rm)\s|install\.sh|<<-?\s*['"]?\w+['"]?[^\n]*>|(^|[^>&0-9-])>>?\s*(?!\/dev\/null|&)\S/;

export function bashWrites(command) {
  const c = String(command ?? "");
  // presmerovanie do /dev/null a do deskriptora (2>&1) nie je zápis
  const stripped = c.replace(/\d*>>?\s*\/dev\/null/g, "").replace(/\d*>&\d/g, "");
  return BASH_WRITE.test(stripped);
}

function isWrite(name, input) {
  if (WRITE_TOOLS.has(name)) return true;
  return name === "Bash" && bashWrites(input?.command);
}

export function toolUses(entry) {
  const c = entry?.message?.content;
  return Array.isArray(c) ? c.filter((b) => b?.type === "tool_use") : [];
}

function isUserText(entry) {
  if (entry?.type !== "user") return false;
  const c = entry.message?.content;
  if (typeof c === "string") return true;
  return Array.isArray(c) && c.some((b) => b?.type === "text");
}

// Záznamy aktuálneho ťahu: po poslednom texte používateľa, bez sidechainu.
export function currentTurn(entries) {
  const main = entries.filter((e) => (e?.type === "user" || e?.type === "assistant") && !e.isSidechain);
  let start = 0;
  for (let i = main.length - 1; i >= 0; i--) {
    if (isUserText(main[i])) { start = i + 1; break; }
  }
  return main.slice(start);
}

export function lastModel(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]?.type === "assistant" && entries[i].message?.model) return String(entries[i].message.model);
  }
  return "";
}

export function countWrites(entries, currentInput) {
  const turn = currentTurn(entries);
  let n = 0;
  let seen = false;
  for (const e of turn) {
    for (const b of toolUses(e)) {
      if (currentInput?.tool_use_id && b.id === currentInput.tool_use_id) seen = true;
      if (isWrite(b.name, b.input)) n++;
    }
  }
  if (currentInput && !seen && isWrite(currentInput.tool_name, currentInput.tool_input)) n++;
  return n;
}

export function usedSonnet(entries) {
  return currentTurn(entries).some((e) =>
    toolUses(e).some((b) => (b.name === "Agent" || b.name === "Task") &&
      (b.input?.model === "sonnet" || (b.input?.subagent_type === "implementator" && !b.input?.model))));
}

export function text(model, k) {
  return `Relácia na ${model} urobila v tomto ťahu ${k} zápisových krokov bez sub-agenta implementator. ` +
    `Global §6 chce implementáciu dať sub-agentovi implementator (nástroj Agent so subagent_type "implementator", beží na Sonnete) a nechať si návrh a overenie. ` +
    `Keď nejde o implementáciu (oprava jedného riadku, odpoveď na schránku, nasadenie), pokračuj.`;
}

// Vráti objekt pre stdout alebo null.
export function reminder(input, entries) {
  if (!input || input.agent_id) return null;
  const model = lastModel(entries);
  if (!/opus|fable/i.test(model)) return null;
  if (usedSonnet(entries)) return null;
  const k = countWrites(entries, input);
  if (k === 0 || k % N !== 0) return null;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text(model, k) } };
}

export function readEntries(path) {
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    if (input?.transcript_path && !input.agent_id) {
      const out = reminder(input, readEntries(input.transcript_path));
      if (out) process.stdout.write(JSON.stringify(out));
    }
  } catch {}
}
