#!/usr/bin/env node
// deploy_readonly.mjs — /opt/tasker a nasadené klony kódu a spoločného mozgu
// (workflowDir, brainGlobalDir) nikto nemení ani necommituje.
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

import { readFileSync, realpathSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { stripHeredocs } from "./no_model_wait.mjs";
import { cmdStart, gitTarget, stripData } from "./foreign_git.mjs";
import { denyTool } from "../lib/deny.mjs";
import { brainGlobalDir, workflowDir } from "../lib/paths.mjs";

export const PROTECTED = ["/opt/tasker", workflowDir(), brainGlobalDir()];

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

// Chránený koreň, do ktorého cesta zapisuje, alebo null.
export function protectedRoot(path, cwd = null) {
  if (!path || typeof path !== "string") return null;
  const abs = path.startsWith("/") ? resolve(path) : cwd && cwd.startsWith("/") ? resolve(cwd, path) : null;
  if (!abs) return null;
  return inside(abs) ?? inside(real(abs));
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

export const MESSAGE =
  "/opt/tasker je nasadenie správcu servera a nasadené klony kódu a spoločného mozgu sú kópia na čítanie, ktorú obnovuje časovač: v nich nikto nič nemení ani necommituje (D0052). " +
  "Zmena tam sa pri ďalšom nasadení stratí alebo zablokuje fetch.";

export const POSTUP =
  "kód Taskera mení jeho vývojár v klone /root/tasker, pravidlá a kód správca agentov vo vlastnom klone a pushne; " +
  "nasadenie robí správca servera (`git -C /opt/tasker fetch` a `checkout`, nasadené klony obnoví časovač).";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  const ti = input.tool_input || {};
  const cwd = typeof input.cwd === "string" ? input.cwd : null;
  let why = null;
  if (input.tool_name === "Bash") {
    const root = commitRoot(String(ti.command || ""), cwd);
    if (root) why = `git commit v ${root}`;
  } else if (/^(?:Edit|Write|MultiEdit|NotebookEdit)$/.test(input.tool_name || "")) {
    const p = ti.file_path ?? ti.notebook_path ?? ti.path;
    const root = protectedRoot(p, cwd);
    if (root) why = `zápis ${p} v ${root}`;
  }
  if (why) denyTool(`${MESSAGE} (${why})`, POSTUP);
}
