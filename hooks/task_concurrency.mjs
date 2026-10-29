#!/usr/bin/env node
// requires: tasker
// task_concurrency.mjs — úloha pre agenta, ktorý má v tom istom projekte bežiaci beh, sa
// spustí súbežne bez blokéra (úloha 594). Chyba 25. 10. 2026: úloha 590 pre Lea vznikla
// bez --blocked-by, hoci projekt tasker mal behy 113 a 114 v tom istom klone, dispečer ju
// hneď spustil a dodatočný `tasker block` ju nezastavil. Tasker kontrolu pri založení nemá
// (`task add --help` ponúka len --blocked-by, `max_parallel_runs` je globálny strop).
//
// PreToolUse pre Bash. Zamietne `tk`/`tasker` `task add --project P --assign X` bez
// --blocked-by, keď `tasker run list --agent X --project P --json` ukáže beh v stave
// 'running'. Hlásenie povie, ktoré úlohy bežia, a dá hotový príkaz s --blocked-by.
// Výnimka pre vedomé súbežné zadanie: `TK_PARALLEL=1` pred príkazom. Príkaz bez --project
// alebo --assign, a zlyhanie `run list`, hook pustí.
// Test podstrčí výpis behov premennou TASK_CONCURRENCY_RUN_LIST (cesta k príkazu, ktorý
// vypíše JSON), živý Tasker sa nevolá.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { denyTool } from "../lib/deny.mjs";
import { taskerCommands } from "./web_review.mjs";
import { inlineSubstitutions } from "./human_question.mjs";

const TK = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "tk");

export const MESSAGE = (why) =>
  `Úloha pre agenta, ktorý v tom istom projekte už beží, by sa spustila súbežne: ${why}. ` +
  `Pravidlo: env/server/CLAUDE.md, časť "Správca úloh", úloha 594 (dodatočný tasker block spustenú úlohu nezastaví).`;

export const POSTUP = (blocker) =>
  `pridaj blokér na bežiacu úlohu: task add ... --blocked-by ${blocker} --reason "<na čom stojí a čo ju pohne>". ` +
  `Súbežné zadanie vedome povolíš až premennou TK_PARALLEL=1 pred príkazom.`;

function flagValue(args, name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) return args[i + 1];
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
  }
  return undefined;
}

// Bežiace behy agenta v projekte: [{ id, task_id }]. Zlyhanie vráti [].
export function runningRuns(agent, project, env = process.env) {
  try {
    const cmd = env.TASK_CONCURRENCY_RUN_LIST || TK;
    const out = execFileSync(cmd, ["run", "list", "--agent", agent, "--project", project, "--json"], {
      env: { ...env },
      encoding: "utf8",
      timeout: 8000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return JSON.parse(out).filter((r) => r.status === "running" && r.agent === agent && r.project === project);
  } catch {
    return [];
  }
}

// Vráti { why, blocker } alebo null.
export function concurrencyReason(raw, read, env = process.env, runs = runningRuns) {
  if (env.TK_PARALLEL === "1" || /(^|[\s;&|(])TK_PARALLEL=1(?=\s)/.test(raw)) return null;
  const src = read ? inlineSubstitutions(raw, read) : inlineSubstitutions(raw);
  for (const { rest } of taskerCommands(src)) {
    if (!(rest[0] === "task" && rest[1] === "add")) continue;
    const args = rest.slice(2);
    const agent = flagValue(args, "assign");
    const project = flagValue(args, "project");
    if (!agent || !project || /[$`]/.test(agent + project)) continue;
    if (flagValue(args, "blocked-by") !== undefined) continue;
    const running = runs(agent, project, env);
    if (!running.length) continue;
    const list = running.map((r) => `úloha ${r.task_id} (beh ${r.id})`).join(", ");
    return { why: `task add --project ${project} --assign ${agent} bez --blocked-by, ale ${agent} v projekte ${project} už beží ${list}`, blocker: running[0].task_id };
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  if (input.tool_name !== "Bash") process.exit(0);
  const r = concurrencyReason(String((input.tool_input || {}).command || ""));
  if (!r) process.exit(0);
  denyTool(MESSAGE(r.why), POSTUP(r.blocker));
}
