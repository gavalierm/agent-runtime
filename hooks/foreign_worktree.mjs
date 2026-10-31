#!/usr/bin/env node
// requires: none
// foreign_worktree.mjs — agent nemení HEAD v cudzom worktree.
// 31. 10. 2026 (úloha 721): Agent robil posudky príkazom `git checkout` v
// cudzích worktree (`agentic-workflow-u720` a iných), u704 ostal detached
// s cudzím súborom. Posudok patrí do vlastného worktree.
//
// PreToolUse pre Bash: zamietne `git checkout`, `git switch` a `git reset`
// (akákoľvek forma, aj pod `runuser -u X --` a `sudo -u X`) vo worktree pod
// `/root/.worktrees/<meno>` alebo `/home/<user>/.worktrees/<meno>`, ktorého
// vlastník nie je aktuálny agent. Cieľ príkazu: `git -C <dir>`, inak posledné
// `cd <dir>` pred príkazom, inak cwd hooku. Text v heredocu a v úvodzovkách
// príkaz nespustí. Mimo `.worktrees` a pri neznámom agente hook pustí, neznámeho
// vlastníka zamietne.
// Vlastník worktree: súbor `agent-owner` v admin adresári worktree; bez neho
// predpona mena `<agent>-`; bez nej autor posledného commitu HEAD (prvé slovo
// malými, musí to byť známy agent, napr. `Beta (stroj)` -> beta).
// Známy agent = priečinok s PERSONA.md pod /root (AGENT_HOMES_DIR v skúškach).
//
// PostToolUse pre Bash: po `git worktree add <cesta>` zapíše `agent-owner`
// s aktuálnym agentom do admin adresára nového worktree.
//
// Skúšky: FOREIGN_WORKTREE_BASE (priečinok `.worktrees` namiesto /root a
// /home/<user>), AGENT_HOMES_DIR.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { stripHeredocs } from "./no_model_wait.mjs";
import { stripData, cmdStart, gitTarget } from "./foreign_git.mjs";
import { denyTool } from "../lib/deny.mjs";
import { agentName, HOMES_DIR } from "../lib/agent_name.mjs";

const GUARDED = new Set(["checkout", "switch", "reset"]);
const OWNER_FILE = "agent-owner";
const unq = (t) => (t || "").replace(/^['"]+|['"]+$/g, "");

function pathToken(t) {
  const v = unq(t);
  return !v || /[$`()*?~{}<>]/.test(v) ? null : v;
}

// Rozbalí `runuser ... -- cmd` a `sudo -u X cmd` na tokeny vnútorného príkazu.
function unwrap(tokens) {
  let s = cmdStart(tokens);
  if (s < 0) {
    let i = tokens.indexOf("sudo") + 1;
    while (i < tokens.length && tokens[i].startsWith("-")) i += /^-\w*u$|^--user$/.test(tokens[i]) ? 2 : 1;
    return unwrap(tokens.slice(i));
  }
  if (s >= tokens.length) return [];
  if (unq(tokens[s]) === "runuser") {
    const d = tokens.indexOf("--", s);
    return d < 0 ? [] : unwrap(tokens.slice(d + 1));
  }
  return tokens.slice(s);
}

// Príkazy z textu: [{tokens, cwd}], cwd po sledovaní `cd` (null = neurčiteľné).
export function commands(raw, cwd) {
  let cur = cwd && cwd.startsWith("/") ? cwd : null;
  const out = [];
  const flat = stripData(stripHeredocs(raw)).replace(/\b(?:ba|da|z)?sh\s+(?:-\S+\s+)*?-\w*c\s+['"]/g, "");
  for (const seg of flat.split(/[;&|\n`()]+/)) {
    const tokens = unwrap(seg.trim().split(/\s+/).filter(Boolean));
    if (!tokens.length) continue;
    if (unq(tokens[0]) === "cd") {
      const p = pathToken(tokens.filter((t) => !/^-[LPe@]+$/.test(t))[1]);
      cur = p === null ? null : p.startsWith("/") ? resolve(p) : cur === null ? null : resolve(cur, p);
      continue;
    }
    out.push({ tokens, cwd: cur });
  }
  return out;
}

// Koreň worktree pod .worktrees (prvá zložka), null mimo.
export function worktreeRoot(dir, base = process.env.FOREIGN_WORKTREE_BASE) {
  if (!dir) return null;
  if (base) {
    const b = resolve(base) + sep;
    return dir.startsWith(b) && dir.length > b.length ? join(b, dir.slice(b.length).split(sep)[0]) : null;
  }
  const m = /^((?:\/root|\/home\/[^/]+)\/\.worktrees\/[^/]+)/.exec(dir);
  return m ? m[1] : null;
}

// Admin adresár worktree z jeho súboru `.git` (ako rev-parse --absolute-git-dir), null keď nie je.
export function adminDir(root) {
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(join(root, ".git"), "utf8"));
    return m ? resolve(root, m[1].trim()) : null;
  } catch { return null; }
}

