#!/usr/bin/env node
// requires: none
// foreign_git.mjs — agent neobchádza ochranu vlastníctva gitu.
// Git root-a v klone iného používateľa odmietne ("dubious ownership").
// Dňa 20. 10. 2026 agent túto ochranu obišiel príkazmi `git -c
// safe.directory=* fetch`, `status` a `log`. Git bežiaci ako root
// vytvoril v `.git` súbory vlastnené rootom a `git pull` pod
// správcom úloh potom zlyhal. Správna cesta je spustiť git pod
// vlastníkom klonu.
// Tretia kontrola (22. 10. 2026): git stash, reset --hard, checkout --, restore,
// clean a --autostash (hooks/shared_git.mjs), aj pod runuser a sudo -u.
// Štvrtá kontrola (úloha 621): `git -c core.hooksPath=...`, `--no-verify` a
// `git commit -n` vypnú hooky repa (hooksBypass v hooks/shared_git.mjs).
// Druhý výskyt 22. 10. 2026: vlákno webového projektu spustilo ako root
// `git fetch` v klone /home/<používateľ správcu úloh>/projekty/web/web-repo.
// `.git/FETCH_HEAD` ostal rootovi a fetch pod používateľom správcu úloh padol. Git
// zapisuje aj pri čítaní (index, FETCH_HEAD), preto nestačí zakázať
// obchádzanie ochrany.
//
// PreToolUse pre Bash. Zamietne dvoje. Prvé: príkaz, v ktorom
// `safe.directory` je argument príkazu git (`-c`, `--config-env`,
// `git config`) alebo priradenie premennej `GIT_CONFIG*`. Druhé: každý
// priamo spustený `git` (aj `git -C <cesta>`, aj za `&&`, `;`, `|`)
// v klone, ktorého koreň (priečinok s `.git`, hľadá sa od cieľa alebo
// cwd hore) vlastní iný uid než proces hooku. Pod `runuser -u`, `sudo -u`
// a `su` pustí. Čítanie mimo gitu (`cat`, `grep`), text v heredocu
// a v úvodzovkách pustí.

import { readFileSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripHeredocs } from "./no_model_wait.mjs";
import { SHARED_GIT, SHARED_GIT_MESSAGE, SHARED_GIT_POSTUP, hooksBypass, HOOKS_BYPASS_MESSAGE, HOOKS_BYPASS_POSTUP } from "./shared_git.mjs";
import { denyTool } from "../lib/deny.mjs";

