#!/usr/bin/env node
// requires: none
// shared_git.mjs — git príkazy, ktoré v zdieľanom klone zahodia alebo
// schovajú rozpracované súbory inej relácie. Jedno miesto pre topic.mjs
// (Mac) a foreign_git.mjs (server). Audit 16. 10. 2026, nález 10.
// Druhý výskyt 22. 10. 2026: sub-agent spustil `git rebase --autostash`
// v klone agenta a schoval súbory inej relácie (prvý 20. 10. 2026).
//
// Od úlohy 621 aj príkazy, ktoré vypnú hooky repa: `git -c core.hooksPath=...`
// a `--no-verify` (na `git commit` aj `-n`). Pozri `hooksBypass` nižšie.
// Od úlohy 694 aj plošné `git add -A`, `--all` a `.` (global §6). Pozri `addAll`.
import { stripHeredocs } from "./no_model_wait.mjs";
import { cmdStart, stripProse } from "./foreign_git.mjs";

export const SHARED_GIT = /\bgit\b[^;&|]*\s(?:stash(?!\s+(?:list|show)\b)|reset\s+--hard|checkout\s+(?:-f\b|--\s|\.)|restore\b|clean\b|pull\b[^;&|]*--autostash|rebase\b[^;&|]*--autostash)/;

export const SHARED_GIT_MESSAGE =
  "Klon zdieľajú relácie viacerých agentov. git stash, reset --hard, checkout --, restore, clean a --autostash by zahodili alebo schovali prácu inej relácie. Commitni zoznam vlastných súborov, zlyhaný commit na index.lock zopakuj.";

export const SHARED_GIT_POSTUP =
  "`git commit -m \"<správa>\" -- <zoznam vlastných súborov>` (env/server/CLAUDE.md, Git na serveri); " +
  "commit zlyhaný na index.lock zopakuj, stash, reset --hard a restore nepoužívaj.";

// --- obchádzanie hookov repa (úloha 621) ------------------------------------
// `git -c core.hooksPath=...` a `git commit --no-verify` (aj `-n`) vypnú hooky repa
// (pre-commit s `node check.mjs`, commit-msg s kontrolou autora). Chyba 23. 10. 2026:
// repo pravidiel commitnutý s `-c core.hooksPath=.git/hooks`. deny v settings.json
// chytí len `--no-verify` a `commit -n`, `core.hooksPath` nie a dôvod nedá.
// Rozbor príkazu je ten z git_pull.mjs: text v heredoci a v úvodzovkách (správa
// commitu, echo, grep) hook pustí, `git config core.hooksPath` (zapnutie .githooks
// v klone) tiež. Importy z foreign_git.mjs sa používajú až pri volaní, kruhový
// import foreign_git <-> shared_git preto nevadí.