export function knownAgents(env = process.env) {
  const home = env.AGENT_HOMES_DIR || HOMES_DIR;
  try {
    return readdirSync(home).filter((n) => existsSync(join(home, n, "PERSONA.md"))).map((n) => n.toLowerCase());
  } catch { return []; }
}

// Vlastník worktree: meno agenta alebo null (neznámy).
export function ownerOf(root, known) {
  const admin = adminDir(root);
  if (admin) {
    try {
      const o = readFileSync(join(admin, OWNER_FILE), "utf8").trim().toLowerCase();
      if (o) return o;
    } catch {}
  }
  const name = root.split(sep).pop().toLowerCase();
  const pre = known.find((a) => name.startsWith(`${a}-`));
  if (pre) return pre;
  try {
    const an = execFileSync("git", ["-C", root, "log", "-1", "--format=%an"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    const first = an.split(/\s+/)[0].toLowerCase();
    return known.includes(first) ? first : null;
  } catch { return null; }
}

const isGit = (t) => /^(?:\S*\/)?git$/.test(unq(t));

// Dôvod zamietnutia alebo null.
export function foreignWorktreeReason(raw, { cwd = null, env = process.env, input = {} } = {}) {
  const me = (agentName({ ...input, cwd }, env) || "").toLowerCase();
  if (!me) return null;
  const known = knownAgents(env);
  if (!known.includes(me)) return null;
  for (const { tokens, cwd: cur } of commands(raw, cwd)) {
    if (!isGit(tokens[0])) continue;
    const { sub, start } = gitTarget(tokens, 0, cur);
    if (!GUARDED.has(sub) || !start) continue;
    const root = worktreeRoot(start, env.FOREIGN_WORKTREE_BASE);
    if (!root) continue;
    const owner = ownerOf(root, known);
    // Neznámy vlastník zamietne: verejné repo má na každom commite autora
    // `spravca-agentov`, takže autor vlastníka neurčí (replay u720 na serveri pustil).
    if (!owner) return `git ${sub} vo worktree ${root} bez súboru ${OWNER_FILE} a bez predpony agenta v mene, vlastník je neznámy`;
    if (owner !== me) return `git ${sub} vo worktree ${root}, ktorého vlastník je ${owner}, nie ${me}`;
  }
  return null;
}

// Po `git worktree add <cesta>` vráti absolútnu cestu nového worktree alebo null.
export function addedWorktree(raw, cwd) {
  for (const { tokens, cwd: cur } of commands(raw, cwd)) {
    if (!isGit(tokens[0])) continue;
    const { sub, start } = gitTarget(tokens, 0, cur);
    if (sub !== "worktree") continue;
    let i = tokens.indexOf("worktree");
    if (tokens[i + 1] !== "add") continue;
    const pos = [];
    for (i += 2; i < tokens.length; i++) {
      if (tokens[i].startsWith("-")) {
        if (/^(-b|-B|--orphan|--reason)$/.test(tokens[i])) i++;
      } else pos.push(tokens[i]);
    }
    const p = pathToken(pos[0]);
    if (p === null) continue;
    if (p.startsWith("/")) return resolve(p);
    if (start) return resolve(start, p);
  }
  return null;
}

// Zapíše agent-owner do admin adresára nového worktree, vráti cestu súboru alebo null.
export function recordOwner(raw, cwd, env = process.env, input = {}) {
  const me = (agentName({ ...input, cwd }, env) || "").toLowerCase();
  const path = addedWorktree(raw, cwd);
  if (!me || !path) return null;
  const admin = adminDir(path);
  if (!admin || !existsSync(admin)) return null;
  writeFileSync(join(admin, OWNER_FILE), `${me}\n`);
  return join(admin, OWNER_FILE);
}

export const MESSAGE =
  "Cudzí worktree je cudzia pracovná plocha: checkout, switch alebo reset v ňom prepíše HEAD a súbory vlastníka " +
  "(u704 ostal detached s cudzím súborom, 31. 10. 2026).";

export const POSTUP =
  "vlastný worktree na posudok: `git worktree add /root/.worktrees/<agent>-review-u<úloha> origin/<vetva>` " +
  "(vetvu stiahne `git fetch origin`), cudzí worktree len čítaj (`git -C <cesta> log`, `show`, `diff`); " +
  "vlastný worktree bez vlastníka označí jeho tvorca: `echo <agent> > \"$(git -C <cesta> rev-parse --absolute-git-dir)/agent-owner\"`.";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  if (input.tool_name !== "Bash") process.exit(0);
  const command = String(input.tool_input?.command || "");
  const cwd = typeof input.cwd === "string" ? input.cwd : null;
  try {
    if (input.hook_event_name === "PostToolUse") recordOwner(command, cwd, process.env, input);
    else {
      const why = foreignWorktreeReason(command, { cwd, input });
      if (why) denyTool(`${MESSAGE} (${why})`, POSTUP);
    }
  } catch {}
}
