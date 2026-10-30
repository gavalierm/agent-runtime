#!/usr/bin/env node
// requires: none
// deploy_readonly.mjs — /opt/tasker a nasadené klony kódu a spoločného mozgu
// (workflowDir, brainGlobalDir; AR_READONLY_DIRS ich prekryje) nikto nemení
// ani necommituje.
// /opt/tasker je nasadenie správcu servera (D0052), klony sú kópia na
// čítanie, ktorú pravidelne obnoví časovač. Chyba 20. 10. 2026: príznak `--quiet`
// zapísaný a commitnutý priamo v /opt/tasker pod menom root. Pravidlo v persone
// nestačilo (global §4), preto hook. Úloha 621.
//
// Je to samostatný hook a nie rozšírenie hooks/guard.mjs: guard.mjs je zábrana
// územia pre Mac (~/Work, vždy len `ask`, na serveri nie je zapojený), zákaz pre
// každého agenta na serveri musí byť hook, ktorý zapína env/server/install.sh.
//
// PreToolUse pre Edit, Write, MultiEdit, NotebookEdit a Bash. Zamietne zápis súboru
// s cestou pod /opt/tasker/ alebo pod nasadenými klonmi (cesta sa rozloží cez `..`
// a odkazy, relatívna cesta sa berie od cwd) a v Bash `git commit` (aj `git -C <cesta>`,
// `--git-dir`, `cd <cesta> && git commit`, za `&&`, `;`, `|`, pod `sh -c`, `runuser -u X --`,
// `sudo -u X`), ktorého repo leží v týchto cestách. `git fetch`, `checkout`, `merge`,
// `log`, `status` a ďalšie čítanie či nasadenie správcu servera prejdú. Text v úvodzovkách
// a v heredoci (správa commitu) hook nečíta. Cieľ, ktorý sa nedá určiť (premenná,
// `$(...)`), prejde. Test: hooks/deploy_readonly.test.mjs.
//
// Zápis súboru cez Bash (30. 10. 2026, úloha 680): `sed -i ... /root/CLAUDE.md` prešiel,
// hoci /root/CLAUDE.md je odkaz na env/server/RULES.md v nasadenom klone mozgu a pravidlo
// v klone sa pri ďalšom stiahnutí stratí alebo zablokuje fetch. Preto Bash zamietne aj
// zápis do súboru pod chráneným koreňom: ciele `sed -i`/`--in-place`, `perl -i`, `tee`
// (aj `-a`), presmerovanie `>` a `>>`, cieľ `cp`/`mv`/`install` (aj zdroj `mv`), `rm`,
// `truncate` a `python3 -c` s `open(..., "w"/"a")`, `write_text` alebo `write_bytes`.
// Každý cieľ sa rozloží cez `real` (realpath najbližšieho existujúceho predka), takže odkaz
// vedúci do klona sa zachytí; pri `rm` a zdroji `mv` sa odkaz na konci cesty nerozkladá
// (maže sa odkaz, nie jeho cieľ). Čítanie (`sed -n`, `cat`, `grep`, `git log`, `diff`,
// `cp <zdroj z klonu> /tmp/x`) prejde, rovnako ciele mimo koreňov a ciele, ktoré sa nedajú
// určiť (premenná, `$(...)`).

import { readFileSync, realpathSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripHeredocs } from "./no_model_wait.mjs";
import { cmdStart, gitTarget, stripData } from "./foreign_git.mjs";
import { denyTool } from "../lib/deny.mjs";
import { brainGlobalDir, workflowDir } from "../lib/paths.mjs";

// Chránené koreňe: /opt/tasker, klon kódu a klon spoločného mozgu. AR_READONLY_DIRS
// (cesty oddelené `:`) ich celé prekryje, používa to test.
export function protectedDirs(env = process.env) {
  if (env.AR_READONLY_DIRS) return env.AR_READONLY_DIRS.split(":").filter(Boolean).map((d) => resolve(d));
  return ["/opt/tasker", workflowDir(env), brainGlobalDir(env)];
}

export const PROTECTED = protectedDirs();

const inside = (p) => PROTECTED.find((r) => p === r || p.startsWith(r + "/")) ?? null;

// Najbližší existujúci predok cesty cez realpath (odkaz do /opt), zvyšok sa pripojí späť.
function real(p) {
  const parts = [];
  for (let q = p; ; q = dirname(q)) {
    try {
      return resolve(realpathSync(q), ...parts);
    } catch {}
    if (dirname(q) === q) return p;
    parts.unshift(basename(q));
  }
}

// Chránený koreň, do ktorého cesta zapisuje, alebo null. `leaf: false` nerozkladá odkaz
// na konci cesty (rm a zdroj mv mažú odkaz, nie jeho cieľ).
export function protectedRoot(path, cwd = null, { leaf = true } = {}) {
  return resolveProtected(path, cwd, leaf)?.root ?? null;
}

