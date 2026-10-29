#!/usr/bin/env node
// requires: none
// tool_failure_log.mjs — zlyhaný príkaz Bash zapíše do registra nástrojov
// (úloha 615). Agenti opakovali nástroje, ktoré v prostredí nefungujú: `gh`,
// `sudo` pod rootom, prepínač `curl`, ktorý verzia nepozná. Každý pokus stál
// volanie s celým kontextom. Hook tool_failure_block.mjs podľa registra
// zamietne druhý pokus o ten istý tvar.
//
// PostToolUseFailure pre Bash. Claude Code doručí vstup
// {tool_name, tool_input: {command}, error: "Exit code 127\n<text chyby>", ...}
// (overené živo 26. 10. 2026, claude 2.1.310). Riadok "Exit code N" sa preskočí,
// prvý ďalší neprázdny riadok je chyba. Zapíše riadok TSV (oddeľovač tabulátor):
//   dátum ISO, prostredie (používateľ@hostname), program, podpríkaz, prepínače
//   (medzera), prvý riadok chyby, príkaz skrátený na 200 znakov
// do `$AR_STATE_TOOLS`, inak `~/.local/state/agentic-workflow/nastroje.tsv`
// (priečinok 700, súbor 600). Nikdy nezamieta, vždy kód 0, chyby potichu.
import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { envKey, failedShape, firstErrorLine } from "../lib/tool_shape.mjs";

export function registerPath(env = process.env) {
  return env.AR_STATE_TOOLS || join(env.HOME || homedir(), ".local/state/agentic-workflow/nastroje.tsv");
}

const clean = (s) => String(s ?? "").replace(/[\t\r\n]+/g, " ");

// Riadok registra pre zlyhaný príkaz alebo null, keď nie je čo zapísať.
export function registerLine(input, { env = process.env, now = new Date() } = {}) {
  if (input.tool_name !== "Bash" || input.is_interrupt) return null;
  const command = String((input.tool_input || {}).command || "");
  const error = typeof input.error === "string" ? input.error : String((input.tool_response || {}).stderr || "");
  const line = firstErrorLine(error);
  const sh = failedShape(command, line);
  if (!sh.program) return null;
  return [
    now.toISOString(),
    env.AR_ENV_KEY || envKey(),
    sh.program,
    sh.sub,
    sh.flags.join(" "),
    clean(line),
    clean(command).slice(0, 200),
  ].join("\t");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    const row = registerLine(input);
    if (row) {
      const file = registerPath();
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      appendFileSync(file, row + "\n", { mode: 0o600 });
      chmodSync(file, 0o600);
    }
  } catch {}
  process.exit(0);
}
