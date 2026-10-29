#!/usr/bin/env node
// requires: tasker
// rozhodnutia_context.mjs: pri štarte relácie agent s identitou dostane len
// to, čo bez hooku nezistí: ktoré rozhodnutia sa zmenili, kým nebežal, a čo
// na operátora čaká v Taskeri (návrh úlohy 390, časť 4.1). SessionStart
// (štart, obnovenie, /clear, kompakcia).
// Text ostáva v kontexte celú reláciu, preto bez zmeny sú to dva riadky:
//   [rozhodnutia] 96 platných, pre teba 23 (zoznam: ..., záznam: ...). Od posledného štartu bez zmeny.
//   [otázky] ...
// Každý záznam zmenený od posledného štartu pridá jeden riadok. Index sa
// nevkladá, agent ho číta na požiadanie (`lib/rozhodnutia.mjs list`).
//
// Meno a roly z PERSONA.md koreňa projektu ako identity.mjs, bez
// persony hook mlčí. Stav posledného štartu je HEAD klonu v
// $AR_STATE/<agent> (predvolene ~/.local/state/agentic-workflow/rozhodnutia_seen),
// pri prvom štarte bez stavu len počty. Klon so záznamami je brainGlobalDir()
// z lib/paths.mjs, priečinok decisions/.
//
// "Pre teba": `agenti` obsahuje meno alebo `*`, alebo `rozsah` pretína
// značky rolí agenta (ROLE_ROZSAH) a stroja (server alebo mac).
// [otázky]: úlohy v needs_human, ktorých riešiteľ je agent alebo projekt sa
// volá ako agent (lib/tasker_read.mjs, len čítanie). Tasker neodpovedal =
// jedna veta, hook nepadne.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { brainGlobalDir, workflowDir } from "../lib/paths.mjs";
import { loadAll, indexLine, vPravidle } from "../lib/rozhodnutia.mjs";
import { fetchTasks } from "../lib/tasker_read.mjs";

// Značky rozsahu, ktoré patria do jurisdikcie roly (roles/ROLES.md).
export const ROLE_ROZSAH = {
  "spravca-agentov": ["pravidla", "schranky", "git", "t3", "tasker"],
  "spravca-servera": ["server", "t3", "tasker", "prehliadac", "git"],
  "zastupca-operatora": ["schvalene"],
  dizajner: ["dizajn"],
};

const zoznam = (v) => (v || "").split(",").map((s) => s.trim()).filter(Boolean);

export function preTeba(r, { name, roles = [], stroj }) {
  const agenti = zoznam(r.agenti);
  if (agenti.includes("*") || agenti.includes(name)) return true;
  const moje = new Set([stroj, ...roles, ...roles.flatMap((x) => ROLE_ROZSAH[x] || [])]);
  return zoznam(r.rozsah).some((z) => moje.has(z));
}

const git = (clone, args) => {
  const r = spawnSync("git", ["-C", clone, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr || "git zlyhal").trim());
  return r.stdout;
};

// Zmenené záznamy (id) medzi `seen` a HEAD, alebo null bez stavu či pri chybe.
function changedIds(clone, seen, head) {
  if (!seen || seen === head) return [];
  try {
    const out = git(clone, ["diff", "--name-only", `${seen}..${head}`, "--", "decisions/"]);
    return [...new Set(out.split("\n").map((f) => /^decisions\/(D\d{4})\.md$/.exec(f)?.[1]).filter(Boolean))];
  } catch { return []; }
}

// Vráti text pre kontext (riadky), stav zapíše vždy.
export async function build({ clone, stateDir, name, roles, stroj, workflow = workflowDir(), now = () => new Date(), tasks = fetchTasks }) {
  const dir = join(clone, "decisions");
  const records = loadAll(dir);
  const mine = records.filter((r) => preTeba(r, { name, roles, stroj }) && !vPravidle(r));
  const platne = records.filter((r) => r.stav === "platí").length;
  const pocet = mine.filter((r) => r.stav === "platí").length;
  let head = "";
  try { head = git(clone, ["rev-parse", "HEAD"]).trim(); } catch {}
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const seenPath = join(stateDir, name);
  const seen = existsSync(seenPath) ? readFileSync(seenPath, "utf8").trim() : "";
  if (head) writeFileSync(seenPath, head + "\n");
  const ids = new Set(changedIds(clone, seen, head));
  const zmenene = mine.filter((r) => ids.has(r.id));
  const cmd = `zoznam: node ${workflow}/lib/rozhodnutia.mjs list --agent ${name}, záznam: show <id>`;
  const base = `[rozhodnutia] ${platne} platných, pre teba ${pocet} (${cmd}).`;
  const lines = [];
  if (!seen) lines.push(`${base} Prvý štart, zmeny sa nehlásia.`);
  else if (!zmenene.length) lines.push(`${base} Od posledného štartu bez zmeny.`);
  else {
    lines.push(`${base} Od posledného štartu zmenené ${zmenene.length}:`);
    for (const r of zmenene) lines.push(r.stav === "platí" ? indexLine(r) : `${indexLine(r)} [${r.stav}]`);
  }
  lines.push(await otazky({ name, tasks }));
  return lines.join("\n");
}

async function otazky({ name, tasks }) {
  let rows;
  try { rows = await tasks({ status: "needs_human" }); } catch { return "[otázky] Tasker neodpovedal, otázky na operátora neviem."; }
  const moje = rows.filter((t) => t.assignee === name || t.project === name);
  if (!moje.length) return "[otázky] Úlohy v needs_human s tvojím menom alebo projektom: žiadna.";
  return `[otázky] Úlohy v needs_human s tvojím menom alebo projektom: ${moje.map((t) => `úloha ${t.id} (${t.title})`).join("; ")}.`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  let persona = "";
  try { persona = readFileSync(join(root, "PERSONA.md"), "utf8"); } catch { process.exit(0); }
  const heading = persona.match(/^# (.+)$/m)?.[1].trim();
  if (!heading) process.exit(0);
  const roles = (persona.match(/^Role:[ \t]*(.+)$/m)?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  const mac = process.platform === "darwin";
  const home = process.env.HOME || homedir();
  const clone = brainGlobalDir();
  const stateDir = process.env.AR_STATE || join(home, ".local/state/agentic-workflow/rozhodnutia_seen");
  try {
    const text = await build({ clone, stateDir, name: heading.toLowerCase(), roles, stroj: mac ? "mac" : "server" });
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text } }));
  } catch { process.exit(0); }
}