// { root, resolved } pre cestu pod chráneným koreňom, inak null.
function resolveProtected(path, cwd, leaf = true) {
  if (!path || typeof path !== "string") return null;
  const abs = path.startsWith("/") ? resolve(path) : cwd && cwd.startsWith("/") ? resolve(cwd, path) : null;
  if (!abs) return null;
  const direct = inside(abs);
  if (direct) return { root: direct, resolved: abs };
  const resolved = leaf ? real(abs) : join(real(dirname(abs)), basename(abs));
  const root = inside(resolved);
  return root ? { root, resolved } : null;
}

function pathToken(t) {
  const v = t.replace(/^['"]+|['"]+$/g, "");
  if (!v || /[$`()*?~{}<>]/.test(v)) return null;
  return v;
}

// Chránený koreň, v ktorom príkaz Bash robí `git commit`, alebo null.
export function commitRoot(raw, cwd = null) {
  let cur = cwd && cwd.startsWith("/") ? cwd : null;
  const flat = stripData(stripHeredocs(String(raw))).replace(/\b(?:ba|da|z)?sh\s+(?:-\S+\s+)*?-\w*c\s+['"]/g, "");
  for (const seg of flat.split(/[;&|\n`()]+/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    const s = cmdStart(tokens);
    const head = s >= 0 && s < tokens.length ? tokens[s].replace(/^['"]+|['"]+$/g, "") : "";
    if (head === "cd") {
      const p = pathToken(tokens.slice(s + 1).filter((t) => !/^-[LPe@]+$/.test(t))[0] || "");
      cur = p === null ? null : p.startsWith("/") ? resolve(p) : cur === null ? null : resolve(cur, p);
      continue;
    }
    let gi = -1;
    if (/^(?:\S*\/)?git$/.test(head)) gi = s;
    else if (s < 0 || /^(?:runuser|sudo|su)$/.test(head)) gi = tokens.findIndex((t) => /^['"]?(?:\S*\/)?git['"]?$/.test(t));
    if (gi < 0) continue;
    const { sub, start } = gitTarget(tokens, gi, cur);
    if (sub !== "commit" || start === null) continue;
    const root = protectedRoot(start);
    if (root) return root;
  }
  return null;
}

const WRITERS = new Set(["sed", "perl", "tee", "cp", "mv", "install", "rm", "truncate", "python", "python3"]);
const PY_WRITE = /open\([^)]*["'][wax]\+?b?["']|write_text|write_bytes/;
const PY_CODE = /\bpython3?\b(?:\s+-[^\s'"c]\S*)*\s+-c\s*('[^']*'|"(?:[^"\\]|\\.)*")/g;
const unquote = (t) => t.replace(/^['"]+|['"]+$/g, "");
const isOpt = (t) => /^-./.test(t);

// Argumenty bez volieb; `valued` sú voľby, ktoré berú nasledujúci token ako hodnotu.
function operands(args, valued = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === "--") {
      out.push(...args.slice(i + 1));
      break;
    }
    if (valued.includes(t)) i++;
    else if (!isOpt(t)) out.push(t);
  }
  return out;
}

// Cieľové cesty zápisu pre jeden príkaz: [{ path, leaf }]. `args` sú tokeny za menom príkazu.
function writeTargets(name, args) {
  const bare = args.map(unquote);
  if (name === "tee") return operands(bare).map((path) => ({ path }));
  if (name === "rm") return operands(bare).map((path) => ({ path, leaf: false }));
  if (name === "truncate") return operands(bare, ["-s", "-r", "--size", "--reference"]).map((path) => ({ path }));
  if (name === "sed" || name === "perl") {
    const inplace = bare.some((t) => /^-[A-Za-z]*i\S*$/.test(t) || /^--in-place(?:=|$)/.test(t));
    if (!inplace) return [];
    // Voľba `-e`/`-f` (aj zlepená, `-ne`, `-pie`) a `--expression`/`--file` nesie skript v ďalšom tokene.
    const hasScript = (t) => /^-[A-Za-z]*[ef]$/.test(t) || t === "--expression" || t === "--file" || (name === "perl" && /^-[A-Za-z]*E$/.test(t));
    const ops = [];
    for (let i = 0; i < bare.length; i++) {
      if (hasScript(bare[i])) i++;
      else if (!isOpt(bare[i])) ops.push(bare[i]);
    }
    const script = bare.some(hasScript) || bare.some((t) => /^--(?:expression|file)=/.test(t));
    return (script ? ops : ops.slice(1)).map((path) => ({ path }));
  }
  if (name === "cp" || name === "mv" || name === "install") {
    const dir = bare.findIndex((t) => t === "-t" || t === "--target-directory");
    const attached = bare.find((t) => t.startsWith("--target-directory="));
    const ops = operands(bare, ["-t", "--target-directory", "-S", "--suffix", "-m", "-o", "-g"]);
    const out = [];
    if (dir >= 0 && bare[dir + 1]) out.push({ path: bare[dir + 1] });
    else if (attached) out.push({ path: attached.slice("--target-directory=".length) });
    else if (ops.length >= 2) out.push({ path: ops[ops.length - 1] });
    if (name === "mv") out.push(...ops.slice(0, dir >= 0 || attached ? ops.length : -1).map((path) => ({ path, leaf: false })));
    return out;
  }
  return [];
}

// Zápis do súboru pod chráneným koreňom v príkaze Bash: { target, root, resolved } alebo null.
export function writeRoot(raw, cwd = null) {
  let cur = cwd && cwd.startsWith("/") ? cwd : null;
  const flat = stripData(stripHeredocs(String(raw))).replace(/\b(?:ba|da|z)?sh\s+(?:-\S+\s+)*?-\w*c\s+['"]/g, "");
  const hit = (path, leaf = true) => {
    const p = pathToken(unquote(path || ""));
    const r = p === null ? null : resolveProtected(p, cur, leaf);
    return r ? { target: p, ...r } : null;
  };
  for (const m of flat.matchAll(PY_CODE)) {
    if (!PY_WRITE.test(m[1])) continue;
    for (const lit of m[1].matchAll(/["'](\/[^"'\s]*)["']/g)) {
      const r = hit(lit[1]);
      if (r) return r;
    }
  }
  const cleaned = flat.replace(/\d*>&\d*-?/g, " ").replace(/&>>?/g, ">");
  for (const seg of cleaned.split(/[;&|\n`()]+/)) {
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < tokens.length; i++) {
      const rd = /^\d*>>?(.*)$/.exec(tokens[i]);
      if (!rd) continue;
      const r = hit(rd[1] || tokens[i + 1]);
      if (r) return r;
    }
    let s = cmdStart(tokens);
    let head = s >= 0 && s < tokens.length ? basename(unquote(tokens[s])) : "";
    if (head === "cd") {
      const p = pathToken(tokens.slice(s + 1).filter((t) => !/^-[LPe@]+$/.test(t))[0] || "");
      cur = p === null ? null : p.startsWith("/") ? resolve(p) : cur === null ? null : resolve(cur, p);
      continue;
    }
    if (s < 0 || /^(?:runuser|sudo|su)$/.test(head)) {
      s = tokens.findIndex((t) => WRITERS.has(basename(unquote(t))));
      head = s >= 0 ? basename(unquote(tokens[s])) : "";
    }
    const name = /^python3?$/.test(head) ? "" : head;
    if (!WRITERS.has(name)) continue;
    for (const { path, leaf } of writeTargets(name, tokens.slice(s + 1))) {
      const r = hit(path, leaf);
      if (r) return r;
    }
  }
  return null;
}

export const MESSAGE =
  "/opt/tasker je nasadenie správcu servera a nasadené klony kódu a spoločného mozgu sú kópia na čítanie, ktorú obnovuje časovač: v nich nikto nič nemení ani necommituje (D0052). " +
  "Zmena tam sa pri ďalšom nasadení stratí alebo zablokuje fetch.";

export const POSTUP =
  "kód Taskera mení jeho vývojár v klone /root/tasker, pravidlá a kód správca agentov vo vlastnom klone a pushne; " +
  "nasadenie robí správca servera (`git -C /opt/tasker fetch` a `checkout`, nasadené klony obnoví časovač).";

export const POSTUP_WRITE =
  "zmenu urob v klone na zápis (nie v nasadenom klone, kód Taskera v klone vývojára) a commitni a pushni; " +
  "nasadený klon obnoví sťahovanie, nasadenie Taskera robí správca servera.";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  const ti = input.tool_input || {};
  const cwd = typeof input.cwd === "string" ? input.cwd : null;
  let why = null;
  let write = false;
  if (input.tool_name === "Bash") {
    const root = commitRoot(String(ti.command || ""), cwd);
    if (root) why = `git commit v ${root}`;
    else {
      const w = writeRoot(String(ti.command || ""), cwd);
      if (w) {
        why = `zápis do ${w.target}${w.resolved !== w.target ? ` (rozložené na ${w.resolved})` : ""}, chránený koreň ${w.root}`;
        write = true;
      }
    }
  } else if (/^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(input.tool_name || "")) {
    const p = ti.file_path ?? ti.notebook_path ?? ti.path;
    const root = protectedRoot(p, cwd);
    if (root) why = `zápis ${p} v ${root}`;
  }
  if (why) denyTool(`${MESSAGE} (${why})`, write ? POSTUP_WRITE : POSTUP);
}
