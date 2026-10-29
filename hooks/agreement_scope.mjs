#!/usr/bin/env node
// agreement_scope.mjs — správa operátora, ktorá vyjadruje súhlas a zároveň
// menuje body alebo ich počet ("suhlasim v troch bodoch"), dostane do kontextu
// pripomienku: menované body platia v znení návrhu, aj bod, ktorý agent
// odporučil nerobiť. Holé "súhlasím" prijíma odporúčanie (global §1).
// UserPromptSubmit. Inak nič a kód 0. Úloha Taskera 604 (25. 10. 2026:
// "súhlasím v troch bodoch" sa zapísalo ako zamietnutie bodu 3).
//
// Text sa porovná bez diakritiky a bez ohľadu na veľkosť písmen.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function normalize(text) {
  return String(text).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Súhlas: súhlas/suhlas v každom tvare, ok, agree, yes a "áno" len na začiatku.
const AGREE = /\b(?:suhlas\w*|ok|agree\w*|yes)\b/;
const AGREE_START = /^[\s\p{P}]*ano\b/u;

// Body: bod/point v každom tvare, číslica, číslovka v každom tvare, všetko.
const POINTS = new RegExp(
  "\\b(?:bod\\w*|point\\w*|\\d+" +
    "|jed(?:en|na|no|neho|nej|nom|nou|nemu)" +
    "|dv(?:a|e|och|om|oma)|obaja|oba|obe|oboch|oboma|obidv\\w*" +
    "|tri|troch|trom|troma|styri|styroch|styrom|styrmi" +
    "|pat|piatich|piatim|sest|sestich|sedem|osem|devat|desat" +
    "|vsetk\\w+|vsetko)\\b",
);

export function agrees(text) {
  const t = normalize(text);
  return AGREE.test(t) || AGREE_START.test(t);
}

export function namesPoints(text) {
  return POINTS.test(normalize(text));
}

// Systémová správa (výsledok sub-agenta, notifikácia) a správa budiča zo
// schránky nie je správa operátora, hook ju preskočí.
export function isOperatorMessage(text) {
  const t = String(text).trimStart();
  if (t.startsWith("<system-reminder>") || t.startsWith("<task-notification>") || t.startsWith("<schranka ")) return false;
  return !/\[SYSTEM NOTIFICATION - NOT USER INPUT\]|<task-notification>/.test(t);
}

export function shouldRemind(text) {
  return isOperatorMessage(text) && agrees(text) && namesPoints(text);
}

// Súhlas s menovaným úkonom: súhlas na začiatku a hneď za ním sloveso v rozkazovacom
// tvare ("Ano, zaloz issue", "ok, posli to Ronovi"). Vráti citát úkonu alebo null.
// Zoznam slovies dopĺňaj tu; ostatné tvary chytí zakončenie -aj, -ej, -uj.
const IMPERATIVES = new Set(
  ("zaloz vytvor posli napis spusti vypni zapni nasad pridaj zmaz zrus uprav oprav urob rob zapis " +
    "commitni pushni mergni merguj otvor zatvor zavri nahraj stiahni nastav zmen presun odosli odpovedz " +
    "povedz daj dajte vezmi pozri skontroluj over spravodaj oznam zadaj prirad pridel prepis obnov restartuj " +
    "reštartuj").split(" ").map(normalize),
);
const IMPERATIVE_END = /^\p{L}{3,}(?:aj|ej|uj)$/u;
const LEAD = /^[\s\p{P}]*(\p{L}+)[\s\p{P}]+(\p{L}+)/u;

export function agreedAction(text) {
  const t = String(text);
  const m = LEAD.exec(t);
  if (!m) return null;
  const a = normalize(m[1]);
  if (!(a === "ano" || a === "ok" || a === "yes" || /^(?:suhlas|agree)\w*$/.test(a))) return null;
  const v = normalize(m[2]);
  if (!IMPERATIVES.has(v) && !IMPERATIVE_END.test(v)) return null;
  const start = m[0].length - m[2].length;
  // "Áno, rob" je holé "pokračuj", úkon musí mať predmet.
  if (t.slice(start).trim().split(/\s+/).length < 2) return null;
  const cite = t.slice(start).trim().replace(/\s+/g, " ");
  return cite.length > 200 ? `${cite.slice(0, 200)}…` : cite;
}

// Stav súhlasu s úkonom, mimo repa: AGREEMENT_SCOPE_STATE alebo ~/.claude/state/agreement_scope.
export function stateFile(sessionId) {
  const dir = process.env.AGREEMENT_SCOPE_STATE || join(homedir(), ".claude", "state", "agreement_scope");
  return join(dir, `${String(sessionId).replace(/[^\w.-]/g, "_")}.json`);
}
export function writeState(sessionId, cite) {
  const f = stateFile(sessionId);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, JSON.stringify({ cite, time: new Date().toISOString(), session_id: sessionId }));
}
export function readState(sessionId) {
  try {
    return JSON.parse(readFileSync(stateFile(sessionId), "utf8"));
  } catch {
    return null;
  }
}
export function clearState(sessionId) {
  rmSync(stateFile(sessionId), { force: true });
}

export const actionReminder = (cite) =>
  `Operátor súhlasil len s úkonom "${cite}". Ostatné úkony návrhu nerob a nepíš ich do správy inému agentovi bez novej otázky operátorovi. ` +
  "Holé \"súhlasím\" bez úkonu prijíma tvoje odporúčanie (global §1).";

export const REMINDER =
  "Operátor súhlasí s bodmi, ktoré menuje. Menované body platia v znení návrhu, aj bod, ktorý si odporučil nerobiť. " +
  "Holé \"súhlasím\" bez bodov prijíma tvoje odporúčanie (global §1). " +
  "Keď rozsah nesedí s tvojím odporúčaním, konaj podľa menovaných bodov a v odpovedi povedz jednou vetou, ako si súhlas pochopil.";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  if (typeof input.prompt === "string") {
    const sid = input.session_id;
    const operator = isOperatorMessage(input.prompt);
    const cite = operator && !namesPoints(input.prompt) ? agreedAction(input.prompt) : null;
    if (sid && operator) {
      if (cite) writeState(sid, cite);
      else clearState(sid);
    }
    const msg = cite ? actionReminder(cite) : shouldRemind(input.prompt) ? REMINDER : null;
    if (msg) {
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: msg } }),
      );
    }
  }
}
