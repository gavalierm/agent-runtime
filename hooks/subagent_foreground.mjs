#!/usr/bin/env node
// subagent_foreground.mjs — sub-agent nespúšťa príkaz na pozadí.
// Sub-agent, ktorý spustí príkaz s run_in_background a ukončí ťah, sa
// vráti hlavnému vláknu ako hotový s výsledkom "čakám na ...". Koniec
// príkazu ho už nezobudí a práca stojí. Chyba 24. 10. 2026: sub-agent
// úlohy 497 skončil vetou "Čakám na dokončenie npm test", kód ostal
// necommitnutý a operátor musel zasiahnuť.
//
// PreToolUse pre Bash a Monitor. Vstup nesie agent_id, len keď nástroj
// volá sub-agent (code.claude.com/docs/en/hooks, common input fields).
// Hlavné vlákno hook pustí.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { denyTool } from "../lib/deny.mjs";

export function backgroundBySubagent(input) {
  if (!input?.agent_id) return false;
  if (input.tool_name === "Monitor") return true;
  return input.tool_name === "Bash" && Boolean(input.tool_input?.run_in_background);
}

export const MESSAGE =
  "Sub-agent nespúšťa príkaz na pozadí: po konci ťahu ho jeho koniec nezobudí a práca ostane stáť.";
export const POSTUP =
  "spusti príkaz v popredí s timeoutom, napríklad `timeout 300 npm test 2>&1 | tail -20` a nástroj Bash s timeout 320000; " +
  "na vonkajšiu udalosť nečakaj, vráť výsledok a čo ostáva otvorené.";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  if (backgroundBySubagent(input)) denyTool(MESSAGE, POSTUP);
}
