#!/usr/bin/env node
// tasker_root.mjs — agent pod rootom spúšťa `tasker` priamo.
// Tasker beží pod používateľom správcu úloh (AGENT_TASKER_USER, predvolene
// `tasker`), databáza je v jeho domovskom priečinku. Dňa 23. 10. 2026 vlákno
// témy webového projektu spustilo ako root `tasker task show 354 --json`, Tasker vrátil "no
// database at <cwd>/tasker.db, run: tasker init" a agent spálil päť
// príkazov, kým našiel správne volanie. Rada "tasker init" by založila
// cudziu databázu.
//
// PreToolUse pre Bash. Ak proces hooku beží ako uid 0, zamietne priamo
// spustený `tasker` (na začiatku, za `&&`, `||`, `;`, `|`, `$(`, aj
// s premennými prostredia pred ním), ktorý nie je pod `runuser -u
// <používateľ>`, `sudo -u <používateľ>` ani `su <používateľ>`. Text
// v úvodzovkách a v heredocu, `grep tasker`, `which tasker` a cesty ako
// /root/tasker pustí. Premennú typu `T=tasker; $T` nechytá.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { denyTool } from "../lib/deny.mjs";
import { hookEnv } from "../lib/agent_env.mjs";
import { workflowDir } from "../lib/paths.mjs";
import { stripHeredocs, stripQuoted } from "./no_model_wait.mjs";

// Predpony, za ktorými príkaz beží ďalej.
const PREFIX = new Set(["env", "time", "nohup", "exec", "command", "nice", "!", "{", "if", "then", "elif", "else", "do", "while", "until"]);
const asTasker = (user) => new RegExp(`^\\s*(?:\\w+=\\S*\\s+)*(?:runuser\\s|sudo\\s+(?:-\\S+\\s+)*-\\w*u\\b|su\\s)[^\\n]*\\b${user.replace(/[^\w-]/g, "")}\\b`);

const TK = join(workflowDir(), "bin", "tk");

export const message = (user) =>
  `Tasker beží pod používateľom ${user}, root ho nenájde databázu a \`tasker init\` by založil cudziu. ` +
  `Spusti: \`${TK} ...\` (obal, meno agenta berie z AGENT_NAME alebo PERSONA.md).`;

export const POSTUP =
  `\`${TK} ...\` (pravidlá servera, časť Schránky a budič).`;

// Vráti dôvod zamietnutia alebo null. `uid` je uid procesu hooku.
export function taskerRootReason(raw, { uid = process.getuid(), user = hookEnv().AGENT_TASKER_USER || "tasker" } = {}) {
  if (uid !== 0) return null;
  const AS_TASKER = asTasker(user);
  // `sh -c '...'` sa rozbalí, jeho príkazy sa posúdia ako ostatné.
  const flat = stripQuoted(stripHeredocs(raw)).replace(/\b(?:ba|da|z)?sh\s+(?:-\S+\s+)*?-\w*c\s+['"]/g, "");
  for (const seg of flat.split(/[;&|\n`()]+/)) {
    if (AS_TASKER.test(seg)) continue;
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < tokens.length && (/^[A-Za-z_]\w*=/.test(tokens[i]) || PREFIX.has(tokens[i]))) i++;
    const head = (tokens[i] || "").replace(/^['"]+|['"]+$/g, "");
    if (/^(?:\S*\/)?tasker$/.test(head)) return `tasker spustený priamo ako root: ${seg.trim()}`;
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  if (input.tool_name !== "Bash") process.exit(0);
  const why = taskerRootReason(String((input.tool_input || {}).command || ""));
  if (!why) process.exit(0);
  denyTool(`${message(hookEnv(input).AGENT_TASKER_USER || "tasker")} (${why})`, POSTUP);
}
