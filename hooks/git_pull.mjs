#!/usr/bin/env node
// git_pull.mjs — agent nespúšťa `git pull` (global §6, env/server/CLAUDE.md,
// "Git na serveri"). Súbežné fetche viacerých relácií v jednom klone zapíšu
// do `.git/FETCH_HEAD` dva riadky a pull padne; pull navyše podľa nastavenia
// zlúči alebo prepíše lokálne commity. 24. 10. 2026 agent v /root/teo spustil
// `git pull --rebase=false` a nič ho nezastavilo (foreign_git.mjs pozná pull
// len v cudzom klone). Úloha Taskera 487.
//
// PreToolUse pre Bash. Zamietne príkaz, v ktorom je `git` s podpríkazom
// `pull` (aj s voľbami pred ním, `-C <cesta>`, `-c k=v`, za `&&`, `;`, `|`,
// v podshelli, pod `sh -c`, `runuser`, `sudo`, `env`, `xargs`). Rozbor
// príkazu je ten z foreign_git.mjs: text v heredocu a v úvodzovkách
// (echo, grep, správa commitu, --body) a príkaz, ktorého hlavou nie je git,
// pustí.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripHeredocs } from "./no_model_wait.mjs";
import { stripData, cmdStart, gitTarget } from "./foreign_git.mjs";
import { denyTool } from "../lib/deny.mjs";

const IS_GIT = /^['"]?(?:\S*\/)?git['"]?$/;
const AS_USER = /^\s*(?:\w+=\S*\s+)*(?:runuser\s|sudo\s|su\s)/;

// Vráti true, keď príkaz spúšťa `git pull`.
export function gitPullIn(raw) {
  // `bash -lc` na začiatku príkazu sa zjednotí na `-c`, aby stripData nechal jeho reťazec.
  const norm = stripHeredocs(String(raw)).replace(/(^|[;&|(\n]\s*)((?:ba|da|z)?sh)\s+-[a-z]*c(?=\s)/g, "$1$2 -c");
  const flat = stripData(norm)
    .replace(/\b(?:ba|da|z)?sh\s+(?:-\S+\s+)*?-\w*c\s+['"]/g, "")
    .replace(/\b(?:su|runuser)\s+(?:-\S+\s+)*\S+\s+-c\s+['"]/g, "");
  for (const seg of flat.split(/[;&|\n`()]+/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    let s;
    if (AS_USER.test(seg)) s = tokens.findIndex((t) => IS_GIT.test(t));
    else {
      s = cmdStart(tokens);
      if (s >= 0 && tokens[s] === "xargs") {
        s++;
        while (s < tokens.length && tokens[s].startsWith("-")) s++;
      }
    }
    if (s < 0 || s >= tokens.length || !IS_GIT.test(tokens[s])) continue;
    if (gitTarget(tokens, s, null).sub === "pull") return true;
  }
  return false;
}

export const MESSAGE =
  "`git pull` nespúšťaj: súbežné fetche viacerých relácií v jednom klone zapíšu do `.git/FETCH_HEAD` dva riadky a pull padne, " +
  "podľa nastavenia navyše zlúči alebo prepíše lokálne commity (global §6, env/server/CLAUDE.md, Git na serveri).";

export const POSTUP =
  "`git fetch origin && git rebase origin/main` (v inej vetve `origin/<vetva>`), potom commit len so zoznamom súborov " +
  "`git commit -m \"<správa>\" -- <súbory>`.";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  if (input.tool_name !== "Bash") process.exit(0);
  if (gitPullIn(String((input.tool_input || {}).command || ""))) denyTool(MESSAGE, POSTUP);
}
