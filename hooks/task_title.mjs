#!/usr/bin/env node
// task_title.mjs — názov úlohy pomenuje riešenie namiesto problému (env/server/CLAUDE.md,
// časť "Správca úloh", úloha 587). Operátor úlohu hľadá podľa toho, čo ho trápi:
// "/opt/tasker beží bez 276db3a", nie "Nasadiť Tasker 276db3a"; "Agenti v Taskeri dávajú
// úlohám názvy podľa riešenia", nie "Agenti budú dávať názvy správne".
//
// PreToolUse pre Bash. Posudzuje len --title v `tk`/`tasker` `task add` a `task edit <id>`
// (aj `--title=`, cez cestu, s premennými prostredia pred príkazom, pod `sh -c`,
// `$(cat <<'EOF' ...)` a `$(cat /súbor)`). Telo úlohy (--body) a komentáre neposudzuje,
// ostatné príkazy (echo, grep, task show, task list) pustí. Názov z neurčitej premennej
// `$VAR` pustí. Posudzuje sa prvé slovo názvu a prvé slovo za prefixom `Niečo:` na začiatku.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { denyTool } from "../lib/deny.mjs";
import { taskerCommands } from "./web_review.mjs";
import { inlineSubstitutions } from "./human_question.mjs";

// Zoznamy pravidiel, zoznam dopĺňaj tu a nikde inde. Hľadá sa bez ohľadu na veľkosť písmen.
export const LISTS = {
  // pravidlo 2: rozkazovací spôsob na začiatku
  imperative: ["oprav", "pridaj", "nasaď", "zlúč", "zmaž", "doplň", "over", "sprav", "urob", "zaveď", "zriaď", "zmeň", "presuň", "vytvor"],
  // pravidlo 3: podstatné meno úkonu na začiatku (1. pád)
  actionNouns: ["nasadenie", "zlúčenie", "zverejnenie", "zavedenie", "pridanie", "doplnenie", "oprava", "úprava", "zriadenie", "zmazanie", "prepnutie", "vyčistenie", "push", "merge", "deploy", "implementácia", "replay"],
  // pravidlo 4: prefix pred dvojbodkou na začiatku
  prefixes: ["hook", "kontrola", "pravidlo"],
  // pravidlo 5: anglické prvé slovo
  english: ["add", "fix", "implement", "deploy", "merge", "create", "remove", "update", "make", "use", "support"],
  // pravidlo 6: budúci čas slovesa byť kdekoľvek v názve
  future: ["budem", "budeš", "bude", "budeme", "budete", "budú"],
};

const L = String.raw`[\p{L}\p{N}_]`;
const FIRST_WORD = new RegExp(String.raw`^[^\p{L}\p{N}_]*(${L}+)`, "u");
// Pravidlo 1: slovenský neurčitok končí na samohlásku + "ť" (nasadiť, zlúčiť, označiť), "ôcť" (pomôcť) a "iecť" (piecť); "sť", "ť" po
// spoluhláske (podstatné mená ako zvedavosť, smrť) a "äť" (pamäť, päť) nie.
const INFINITIVE = /^\p{L}{2,}(?:[aáeéiíoóôuúyý]ť|ôcť|iecť)$/u;
const FUTURE = new RegExp(String.raw`(?<!${L})(?:${LISTS.future.join("|")})(?!${L})`, "iu");

export const MESSAGE = (why) =>
  `Názov úlohy pomenúva riešenie namiesto problému: ${why}. Pravidlo: env/server/CLAUDE.md, časť "Správca úloh", úloha 587 ` +
  `(operátor úlohu hľadá podľa problému, nie podľa riešenia).`;

export const POSTUP =
  "preformuluj názov ako stav, ktorý vidí operátor (čo nefunguje, chýba alebo zlyháva), napr. " +
  "\"Nasadiť Tasker 276db3a\" -> \"/opt/tasker beží bez 276db3a (časy v UTC)\", " +
  "\"Agenti budú dávať názvy správne\" -> \"Agenti v Taskeri dávajú úlohám názvy podľa riešenia\".";

// Dôvod, prečo názov nie je pomenovanie problému, alebo null.
export function titleReason(title) {
  const t = String(title).trim();
  if (!t) return null;
  const m = FUTURE.exec(t);
  if (m) return `pravidlo 6, budúci čas slovesa byť ("${m[0]}")`;
  const heads = [];
  const pre = /^([^:\n]{1,60}):\s+(.*)$/su.exec(t);
  if (pre) {
    const p = pre[1].trim().toLowerCase();
    if (LISTS.prefixes.includes(p)) return `pravidlo 4, prefix "${pre[1].trim()}:" na začiatku`;
    heads.push(pre[2]);
  }
  heads.unshift(t);
  for (const h of heads) {
    const w = (FIRST_WORD.exec(h) || [])[1];
    if (!w) continue;
    const lw = w.toLowerCase();
    if (INFINITIVE.test(lw)) return `pravidlo 1, začína neurčitkom ("${w}")`;
    if (LISTS.imperative.includes(lw)) return `pravidlo 2, začína rozkazovacím spôsobom ("${w}")`;
    if (LISTS.actionNouns.includes(lw)) return `pravidlo 3, začína podstatným menom úkonu ("${w}")`;
    if (LISTS.english.includes(lw)) return `pravidlo 5, začína anglickým slovesom ("${w}")`;
  }
  return null;
}

function flagValue(args, name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) return args[i + 1];
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
  }
  return undefined;
}

// Názvy v príkaze: [{ what, title }] z `task add` a `task edit <id>`.
export function titles(raw, read) {
  const src = read ? inlineSubstitutions(raw, read) : inlineSubstitutions(raw);
  const out = [];
  for (const { rest } of taskerCommands(src)) {
    let what;
    if (rest[0] === "task" && rest[1] === "add") what = "task add";
    else if ((rest[0] === "task" && rest[1] === "edit") || rest[0] === "edit") what = "task edit";
    else continue;
    const v = flagValue(rest.slice(1), "title");
    if (v !== undefined) out.push({ what, title: v });
  }
  return out;
}

// Vráti dôvod zamietnutia alebo null.
export function taskTitleReason(raw, read) {
  for (const { what, title } of titles(raw, read)) {
    const why = titleReason(title);
    if (why) return `${what} --title "${title}": ${why}`;
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  if (input.tool_name !== "Bash") process.exit(0);
  const why = taskTitleReason(String((input.tool_input || {}).command || ""));
  if (!why) process.exit(0);
  denyTool(MESSAGE(why), POSTUP);
}
