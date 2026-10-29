#!/usr/bin/env node
// rozhodnutia_guard.mjs: rozhodnutie sa zapisuje len cez bin/rozhodni.sh
// (návrh úlohy 390, kontrola K2). PreToolUse pre Write, Edit, MultiEdit,
// NotebookEdit a Bash (zapojuje ho env/server/install.sh a env/mac/settings.json).
// Zamietne zápis do záznamov a indexu v decisions/ (D0001.md, INDEX.md)
// inak než skriptom. DECISIONS.md a SCHVALENE.md chráni len zmrazený log:
// súbor, ktorý má v prvých 10 riadkoch značku `<!-- rozhodnutia: zmrazene -->`. Značku mu pri
// migrácii (U7 až U9) vloží commit s archívom, odvtedy ho nikto neprepíše,
// ani značku nezmaže. Pred zmrazením log ostáva voľný, agenti doň zapisujú ďalej. README.md a ROZSAHY.md v decisions/ sa upravujú
// ručne, nová značka rozsahu patrí do commitu s prvým záznamom, ktorý ju
// používa. V Bash zachytí presmerovanie (`>`, `>>`), `tee`, `cp`/`mv`/`install`
// s cieľom v chránenom súbore a `sed -i`. Príkaz s bin/rozhodni.sh prejde,
// skript píše sám. Parser ako foreign_git.mjs: heredoc a text v úvodzovkách
// s medzerou sú dáta, nie cieľ zápisu.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stripHeredocs } from "./no_model_wait.mjs";
import { denyTool } from "../lib/deny.mjs";
import { stripProse } from "./foreign_git.mjs";
import { workflowDir } from "../lib/paths.mjs";

const RECORDS = /(?:^|\/)decisions\/(?:D\d{4}|INDEX)\.md$/;
const LOG = /(?:^|\/)(?:DECISIONS|SCHVALENE)\.md$/;
export const ZMRAZENE = "<!-- rozhodnutia: zmrazene -->";

// Log je zmrazený, keď súbor na disku nesie značku v prvých 10 riadkoch.
// Nečitateľný alebo neexistujúci súbor zmrazený nie je. Relatívnu cestu
// rozloží proti cwd volania.
export function isFrozen(p, cwd = process.cwd()) {
  try { return readFileSync(resolve(cwd, p), "utf8").split("\n", 10).some((l) => l.trim() === ZMRAZENE); } catch { return false; }
}
export const isProtected = (raw, cwd) => {
  const p = raw.replace(/^['"]+|['"]+$/g, "");
  return RECORDS.test(p) || (LOG.test(p) && isFrozen(p, cwd));
};

export const POSTUP =
  `\`${join(workflowDir(), "bin", "rozhodni.sh")} --nazov ... --kluc ...\`, text rozhodnutia na stdin; zrušenie ` +
  `\`${join(workflowDir(), "bin", "rozhodni.sh")} --zrus D0007 --dovod "..."\` (docs/decisions-schema.md).`;

export const MESSAGE =
  "Rozhodnutia sa zapisujú len skriptom bin/rozhodni.sh (číslo, index, commit, push), "
  + "zmrazený DECISIONS.md a SCHVALENE.md sú archív a záznamy decisions/ nikto neprepisuje ručne. "
  + "Zápis: bin/rozhodni.sh --nazov ... --kluc ... (text na stdin), zrušenie --zrus D0007 --dovod \"...\".";

// Vráti zapisovaný chránený cieľ príkazu Bash alebo null.
export function bashTarget(raw, cwd) {
  const isP = (p) => isProtected(p, cwd);
  const flat = stripProse(stripHeredocs(raw));
  for (const seg of flat.split(/[;&|\n]+/)) {
    if (/rozhodni\.sh/.test(seg)) continue;
    // Presmerovanie: `>`, `>>`, `2>`, `&>` (bez `>&`, `2>&1`).
    for (const m of seg.matchAll(/(?<![<>])\d*>>?(?!&)\s*(['"]?)([^\s'"<>]+)\1/g)) if (isP(m[2])) return m[2];
    const tokens = seg.trim().split(/\s+/).filter(Boolean);
    const at = tokens.findIndex((t) => /^(?:\S*\/)?(sed|tee|cp|mv|install)$/.test(t));
    if (at < 0) continue;
    const cmd = tokens[at].replace(/^.*\//, "");
    const rest = tokens.slice(at + 1);
    const paths = rest.filter((t) => !t.startsWith("-") && !t.startsWith(">"));
    if (cmd === "sed" && !rest.some((t) => /^-[a-zA-Z]*i|^--in-place/.test(t))) continue;
    if (cmd === "tee" || cmd === "sed") { const hit = paths.find(isP); if (hit) return hit; }
    else { const last = paths[paths.length - 1]; if (last && isP(last)) return last; }
  }
  return null;
}

// Vráti dôvod zamietnutia alebo null.
export function reason(input) {
  const ti = input.tool_input || {};
  if (input.tool_name === "Bash") {
    const t = bashTarget(String(ti.command || ""), input.cwd);
    return t ? `zápis do ${t} príkazom Bash` : null;
  }
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(input.tool_name)) {
    const p = String(ti.file_path || ti.notebook_path || "");
    return p && isProtected(p, input.cwd) ? `zápis do ${p}` : null;
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  const why = reason(input);
  if (why) denyTool(`${MESSAGE} (${why})`, POSTUP);
}
