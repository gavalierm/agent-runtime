#!/usr/bin/env node
// requires: none
// project_branch.mjs — commit na main v repe projektu je len merge dev (D0182).
// Repo projektu (kód, web, dáta) dostáva prácu agenta commitom do vetvy `dev`,
// po dôkaze ide `git merge --no-ff dev` do `main`. Hook zamietne `git commit`,
// ktorý by skončil na `main` alebo `master` repa projektu. Úloha Taskera 616.
//
// PreToolUse pre Bash. Príkaz `git commit` (aj `git -C <cesta> commit`, za `&&`,
// `;`, `|`, pod `sh -c`, `runuser -u X -- git ...`, `sudo -u X git ...`) posúdi
// podľa `.git/HEAD` repa (súbor, nie príkaz git): `ref: refs/heads/main` alebo
// `master`, bez `MERGE_HEAD` (dokončenie merge) a s existujúcou vetvou (prvý
// commit nového repa prejde) sa zamietne. Repo projektu je repo pod
// `/home/<používateľ>/projekty/`, `AR_PROJECT_ROOTS` (priečinky oddelené `:`)
// to nahradí. Repo kódu a spoločného mozgu a /root/<meno> prejde, `git merge`
// nie je commit a prejde. Cieľ, ktorý sa nedá určiť (premenná, `$(...)`), prejde.
// Text v úvodzovkách a heredoci (správa commitu) hook nečíta.

import { readFileSync, statSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripHeredocs } from "./no_model_wait.mjs";
import { cmdStart, gitTarget, stripData } from "./foreign_git.mjs";
import { denyTool } from "../lib/deny.mjs";

const DEFAULT_ROOT = /^\/home\/[^/]+\/projekty\//;
const MAIN = new Set(["main", "master"]);

function pathToken(t) {
  const v = t.replace(/^['"]+|['"]+$/g, "");
  if (!v || /[$`()*?~{}<>]/.test(v)) return null;
  return v;
}

// Adresár gitu repa s koreňom `root`: `.git` je priečinok, alebo súbor
// `gitdir: <cesta>` (worktree).
function gitDirOf(root) {
  const dot = join(root, ".git");
  let st;
  try {
    st = statSync(dot);
  } catch {
    return null;
  }
  if (st.isDirectory()) return dot;
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"));
    return m ? resolve(root, m[1].trim()) : null;
  } catch {
    return null;
  }
}

// Koreň repa: najbližší predok cesty s `.git`, null keď žiadny.
function repoRoot(start) {
  for (let p = start; ; p = dirname(p)) {
    if (existsSync(join(p, ".git"))) return p;
    if (dirname(p) === p) return null;
  }
}

export function projectRoots(env = process.env) {
  return env.AR_PROJECT_ROOTS ? env.AR_PROJECT_ROOTS.split(":").filter(Boolean).map((r) => resolve(r)) : null;
}

function isProjectRepo(root, roots) {
  if (roots) return roots.some((r) => root === r || root.startsWith(r + "/"));
  return DEFAULT_ROOT.test(root + "/");
}

// Vetva, na ktorú ukazuje HEAD, a či už má commit. null pre odpojený HEAD.
function headBranch(gitDir) {
  let head;
  try {
    head = readFileSync(join(gitDir, "HEAD"), "utf8");
  } catch {
    return null;
  }
  const m = /^ref:\s*refs\/heads\/(\S+)/.exec(head);
  if (!m) return null;
  const branch = m[1];
  // Worktree má vlastný gitdir a `commondir` ukazuje na spoločný s refs.
  let common = gitDir;
  try {
    common = resolve(gitDir, readFileSync(join(gitDir, "commondir"), "utf8").trim());
  } catch {}
  let born = existsSync(join(common, "refs", "heads", branch));
  if (!born) {
    try {
      born = readFileSync(join(common, "packed-refs"), "utf8").split("\n").some((l) => l.endsWith(` refs/heads/${branch}`));
    } catch {}
  }
  return { branch, born };
}

// Vráti { repo, branch } pre zakázaný commit, alebo null. `opts.cwd` je pracovný
// priečinok z hooku, `opts.roots` priečinky projektov (inak AR_PROJECT_ROOTS,
// inak /home/<používateľ>/projekty).
export function branchViolation(raw, { cwd = null, roots = projectRoots() } = {}) {
  let cur = cwd && cwd.startsWith("/") ? cwd : null;
  const flat = stripData(stripHeredocs(raw)).replace(/\b(?:ba|da|z)?sh\s+(?:-\S+\s+)*?-\w*c\s+['"]/g, "");
  for (const seg of flat.split(/[;&|\n`()]+/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    const s = cmdStart(tokens);
    const head = s >= 0 && s < tokens.length ? tokens[s].replace(/^['"]+|['"]+$/g, "") : "";
    if (head === "cd") {
      const p = pathToken(tokens.slice(s + 1).filter((t) => !/^-[LPe@]+$/.test(t))[0] || "");
      cur = p === null ? null : p.startsWith("/") ? resolve(p) : cur === null ? null : resolve(cur, p);
      continue;
    }
    // `runuser -u X -- git ...`, `sudo -u X git ...`, `su X -c git ...`: git je za predponou.
    let gi = -1;
    if (/^(?:\S*\/)?git$/.test(head)) gi = s;
    else if (s < 0 || /^(?:runuser|sudo|su)$/.test(head)) {
      gi = tokens.findIndex((t) => /^['"]?(?:\S*\/)?git['"]?$/.test(t));
    }
    if (gi < 0) continue;
    const { sub, start } = gitTarget(tokens, gi, cur);
    if (sub !== "commit" || start === null) continue;
    const root = repoRoot(start);
    if (root === null || !isProjectRepo(root, roots)) continue;
    const gitDir = gitDirOf(root);
    if (!gitDir) continue;
    const hb = headBranch(gitDir);
    if (!hb || !MAIN.has(hb.branch) || !hb.born) continue;
    if (existsSync(join(gitDir, "MERGE_HEAD"))) continue;
    return { repo: root, branch: hb.branch };
  }
  return null;
}

export function message({ repo, branch }) {
  return `Commit na ${branch} v repe projektu ${repo} mimo merge (D0182). Práca agenta ide do vetvy dev, do main len merge dev.`;
}

export function postup({ repo }) {
  return `git -C ${repo} checkout dev (keď chýba: git checkout -b dev main), commit do dev, po dôkaze merge dev do main v dočasnom worktree: dokonci.sh koniec <úloha> (skill dokonci), alebo git worktree add /tmp/merge-<úloha> origin/main && git -C /tmp/merge-<úloha> merge --no-ff origin/dev && git -C /tmp/merge-<úloha> push origin HEAD:main (env/server/CLAUDE.md, Git na serveri).`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  if (input.tool_name !== "Bash") process.exit(0);
  const v = branchViolation(String((input.tool_input || {}).command || ""), { cwd: typeof input.cwd === "string" ? input.cwd : null });
  if (v) denyTool(message(v), postup(v));
}
