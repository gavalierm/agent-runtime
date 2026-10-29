#!/usr/bin/env node
// kontext.mjs — odovzdávka pri čistom kontexte vlákna T3 (úloha 420 v Taskeri,
// návrh úlohy 420). Obal je bin/kontext.sh.
//
//   kontext.sh spanok|pokracuj [--dalej "<ďalší krok>"] [--stav "<súhrn stavu>"]
//
// Zapíše $KONTEXT_DIR/<id relácie>.json (predvolene ~/.local/state/kontext,
// práva 600) a vypíše riadok `HOTOVO-KONTEXT <režim> <kľúč>`, ktorý agent
// dá ako posledný riadok odpovede. Budič (kontext.mjs v koreni
// repa) po ňom pošle /clear, pri pokracuj s platným kľúčom aj jednu správu
// s ďalším krokom. Hook clear_bridge.mjs odovzdávku vloží do novej relácie.
// ID relácie je stále ID vlákna T3 z originalId() (lib/session_id.mjs),
// mimo T3 skript skončí chybou. Odmietne (kód 1, nič nezapíše), keď má agent
// úlohu v stave waiting a sám na nej komentoval po vstupe do waiting: výsledok
// prišiel a stav ostal starý (úloha 399, 23. 10. 2026). Tasker bez odpovede
// neblokuje, len varuje.
// Pred zápisom odovzdávky ukončí prácu ohlásenú touto reláciou (úloha 542):
// po /clear má proces claude nové ID relácie a hook tasker_work.mjs by novej
// relácii hlásil, že úlohu drží stará (udalosť work s thread == stará relácia).
// Relácia je CLAUDE_CODE_SESSION_ID. Úlohu z `task list --status in_progress`
// a z čísel v stave hooku tasker_work (tasker_work_current/<relácia> a
// tasker_work/<relácia>/) s živým záznamom work tejto relácie ukončí
// `tasker work N --stop`. Úloha, ktorú drží bežiaci sub-agent (súbor
// v tasker_work/<relácia>/), sa neukončí, len sa varuje. Potom zmaže
// tasker_work_current/<relácia>. Chyba Taskera je varovanie, neblokuje.
// Kódy: 0 hotovo, 1 chyba, 2 zlé použitie.

import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { agentName } from "./agent_name.mjs";
import { originalId } from "./session_id.mjs";

const TK = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "tk");

export const DONE_WORD = "HOTOVO-KONTEXT";

export function kontextDir(env = process.env) {
  return env.KONTEXT_DIR || join(env.HOME || homedir(), ".local/state/kontext");
}

