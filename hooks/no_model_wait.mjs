#!/usr/bin/env node
// no_model_wait.mjs — agent nečaká na udalosť príkazom v popredí.
// Čakanie cez `sleep` alebo slučku `until`/`while` drží ťah otvorený
// a po ňom model znova prečíta celý kontext, často opakovane. Dňa
// 19. 10. 2026 to bolo 4 % spotreby servera (DECISIONS.md 2026-10-19,
// "spotreba predplatného"). Odpoveď agenta prinesie budič, keď ťah
// skončí, vonkajšiu udalosť sleduje skript na pozadí alebo `tasker wait`.
//
// PreToolUse pre Bash. Zamietne príkaz v popredí so `sleep` nad 10 s
// alebo so slučkou, ktorá spí. Príkaz s run_in_background pustí, ten
// model nečaká a zobudí ho až koniec skriptu.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { denyTool } from "../lib/deny.mjs";

const MAX_SLEEP = 10;
const UNIT = { "": 1, s: 1, m: 60, h: 3600, d: 86400 };

// Telo heredocu sú dáta príkazu (text správy, skript pre python), nie
// čakanie shellu. Chyba 19. 10. 2026: správa s ukážkou príkazu `sleep`
// bola zamietnutá.
export function stripHeredocs(command) {
  return command.replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "<<heredoc");
}

// Reťazec v úvodzovkách je dáta (argument echo, --body), nie čakanie
// shellu. Ostane reťazec, ktorý shell spustí: za `-c`, `eval`, `ssh
// <stroj>`, `watch`, a reťazec v "..." s `$(` alebo spätným apostrofom.
// Chyba 19. 10. 2026: `tasker comment --body '... sleep 11 ...'` bol
// zamietnutý.
export function stripQuoted(command) {
  return command.replace(/(-c|\beval|\bssh\s+(?:-\S+\s+)*\S+|\bwatch(?:\s+-\S+)*)?(\s*)('[^']*'|"(?:[^"\\]|\\.)*")/g, (all, run, sp, str) => {
    if (run) return all;
    if (str[0] === '"' && /\$\(|`/.test(str)) return all;
    return `${sp}''`;
  });
}

// Vráti dôvod zamietnutia alebo null.
export function waitReason(raw) {
  const command = stripQuoted(stripHeredocs(raw));
  if (/\b(until|while)\b[\s\S]*\bsleep\b/.test(command)) return "slučka so sleep";
  if (/\bwatch\s+(-\S+\s+)*\S/.test(command)) return "watch";
  for (const m of command.matchAll(/\bsleep\s+(\d+(?:\.\d+)?)([smhd]?)\b/g)) {
    const s = Number(m[1]) * UNIT[m[2]];
    if (s > MAX_SLEEP) return `sleep ${m[1]}${m[2]}`;
  }
  return null;
}

export const POSTUP =
  "pauzu do 10 s nechaj; na inú úlohu zapíš `tasker block <id> --by <úloha> --reason \"...\"` (blokér čaká na done tej úlohy, nie na koniec jej behu), " +
  "na čas a na koniec behu `tasker wait <id> --reason \"beh N\" --until <čas o 10 až 15 min>`, po zobudení `tk run list --json` a ak beh beží, znova wait; " +
  "Tasker ťa zobudí sám; skript s run_in_background len na udalosť, ktorú Tasker nevidí (env/server/CLAUDE.md, Správca úloh); " +
  "na odpoveď agenta ukonči ťah.";

export const MESSAGE =
  "Čakanie v popredí páli predplatné: ťah stojí a po ňom model znova číta celý kontext. " +
  "Na odpoveď agenta nečakaj, ukonči ťah, budič ju doručí do vlákna. " +
  "Na done inej úlohy čakaj blokérom `tasker block --by`, na čas a na koniec behu `tasker wait --until` a po zobudení `tk run list`, slučka ani timer na to netreba. " +
  "Blokér na úlohu behu je kruh: pri pozastavenom dispečeri sa úloha behu nespustí a nedostane done " +
  "(chyba 25. 10. 2026, úloha 596; rada blokéra na beh bola z úlohy 582). Skript na pozadí len na udalosť mimo Taskera. Pauza do 10 s je povolená.";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  const ti = input.tool_input || {};
  if (input.tool_name !== "Bash" || ti.run_in_background) process.exit(0);
  const why = waitReason(String(ti.command || ""));
  if (!why) process.exit(0);
  denyTool(`${MESSAGE} (${why})`, POSTUP);
}
