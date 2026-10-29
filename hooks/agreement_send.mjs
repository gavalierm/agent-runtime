#!/usr/bin/env node
// requires: inbox
// agreement_send.mjs — správa inému agentovi so značkou "[<meno> za <operátor>]",
// keď operátor súhlasil len s jedným menovaným úkonom (stav zapisuje
// agreement_scope.mjs), sa zamietne na prvý pokus: správa smie niesť len ten úkon.
// Keď ho nesie len, príkaz sa zopakuje s `AGREEMENT_SCOPE_CHECKED=1` pred ním, prejde
// a stav sa zmaže. PreToolUse pre Bash. Úloha Taskera 610 (zástupca: "Ano, zaloz issue"
// na otázku s dvoma úkonmi, správa niesla oba).
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { denyTool } from "../lib/deny.mjs";
import { commands } from "./web_review.mjs";
import { readState, clearState } from "./agreement_scope.mjs";

const MARK = /\[[^\]\n]+ za [^\]\n]+\]/u;
const SENDERS = new Set(["ask_agent.sh", "reply.sh"]);

// Volanie ask_agent.sh alebo reply.sh (aj s premennými a `sh` pred ním): { checked } alebo null.
export function sendCall(raw) {
  for (const words of commands(raw)) {
    const i = words.findIndex((w) => SENDERS.has(basename(w)));
    if (i < 0) continue;
    const pre = words.slice(0, i);
    if (!pre.every((w) => /^[A-Za-z_]\w*=/.test(w) || /^(?:ba)?sh$/.test(basename(w)))) continue;
    return { checked: pre.includes("AGREEMENT_SCOPE_CHECKED=1") };
  }
  return null;
}

// Vráti { deny: dôvod } alebo { clear: true } alebo null.
export function verdict(command, state) {
  if (!state) return null;
  const call = sendCall(command);
  if (!call || !MARK.test(command)) return null;
  if (call.checked) return { clear: true };
  return {
    deny:
      `Operátor súhlasil len s úkonom "${state.cite}". Správa so značkou "za <operátor>" smie niesť len ten úkon, ` +
      "ostatné úkony návrhu v nej nie sú schválené.",
  };
}

export const POSTUP =
  "vyhoď z textu správy každý úkon okrem schváleného, a keď ho nesie len, zopakuj príkaz s `AGREEMENT_SCOPE_CHECKED=1` pred ním (napr. `AGREEMENT_SCOPE_CHECKED=1 ask_agent.sh ...`)";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  if (input.tool_name !== "Bash" || !input.session_id) process.exit(0);
  const v = verdict(String((input.tool_input || {}).command || ""), readState(input.session_id));
  if (!v) process.exit(0);
  if (v.clear) {
    clearState(input.session_id);
    process.exit(0);
  }
  denyTool(v.deny, POSTUP);
}