// Zapíše odovzdávku a vráti { path, key, line }.
export function writeHandoff({ dir, id, rezim, dalej = null, stav = null, cwd = process.cwd(), now = new Date() }) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = randomBytes(8).toString("hex");
  const path = join(dir, `${id}.json`);
  const tmp = join(dir, `.${id}.tmp`);
  writeFileSync(tmp, JSON.stringify({ key, rezim, dalej, stav, cwd, at: now.toISOString() }, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
  return { path, key, line: `${DONE_WORD} ${rezim} ${key}` };
}

// Prečíta odovzdávku relácie a zmaže ju, aby sa nevložila druhý raz.
// Vráti objekt alebo null.
export function takeHandoff(dir, id) {
  if (!id) return null;
  const path = join(dir, `${id}.json`);
  let data = null;
  try { data = JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
  try { rmSync(path, { force: true }); } catch {}
  return data && typeof data === "object" ? data : null;
}

export function parseArgs(argv) {
  const [rezim, ...rest] = argv;
  if (rezim !== "spanok" && rezim !== "pokracuj") return { error: "prvý argument je spanok alebo pokracuj" };
  const out = { rezim, dalej: null, stav: null };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const val = rest[i + 1];
    if ((flag !== "--dalej" && flag !== "--stav") || val === undefined || !val.trim()) return { error: `${flag}: chýba hodnota alebo neznámy prepínač` };
    out[flag.slice(2)] = val.trim();
  }
  if (rezim === "pokracuj" && !out.dalej) return { error: "pokracuj potrebuje --dalej \"<ďalší krok>\", inak použi spanok" };
  return out;
}

// Volanie Taskera, vráti rozparsované JSON (prázdny výstup null, iný text ako text).
// Pod rootom cez obal bin/tk.
export function runTasker(agent, args) {
  const cmd = process.getuid?.() === 0 ? [TK, args] : ["tasker", args];
  const r = spawnSync(cmd[0], cmd[1], { encoding: "utf8", timeout: 20000, env: { ...process.env, AGENT_NAME: agent } });
  if (r.status !== 0) throw new Error((r.stderr || r.error?.message || `kód ${r.status}`).trim());
  if (!r.stdout.trim()) return null;
  try { return JSON.parse(r.stdout); } catch { return r.stdout; }
}

// Úlohy agenta v stave waiting, na ktorých sám komentoval po vstupe do waiting
// (stav waiting alebo udalosť wait, ktorú zapíše tasker wait na čakajúcej úlohe).
// tasker(args) vracia JSON (vo vlastnom tasker sa dá nahradiť testom).
export function staleWaiting(agent, tasker) {
  const out = [];
  for (const t of tasker(["task", "list", "--status", "waiting", "--assignee", agent, "--json"])) {
    const d = tasker(["task", "show", String(t.id), "--json"]);
    if (d.status !== "waiting") continue;
    const ev = d.events || [];
    const since = Math.max(0, ...ev.filter((e) => e.kind === "wait" || (e.kind === "status" && e.to_status === "waiting")).map((e) => e.at));
    const mine = ev.filter((e) => e.kind === "comment" && e.actor === `human:${agent}` && e.at > since).map((e) => e.at);
    if (mine.length) out.push({ id: d.id, reason: d.wait_reason || "bez dôvodu", commentAt: Math.max(...mine) });
  }
  return out;
}

// Živá práca tejto relácie na úlohe z udalostí Taskera (rovnaká logika ako
// foreignHolder v hooks/tasker_work.mjs, ale hľadá vlastnú
// reláciu): start/extend s until v budúcnosti a thread == relácia, bez
// neskoršieho work_stop toho aktéra a bez neskoršieho done, cancelled,
// needs_human alebo waiting.
export function ownWork(events, session, nowMs = Date.now()) {
  const held = new Map();
  const ordered = [...(events || [])].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  for (const e of ordered) {
    if (e.kind === "work") {
      const m = String(e.detail || "").match(/^(start|extend) until (\S+)(?: thread (\S+))?/);
      const until = m ? Date.parse(m[2]) : NaN;
      if (!m || !Number.isFinite(until)) continue;
      const prev = held.get(e.actor);
      held.set(e.actor, { thread: m[3] || (m[1] === "extend" ? prev?.thread : null) || null, until });
    } else if (e.kind === "work_stop") held.delete(e.actor);
    else if (["done", "cancelled", "needs_human", "waiting"].includes(e.to_status)) held.clear();
  }
  for (const h of held.values()) if (h.thread === String(session) && h.until > nowMs) return true;
  return false;
}

const safeId = (s) => String(s || "").replace(/[^\w-]/g, "_");
const cacheBase = (env) => join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache"), "agentic-workflow");
const currentFile = (env, session) => join(cacheBase(env), "tasker_work_current", safeId(session));

// Ukončí prácu relácie na úlohách (úloha 542). Vráti { stopped: [N], busy: [N] },
// busy sú úlohy bežiaceho sub-agenta. Chyba Taskera na jednej úlohe nepreruší
// ostatné, ide do warn.
export function releaseWork({ agent, session, env, tasker, warn }) {
  const cands = new Set();
  const subagent = new Set();
  const readNums = (file) => readFileSync(file, "utf8").split("\n").map(Number).filter((n) => Number.isFinite(n) && n > 0);
  try {
    for (const t of tasker(["task", "list", "--assignee", agent, "--status", "in_progress", "--json"]) || []) cands.add(Number(t.id));
  } catch (e) { warn(`nepoznám úlohy v práci (${e.message.split("\n")[0]})`); }
  try {
    const n = Number(JSON.parse(readFileSync(currentFile(env, session), "utf8"))?.n);
    if (Number.isFinite(n) && n > 0) cands.add(n);
  } catch {}
  try {
    const dir = join(cacheBase(env), "tasker_work", safeId(session));
    for (const f of readdirSync(dir).filter((x) => !x.endsWith(".tmp"))) for (const n of readNums(join(dir, f))) { cands.add(n); subagent.add(n); }
  } catch {}
  const stopped = [], busy = [];
  for (const n of [...cands].filter(Number.isFinite).sort((a, b) => a - b)) {
    try {
      const d = tasker(["task", "show", String(n), "--json"]);
      if (!ownWork(d?.events, session)) continue;
      if (subagent.has(n)) { busy.push(n); warn(`úloha ${n} má bežiaceho sub-agenta tejto relácie, prácu neukončujem`); continue; }
      tasker(["work", String(n), "--stop", "--json"]);
      stopped.push(n);
    } catch (e) { warn(`úlohu ${n} som neuvoľnil (${e.message.split("\n")[0]})`); }
  }
  try { rmSync(currentFile(env, session), { force: true }); } catch {}
  return { stopped, busy };
}

// Vráti kód skončenia. pid je začiatok hľadania ID relácie (testy).
export function main(argv, { env = process.env, pid = process.ppid, out = process.stdout, err = process.stderr, tasker = null } = {}) {
  const a = parseArgs(argv);
  if (a.error) {
    err.write(`kontext.sh: ${a.error}\nSprávny postup: kontext.sh spanok|pokracuj [--dalej "<ďalší krok>"] [--stav "<súhrn stavu>"]\n`);
    return 2;
  }
  const agent = agentName({}, env);
  if (!agent) {
    err.write("kontext.sh: varovanie, nepoznám meno agenta, úlohy v Taskeri nekontrolujem.\n");
  } else {
    try {
      const stale = staleWaiting(agent, tasker || ((args) => runTasker(agent, args)));
      if (stale.length) {
        for (const t of stale) err.write(`kontext.sh: úloha ${t.id} čaká (${t.reason}), ale tvoj komentár z ${new Date(t.commentAt).toISOString()} je novší.\n`);
        err.write("Správny postup: zmeň stav úlohy (tasker done, resume, alebo wait s novým --reason) a potom spusti kontext.sh znova.\n");
        return 1;
      }
    } catch (e) {
      err.write(`kontext.sh: varovanie, Tasker neodpovedal (${e.message.split("\n")[0]}), úlohy nekontrolujem.\n`);
    }
  }
  const id = originalId(pid);
  if (!id) {
    err.write("kontext.sh: nenašiel som ID relácie vlákna T3 (proces claude s --resume alebo --session-id), mimo T3 čistý kontext nespúšťam.\n");
    return 1;
  }
  const session = env.CLAUDE_CODE_SESSION_ID;
  if (!session) err.write("kontext.sh: varovanie, chýba CLAUDE_CODE_SESSION_ID, ohlásenú prácu v Taskeri (work) neukončujem.\n");
  else if (agent) {
    try {
      releaseWork({ agent, session, env, tasker: tasker || ((args) => runTasker(agent, args)), warn: (m) => err.write(`kontext.sh: varovanie, ${m}.\n`) });
    } catch (e) {
      err.write(`kontext.sh: varovanie, ukončenie práce v Taskeri zlyhalo (${e.message.split("\n")[0]}).\n`);
    }
  }
  try {
    out.write(writeHandoff({ dir: kontextDir(env), id, ...a }).line + "\n");
  } catch (e) {
    err.write(`kontext.sh: zápis odovzdávky zlyhal: ${e.message}\n`);
    return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv.slice(2));