const SAFE = /safe\.directory/i;
const GIT_ARG = /\bgit\b[\s\S]*?(?:(?:^|\s)-c\s*['"]?\s*safe\.directory|--config-env[=\s]+['"]?safe\.directory|\bconfig\b[\s\S]*safe\.directory)/i;
const GIT_ENV = /\bGIT_CONFIG\w*=[\s\S]*safe\.directory/i;

// Reťazec v úvodzovkách s medzerou je text (správa, --body, -m), nie
// argument gitu. Ostane reťazec, ktorý začína safe.directory, napríklad
// `-c "safe.directory=/cesta s medzerou"`. Chyba 20. 10. 2026: správa
// agentovi a commit so slovom safe.directory v texte boli zamietnuté.
// Reťazec za `-c`, `eval` a `ssh <stroj>` shell spustí, ten ostane.
export function stripProse(command) {
  return command.replace(/(-c|\beval|\bssh\s+(?:-\S+\s+)*\S+)?(\s*)('[^']*'|"(?:[^"\\]|\\.)*")/g, (all, run, sp, str) => {
    const body = str.slice(1, -1);
    if (run || /^\s*['"]?safe\.directory/i.test(body) || !/\s/.test(body)) return all;
    return `${sp}''`;
  });
}

// Token bez úvodzoviek. Cesta s premennou, `$(...)`, vzorkou alebo
// vlnovkou sa nedá určiť, vráti null a príkaz prejde.
function pathToken(t) {
  const v = t.replace(/^['"]+|['"]+$/g, "");
  if (!v || /[$`()*?~{}<>]/.test(v)) return null;
  return v;
}

// Úsek beží pod iným používateľom: `runuser -u X --`, `sudo -u X`, `su X -c`.
const AS_USER = /^\s*(?:\w+=\S*\s+)*(?:runuser\s|sudo\s+(?:-\S+\s+)*-\w*u\b|su\s)/;

// Voľby gitu pred podpríkazom a voľby podpríkazov, ktoré berú hodnotu
// v ďalšom argumente (tvar `--voľba=hodnota` ďalší argument nespotrebuje).
const GIT_OPT_VAL = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);
const CLONE_OPT_VAL = new Set(["-b", "--branch", "-o", "--origin", "-c", "--config", "--depth", "--reference", "--reference-if-able", "--template", "--separate-git-dir", "-j", "--jobs", "--filter", "-u", "--upload-pack", "--server-option", "--shallow-since", "--shallow-exclude", "--ref-format", "--bundle-uri"]);
const INIT_OPT_VAL = new Set(["--template", "--separate-git-dir", "-b", "--initial-branch", "--object-format", "--ref-format"]);

// Z úseku s `git clone` alebo `git init` vráti cieľovú cestu, `null`, keď ju
// nevie určiť, alebo `undefined`, keď úsek nie je clone ani init.
function cloneTarget(tokens, cwd) {
  const gi = tokens.findIndex((t) => /^['"]?git['"]?$/.test(t));
  if (gi < 0) return undefined;
  let i = gi + 1;
  while (i < tokens.length && tokens[i].startsWith("-")) {
    const o = tokens[i];
    if (o === "-C") {
      const p = pathToken(tokens[i + 1] || "");
      if (p === null) cwd = null;
      else if (p.startsWith("/")) cwd = resolve(p);
      else cwd = cwd === null ? null : resolve(cwd, p);
      i += 2;
    } else {
      i += GIT_OPT_VAL.has(o) ? 2 : 1;
    }
  }
  const sub = (tokens[i] || "").replace(/^['"]+|['"]+$/g, "");
  if (sub !== "clone" && sub !== "init") return undefined;
  const optVal = sub === "clone" ? CLONE_OPT_VAL : INIT_OPT_VAL;
  const pos = [];
  for (i += 1; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.startsWith("-")) {
      if (optVal.has(t)) i++;
    } else pos.push(t);
  }
  let dir;
  if (sub === "init") dir = pos.length ? pathToken(pos[pos.length - 1]) : cwd;
  else if (pos.length >= 2) dir = pathToken(pos[pos.length - 1]);
  else if (pos.length === 1) {
    const url = pathToken(pos[0]);
    const base = url && url.replace(/\/+$/, "").replace(/\.git$/, "").split(/[/:]/).pop();
    dir = base || null;
  } else return null;
  if (dir === null || dir === undefined) return null;
  if (dir.startsWith("/")) return resolve(dir);
  return cwd === null ? null : resolve(cwd, dir);
}

// UID vlastníka najbližšieho existujúceho predka cesty, null keď žiadny.
function ownerUid(path, stat) {
  for (let p = path; ; p = dirname(p)) {
    try {
      return stat(p).uid;
    } catch {}
    if (dirname(p) === p) return null;
  }
}

// Predpony, za ktorými príkaz beží ďalej: `time git ...`, `if cd x; then git`.
const PREFIX = new Set(["env", "time", "nohup", "exec", "command", "nice", "!", "{", "if", "then", "elif", "else", "do", "while", "until"]);

// Index príkazu v úseku po predponách a priradeniach `VAR=x`, -1 pre
// `sudo -u` (iný používateľ).
export function cmdStart(tokens) {
  let i = 0;
  for (; i < tokens.length; i++) {
    const t = tokens[i];
    if (/^[A-Za-z_]\w*=/.test(t) || PREFIX.has(t)) continue;
    if (t === "timeout") {
      while (/^-/.test(tokens[i + 1] || "")) i++;
      if (/^\d/.test(tokens[i + 1] || "")) i++;
    } else if (t === "sudo") {
      while (/^-/.test(tokens[i + 1] || "")) if (/^(-\w*u|--user.*)$/.test(tokens[++i])) return -1;
    } else break;
  }
  return i;
}

// Reťazec v úvodzovkách s medzerou je text. Ostane ten za `-c` a `eval`
// (shell ho spustí) a "..." s `$(` alebo spätným apostrofom. Reťazec za
// `ssh <stroj>` beží inde, zmizne. Krátky reťazec bez medzery (cesta)
// ostane.
export function stripData(command) {
  return command.replace(/(-c|\beval|\bssh\s+(?:-\S+\s+)*\S+)?(\s*)('[^']*'|"(?:[^"\\]|\\.)*")/g, (all, run, sp, str) => {
    if (run && run.startsWith("ssh")) return `${run}${sp}''`;
    if (run || !/\s/.test(str.slice(1, -1)) || (str[0] === '"' && /\$\(|`/.test(str))) return all;
    return `${sp}''`;
  });
}

// Z `git [voľby] podpríkaz` vráti podpríkaz a východiskovú cestu pre
// hľadanie koreňa repa (`-C` sa skladá, `--git-dir` ju určí sám).
export function gitTarget(tokens, gi, cwd) {
  let i = gi + 1;
  let gitDir = null;
  const rel = (p) => (p === null ? null : p.startsWith("/") ? resolve(p) : cwd === null ? null : resolve(cwd, p));
  while (i < tokens.length && tokens[i].startsWith("-")) {
    const o = tokens[i];
    if (o === "-C") {
      cwd = rel(pathToken(tokens[i + 1] || ""));
      i += 2;
    } else if (o === "--git-dir" || o === "--work-tree") {
      if (o === "--git-dir") gitDir = rel(pathToken(tokens[i + 1] || ""));
      i += 2;
    } else {
      if (o.startsWith("--git-dir=")) gitDir = rel(pathToken(o.slice(10)));
      i += GIT_OPT_VAL.has(o) ? 2 : 1;
    }
  }
  return { sub: (tokens[i] || "").replace(/^['"]+|['"]+$/g, ""), start: gitDir || cwd };
}

// Koreň repa: najbližší predok cesty s `.git`, null keď žiadny.
function repoRoot(start, stat) {
  for (let p = start; ; p = dirname(p)) {
    try {
      stat(join(p, ".git"));
      return p;
    } catch {}
    if (dirname(p) === p) return null;
  }
}

function userName(uid) {
  try {
    for (const l of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const f = l.split(":");
      if (Number(f[2]) === uid) return f[0];
    }
  } catch {}
  return "<vlastník>";
}

// Druhá kontrola: priamy `git` v klone iného používateľa. Cieľ, ktorý sa
// nedá určiť (premenná, `$(...)`), prejde. `clone` a `init` rieši prvá
// kontrola, repo ešte nemusí existovať.
function ownerReason(raw, { cwd, stat, uid }) {
  let cur = cwd && cwd.startsWith("/") ? cwd : null;
  // `sh -c '...'` sa rozbalí, jeho príkazy sa posúdia ako ostatné.
  const flat = stripData(stripHeredocs(raw)).replace(/\b(?:ba|da|z)?sh\s+(?:-\S+\s+)*?-\w*c\s+['"]/g, "");
  for (const seg of flat.split(/[;&|\n`()]+/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    const s = cmdStart(tokens);
    if (s < 0 || s >= tokens.length) continue;
    const head = tokens[s].replace(/^['"]+|['"]+$/g, "");
    if (head === "cd") {
      const args = tokens.slice(s + 1).filter((t) => !/^-[LPe@]+$/.test(t));
      const p = pathToken(args[0] || "");
      cur = p === null ? null : p.startsWith("/") ? resolve(p) : cur === null ? null : resolve(cur, p);
      continue;
    }
    if (!/^(?:\S*\/)?git$/.test(head)) continue;
    const { sub, start } = gitTarget(tokens, s, cur);
    if (!sub || start === null || ["clone", "init", "help", "version"].includes(sub)) continue;
    const root = repoRoot(start, stat);
    if (root === null) continue;
    let owner;
    try {
      owner = stat(root).uid;
    } catch {
      continue;
    }
    if (owner !== uid) return `git ako uid ${uid} v klone používateľa uid ${owner}: ${root}, spusti \`runuser -u ${userName(owner)} -- git ...\``;
  }
  return null;
}

// Vráti dôvod zamietnutia alebo null. Príkaz sa delí na úseky podľa
// `;`, `&`, `|` a nového riadka, aby `grep safe.directory` za `git
// config --list` neprešlo ako argument gitu. `opts.cwd` je pracovný
// priečinok z hooku, `opts.stat` zisťuje vlastníka (v testoch fake), `opts.uid` je uid procesu.
export function foreignGitReason(raw, { cwd = null, stat = statSync, uid = process.getuid() } = {}) {
  let cur = cwd && cwd.startsWith("/") ? cwd : null;
  for (const seg of stripProse(stripHeredocs(raw)).split(/[;&|\n]+/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    if (tokens[0] === "cd") {
      const p = pathToken(tokens[1] || "");
      cur = p === null ? null : p.startsWith("/") ? resolve(p) : cur === null ? null : resolve(cur, p);
    }
    if (SAFE.test(seg)) {
      if (GIT_ENV.test(seg)) return "GIT_CONFIG* so safe.directory";
      if (GIT_ARG.test(seg)) return "safe.directory v príkaze git";
    }
    if (AS_USER.test(seg) || !/\bgit\b/.test(seg)) continue;
    const target = cloneTarget(tokens, cur);
    if (!target) continue;
    const uid = ownerUid(target, stat);
    if (uid !== null && uid !== 0) return `git clone alebo init v strome používateľa uid ${uid}: ${target}`;
  }
  // Treťa kontrola: git, ktorý schová alebo zahodí cudzie rozpracované súbory.
  // Platí aj pod `runuser -u` a `sudo -u`, klon zdieľajú relácie.
  if (SHARED_GIT.test(stripProse(stripHeredocs(raw)))) return "SHARED_GIT";
  // Štvrtá kontrola (úloha 621): vypnutie hookov repa (-c core.hooksPath, --no-verify, commit -n).
  if (hooksBypass(raw)) return "HOOKS_BYPASS";
  return ownerReason(raw, { cwd, stat, uid });
}

export const MESSAGE_OWNER =
  "Git v klone iného používateľa spúšťaj pod jeho vlastníkom: `runuser -u <vlastník> -- git ...`. " +
  "Aj čítanie (`status`, `log`, `fetch`) zapíše do `.git` (index, FETCH_HEAD) súbory vlastnené rootom " +
  "a vlastník potom nezapíše. Vlastníka zistí `stat -c %U <cesta>`.";

export const POSTUP =
  "`runuser -u <vlastník> -- git ...`, vlastníka klonu zistí `stat -c %U <cesta>`; nový klon v cudzom strome " +
  "`runuser -u <vlastník cieľa> -- git clone <url> <cieľ>` (env/server/CLAUDE.md, Git na serveri).";

export const MESSAGE =
  "Ochranu vlastníctva gitu (safe.directory) neobchádzaj: git ako root vytvorí v `.git` súbory vlastnené rootom " +
  "a vlastník klonu potom nezapíše. Git v cudzom klone spúšťaj pod vlastníkom klonu, " +
  "`runuser -u <vlastník> -- git ...`, vlastníka zistí `stat -c %U <cesta>`. Platí aj pre `git clone` a `git init`: " +
  "ak cieľ leží v strome iného používateľa než root, nový klon patrí rootovi a vlastník doň nezapíše, " +
  "preto `runuser -u <vlastník cieľa> -- git clone <url> <cieľ>`.";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  const ti = input.tool_input || {};
  if (input.tool_name !== "Bash") process.exit(0);
  const why = foreignGitReason(String(ti.command || ""), { cwd: typeof input.cwd === "string" ? input.cwd : null });
  if (!why) process.exit(0);
  if (why === "SHARED_GIT") denyTool(SHARED_GIT_MESSAGE, SHARED_GIT_POSTUP);
  else if (why === "HOOKS_BYPASS") denyTool(`${HOOKS_BYPASS_MESSAGE} (${hooksBypass(String(ti.command || ""))})`, HOOKS_BYPASS_POSTUP);
  else denyTool(`${why.startsWith("git ako uid") ? MESSAGE_OWNER : MESSAGE} (${why})`, POSTUP);
}
