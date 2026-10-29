#!/usr/bin/env node
// web_review.mjs — brána mockupu webu (D0041, od úlohy 645). Zmena vzhľadu
// webu sa implementuje podľa schváleného mockupu dizajnérky Niny, nie po
// jej posudku hotového webu.
//
// PreToolUse pre Bash zamietne priamo spustené `tasker` (aj obal `bin/tk`)
// `task add ... --assign <agent webu>` a `tasker assign <id> <agent webu>`.
// Úlohu webu zakladá bin/uloha-webu.sh, ktorá vyžaduje
// `--mockup <id>` (hotová úloha Niny so schváleným mockupom) alebo
// `--bez-mockupu "<dôvod>"`.
// Agent webu: meno alebo basename workdiru končí na `-web`. Zoznam agentov
// je z `tasker agent list` (pod rootom cez bin/tk), pri chybe platí len
// pravidlo mena. Premennú v hodnote (`--assign "$A"`) hook nevyhodnotí.

import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripHeredocs } from "./no_model_wait.mjs";
import { denyTool } from "../lib/deny.mjs";
import { isWebAgent, loadAgents } from "../lib/web_gate.mjs";
import { workflowDir } from "../lib/paths.mjs";
import { hookEnv } from "../lib/agent_env.mjs";

const ULOHA_WEBU = join(workflowDir(), "bin", "uloha-webu.sh");
export const ASSIGN_POSTUP =
  "`" + ULOHA_WEBU + " --project P --assign <agent webu> --title T --body B --mockup <id úlohy dizajnéra>` " +
  "(alebo `--bez-mockupu \"<dôvod>\"` pri zmene bez nového vzhľadu) založí úlohu webu s bránou mockupu.";
export const ASSIGN_MESSAGE = `Úlohu webu zakladaj cez ${ULOHA_WEBU}, overí schválený mockup alebo dôvod bez mockupu.`;

const WRAPPERS = new Set(["runuser", "sudo", "su", "env", "time", "nohup", "exec", "command", "nice", "!", "{", "if", "then", "elif", "else", "do", "while", "until", hookEnv().AGENT_TASKER_USER || "tasker", "root"]);

// Rozdelí príkaz na príkazy (oddeľovače `; & | newline ( ) `` ` ``
// mimo úvodzoviek) a tie na slová s odstránenými úvodzovkami.
export function commands(raw) {
  const out = [];
  let words = [];
  let cur = "";
  let has = false;
  let q = null;
  const pushWord = () => { if (has) words.push(cur); cur = ""; has = false; };
  const pushCmd = () => { pushWord(); if (words.length) out.push(words); words = []; };
  const s = stripHeredocs(raw);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === "\\" && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === "'" || c === '"') { q = c; has = true; }
    else if (c === "\\" && i + 1 < s.length) { cur += s[++i]; has = true; }
    else if (/\s/.test(c) && c !== "\n") pushWord();
    else if (/[;&|\n()`]/.test(c)) pushCmd();
    else { cur += c; has = true; }
  }
  pushCmd();
  return out;
}

// Volania `tasker` (aj obal `tk`): [{ rest: [slová za príkazom] }]. Vnorené
// `sh -c '...'` sa rozloží. Zdieľa ho hooks/human_question.mjs.
export function taskerCommands(raw, depth = 0) {
  const calls = [];
  for (const words of commands(raw)) {
    // `sh -c '...'`, `su - <používateľ> -c '...'`: vnorený príkaz.
    const c = words.indexOf("-c");
    if (c >= 0 && words[c + 1] !== undefined && depth < 3) calls.push(...taskerCommands(words[c + 1], depth + 1));
    const i = words.findIndex((w) => basename(w) === "tasker" || basename(w) === "tk");
    if (i < 0) continue;
    const before = words.slice(0, i);
    if (!before.every((w) => WRAPPERS.has(w) || /^[A-Za-z_]\w*=/.test(w) || w.startsWith("-"))) continue;
    calls.push({ rest: words.slice(i + 1) });
  }
  return calls;
}

// Podpríkazy `tasker`: [{ sub: "task add"|"assign", args: [...] }].
export function taskerCalls(raw) {
  const calls = [];
  for (const { rest } of taskerCommands(raw)) {
    if (rest[0] === "task" && rest[1] === "add") calls.push({ sub: "task add", args: rest.slice(2) });
    else if (rest[0] === "assign") calls.push({ sub: rest[0], args: rest.slice(1) });
  }
  return calls;
}

function flagValue(args, name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) return args[i + 1];
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
  }
  return undefined;
}

function positionals(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) { if (!args[i].includes("=")) i++; } else out.push(args[i]);
  }
  return out;
}

// Vráti dôvod zamietnutia alebo null. `agents` je funkcia, ktorá vráti
// Map meno -> workdir alebo null.
export function webReviewReason(raw, { agents = loadAgents } = {}) {
  let list;
  const isWeb = (name) => {
    if (/-web$/.test(name)) return true;
    if (list === undefined) list = agents();
    return isWebAgent(name, list);
  };
  for (const { sub, args } of taskerCalls(raw)) {
    if (sub === "task add") {
      const a = flagValue(args, "assign");
      if (a && isWeb(a)) return ASSIGN_MESSAGE;
    } else if (sub === "assign") {
      const a = positionals(args)[1];
      if (a && isWeb(a)) return ASSIGN_MESSAGE;
    }
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  if (input.tool_name !== "Bash") process.exit(0);
  const why = webReviewReason(String((input.tool_input || {}).command || ""));
  if (!why) process.exit(0);
  denyTool(why, ASSIGN_POSTUP);
}
