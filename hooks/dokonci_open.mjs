#!/usr/bin/env node
// requires: tasker
// dokonci_open.mjs — koniec ťahu s otvoreným ledgerom skillu dokonci sa zastaví.
// Chyba 27. 10. 2026 (úloha 623, behy Taskera 126 a 127): agent spustil posudok
// nástrojom Agent na pozadí a ťah ukončil vetou "Čakám na posudok". Beh Taskera
// je zviazaný s ťahom, koniec ťahu zavrel beh bez výsledku, `dokonci.sh koniec`
// potom hlásil pri `tasker comment` "invalid run identity" a Tasker po treťom
// takom behu úlohu označil failed.
//
// Len Stop, nie SubagentStop: sub-agent posudku končí pri otvorenom ledgeri
// a nesmie byť blokovaný. Hook sa pustí len v behu Taskera (TASKER_TASK_ID),
// hlavné vlákna bez behu nerieši. Ledger `dokonci-<úloha>.md` hľadá v poradí
// $DOKONCI_LEDGER_DIR, `.scratch` koreňa repa z `cwd` hooku, `/tmp/dokonci`
// (rovnako ako dokonci.sh). Relácia je od posledného `@start`. Ak obsahuje
// `@koniec` alebo `@otazka`, beh je uzavretý a hook mlčí, inak zastaví
// ukončenie (decision block). Pri `stop_hook_active` mlčí, aby nezacyklil.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { blockStop } from "../lib/deny.mjs";

// Cesty, kde môže ledger úlohy ležať, v poradí hľadania.
export function ledgerCandidates(task, cwd, env = process.env) {
  const name = `dokonci-${task}.md`;
  const out = [];
  if (env.DOKONCI_LEDGER_DIR) out.push(join(env.DOKONCI_LEDGER_DIR, name));
  if (cwd && cwd.startsWith("/")) {
    try {
      const top = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (top) out.push(join(top, ".scratch", name));
    } catch {}
  }
  out.push(join("/tmp/dokonci", name));
  return out;
}

// Ledger je otvorený, keď jeho posledná relácia nemá @koniec ani @otazka.
export function isOpen(text) {
  const lines = text.split("\n");
  let start = -1;
  lines.forEach((l, i) => { if (l.startsWith("@start\t")) start = i; });
  if (start < 0) return false;
  return !lines.slice(start).some((l) => l.startsWith("@koniec\t") || l.startsWith("@otazka\t"));
}

export function message(task, ledger) {
  return `Beh dokonci na úlohe ${task} má otvorený ledger ${ledger} (start bez koniec). `
    + "Koniec ťahu zavrie beh Taskera a tasker comment aj result potom zlyhajú na run identity (úloha 623, behy 126 a 127).";
}

export function postup(task) {
  return `posudok cez Agent s run_in_background false v tomto ťahu, potom dokonci.sh koniec ${task} --vysledok "..."; `
    + `otázka na človeka ide cez dokonci.sh otazka ${task} --summary "...".`;
}

// Vráti { task, ledger } pre otvorený ledger, inak null.
export function openLedger(input, env = process.env) {
  const task = env.TASKER_TASK_ID;
  if (!task || !/^\d+$/.test(task)) return null;
  const ledger = ledgerCandidates(task, typeof input.cwd === "string" ? input.cwd : null, env).find((p) => existsSync(p));
  if (!ledger) return null;
  let text;
  try { text = readFileSync(ledger, "utf8"); } catch { return null; }
  return isOpen(text) ? { task, ledger } : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  if (input.stop_hook_active) process.exit(0);
  const o = openLedger(input);
  if (o) blockStop(message(o.task, o.ledger), postup(o.task));
}