const IS_GIT = /^['"]?(?:\S*\/)?git['"]?$/;
const AS_USER = /^\s*(?:\w+=\S*\s+)*(?:runuser\s|sudo\s|su\s)/;
const GIT_OPT_VAL = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
const HOOKS_KEY = /^core\.hookspath(?:=|$)/i;
// Voľby `git commit`, ktoré berú hodnotu v ďalšom argumente (alebo v zvyšku zhluku).
const COMMIT_VAL_SHORT = "mFCcSut";
const COMMIT_VAL_LONG = new Set(["--message", "--file", "--author", "--date", "--reuse-message", "--reedit-message", "--template", "--cleanup", "--fixup", "--squash"]);
const unq = (t) => String(t ?? "").replace(/^['"]+|['"]+$/g, "");

// Zhluk krátkych volieb `git commit` (`-anm`) nesie `n` skôr, než voľba s hodnotou.
function commitShortHasN(t) {
  if (!/^-[A-Za-z]+$/.test(t)) return false;
  for (const c of t.slice(1)) {
    if (c === "n") return true;
    if (COMMIT_VAL_SHORT.includes(c)) return false;
  }
  return false;
}

// Úseky príkazu, v ktorých sa priamo spúšťa git: `tokens` úseku a index `gi` príkazu git.
// Text v heredoci a v úvodzovkách sa vynechá, `sh -c '...'` sa rozbalí.
function* gitCalls(raw) {
  const norm = stripHeredocs(String(raw)).replace(/(^|[;&|(\n]\s*)((?:ba|da|z)?sh)\s+-[a-z]*c(?=\s)/g, "$1$2 -c");
  const flat = stripProse(norm)
    .replace(/\b(?:ba|da|z)?sh\s+(?:-\S+\s+)*?-\w*c\s+['"]/g, "")
    .replace(/\b(?:su|runuser)\s+(?:-\S+\s+)*\S+\s+-c\s+['"]/g, "");
  for (const seg of flat.split(/[;&|\n`()]+/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    let gi;
    if (AS_USER.test(seg)) gi = tokens.findIndex((t) => IS_GIT.test(t));
    else {
      gi = cmdStart(tokens);
      if (gi >= 0 && tokens[gi] === "xargs") {
        gi++;
        while (gi < tokens.length && tokens[gi].startsWith("-")) gi++;
      }
    }
    if (gi < 0 || gi >= tokens.length || !IS_GIT.test(tokens[gi])) continue;
    yield { tokens, gi };
  }
}

// Vráti "core.hooksPath", "--no-verify" alebo "commit -n", keď príkaz vypína hooky repa, inak null.
export function hooksBypass(raw) {
  for (const { tokens, gi } of gitCalls(raw)) {
    let i = gi + 1;
    while (i < tokens.length && tokens[i].startsWith("-")) {
      const o = tokens[i];
      if ((o === "-c" || o === "--config-env") && HOOKS_KEY.test(unq(tokens[i + 1]))) return "core.hooksPath";
      if (o.startsWith("--config-env=") && HOOKS_KEY.test(unq(o.slice(13)))) return "core.hooksPath";
      i += GIT_OPT_VAL.has(o) ? 2 : 1;
    }
    const sub = unq(tokens[i]);
    for (let k = i + 1; k < tokens.length; k++) {
      const t = unq(tokens[k]);
      if (t === "--") break;
      if ((t === "--config" || (sub === "clone" && t === "-c")) && HOOKS_KEY.test(unq(tokens[k + 1]))) return "core.hooksPath";
      if (t.startsWith("--config=") && HOOKS_KEY.test(t.slice(9))) return "core.hooksPath";
      if (t === "--no-verify") return "--no-verify";
      if (sub === "commit") {
        if (commitShortHasN(t)) return "commit -n";
        if (COMMIT_VAL_LONG.has(t) || (/^-[A-Za-z]+$/.test(t) && COMMIT_VAL_SHORT.includes(t[t.length - 1]))) k++;
      }
    }
  }
  return null;
}

export const HOOKS_BYPASS_MESSAGE =
  "Hooky repa (pre-commit s `node check.mjs`, commit-msg s kontrolou autora) sa nevypínajú: " +
  "`git -c core.hooksPath=...`, `--no-verify` a `git commit -n` ich obídu a chyba prejde do gitu (global §6, env/server/CLAUDE.md, Git na serveri).";

export const HOOKS_BYPASS_POSTUP =
  "hooky repa musia bežať: oprav, čo hook hlási (`node check.mjs`, značky konfliktu, meno autora), a zopakuj " +
  "`git commit -m \"<správa>\" -- <zoznam vlastných súborov>` bez `-c core.hooksPath` a bez `--no-verify`.";

// --- plošné `git add` (úloha 694) -------------------------------------------
// Global §6 zakazuje `git add -A`, `git add --all` a `git add .`: do indexu
// pribudnú aj súbory inej relácie a tajomstvá. 30. 10. 2026 prešiel `git add -A`
// v klone bez zásahu hooku. `git add <konkrétny súbor>` prejde. Rozbor príkazu
// je ten z hooksBypass (gitCalls), text v heredoci a v úvodzovkách hook pustí.
// Voľby `git add` s hodnotou v ďalšom argumente (tvar `--voľba=hodnota` ju nespotrebuje).
const ADD_OPT_VAL = new Set(["--pathspec-from-file", "--chmod"]);

// Vráti "-A", "--all" alebo "." podľa toho, čo príkaz `git add` zbiera plošne, inak null.
export function addAll(raw) {
  for (const { tokens, gi } of gitCalls(raw)) {
    let i = gi + 1;
    while (i < tokens.length && tokens[i].startsWith("-")) i += GIT_OPT_VAL.has(tokens[i]) ? 2 : 1;
    if (unq(tokens[i]) !== "add") continue;
    let paths = false;
    for (let k = i + 1; k < tokens.length; k++) {
      const t = unq(tokens[k]);
      if (!paths && t === "--") paths = true;
      else if (!paths && t.startsWith("-")) {
        if (t === "--all") return "--all";
        if (/^-[A-Za-z]+$/.test(t) && t.includes("A")) return "-A";
        if (ADD_OPT_VAL.has(t)) k++;
      } else if (/^\.\/*$/.test(t)) return ".";
    }
  }
  return null;
}

export const ADD_ALL_MESSAGE =
  "`git add -A`, `git add --all` a `git add .` zoberú do indexu aj rozpracované súbory inej relácie a súbory, " +
  "ktoré nepatria do commitu (global §6, env/server/CLAUDE.md, Git na serveri). Pridaj len vlastné súbory.";

export const ADD_ALL_POSTUP =
  "commitni zoznam vlastných súborov: `git commit -m \"<správa>\" -- <zoznam vlastných súborov>`; " +
  "nový súbor najprv `git add <cesta k súboru>`, bez `-A`, `--all` a `.` (global §6).";
