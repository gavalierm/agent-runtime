#!/usr/bin/env node
// Ranný súhrn: zapíše do schránky agenta správu ranny-<čas>.md so súhrnom
// Taskera za 24 h (`tasker summary`), prvý riadok `odpoveď: nečakám`
// (budí a vynesie držané správy na vedomie). Každú držanú správu na vedomie
// presunie do processed a vypíše v súhrne (sweepHeld). Agent z neho napíše operátorovi súhrn
// do svojho vlákna. Spúšťa ho agent-morning.timer (náhrada mimo T3) alebo plánovač T3.
// `--stdout` (úloha 618, D0183): ten istý beh, ale telo súhrnu ide na stdout bez hlavičky
// správy a do schránky sa nezapíše nič. V schránkach sa tým zmení jediné: presun držaných
// správ na vedomie do processed (sweepHeld), rovnako ako pri zápise do schránky.
// Keď `tasker summary` zlyhá, správa nesie chybu, súhrn neodpadne potichu.
// Časti súhrnu: držané správy, nové rozhodnutia, rozloženie práce (workSection)
// a zásahy operátora za 24 h (operatorSection, úloha 605): udalosti operátora
// a posuny poradia v Taskeri, komentáre agenta za operátora (telo začína
// AGENT_OPERATOR_NAME) a správy operátora z webu v T3 (cfg.t3Db). Obe DB len na čítanie.
// runningSection (úloha 662): zoznam úloh in_progress s časom vstupu a otvorenou prácou, lebo `tasker summary`
// dáva len počet.
// Hotové dáta pre report bez ručného dopytovania (úloha 607, D0179): stalledSection
// (úlohy, ktoré v okne 24 h stáli viac ako 1 h v stave bez práce, s príčinou, a otvorené
// needs_human s vekom), interruptedSection (behy killed a cancelled s udalosťami úlohy
// počas behu), reposSection (klony cfg.workRepos s neprázdnym git status --short)
// a repliesSection (správy iných agentov v processed za 24 h). Prvý riadok pokynu
// v build(): report len z týchto dát, nástroj len na akciu, chýbajúci údaj je úloha na tento skript.
// Značka účasti operátora (úloha 653): každý riadok hotovej úlohy v `tasker summary` dostane
// `[s <operátorom>]`, keď operátor v okne 24 h písal do vlákna T3, ktorého názov nesie číslo
// úlohy (`úloha N`, `#N`, `uN`), alebo do úlohy komentár (autor z TASKER_OPERATORS, alebo telo
// začína AGENT_OPERATOR_NAME). Agent takú úlohu v súhrne len spočíta, opis dostane len práca bez
// účasti operátora. Tvar značky dá AGENT_OPERATOR_WITH, inak AGENT_OPERATOR_NAME + "om".
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { NAME_RE, config, inboxEntries, log, parseHeader, parseName, writeInbox } from "./lib.mjs";
import { operatorActors } from "./tasker_events.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// Držané správy na vedomie bez ohľadu na vek: presunie ich zo schránky
// agenta do processed a vráti zoznam pre súhrn. Schránky berie z
// cfg.sweepBoxes, bez nich (cfg bez poľa) nerobí nič. Budiace správy
// nechá. Budič pošle držanú správu sám až po lehote 24 h, keď ranný
// súhrn neprebehol (driver.mjs, úloha 518, D0176).
export function sweepHeld(cfg, now = Date.now()) {
  const out = [];
  for (const box of cfg.sweepBoxes ?? []) {
    let entries;
    try { entries = inboxEntries(box); } catch { continue; }
    for (const { name } of entries) {
      const path = join(box, "inbox", name);
      let text;
      try { text = readFileSync(path, "utf8"); } catch { continue; }
      const h = parseHeader(text);
      if (h.mode !== "na vedomie") continue;
      const parsed = parseName(name);
      const dest = join(box, "processed", name);
      const to = existsSync(dest) ? `${dest}.${now}` : dest;
      try { renameSync(path, to); } catch { continue; }
      const first = h.body.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
      out.push({ agent: basename(box), sender: h.meta?.od || parsed.sender, topic: h.meta?.tema || parsed.topic || "bez témy", first: first.slice(0, 200), path: to });
    }
  }
  return out;
}

export function heldSection(items) {
  if (!items.length) return [];
  const lines = ["", `Držané správy na vedomie, presunuté do processed (${items.length}):`, ""];
  for (const i of items) lines.push(`- ${i.agent}, od ${i.sender}, téma ${i.topic}: ${i.first} (${i.path})`);
  return lines;
}

// Nové rozhodnutia za 24 h z git logu spoločného mozgu (nové súbory decisions/D*.md)
// a výstup `rozhodnutia.mjs check` (problémy a upozornenia na rovnaký názov
// pri rôznych kľúčoch). Úloha 470, replay S9. Bez cfg.brainGlobal nerobí nič.
// `git` a `check` sú vstrekované kvôli testu, nič sa nezapisuje.
export function decisionsSection(cfg, git = (a) => execFileSync("git", a, { encoding: "utf8", timeout: 30_000 }),
  check = (lib, dir) => spawnSync("node", [lib, "check", "--dir", dir], { encoding: "utf8", timeout: 30_000 }).stdout ?? "") {
  const repo = cfg.brainGlobal;
  if (!repo) return [];
  let files;
  try {
    files = git(["-C", repo, "log", "--since=24 hours ago", "--diff-filter=A", "--name-only", "--format=", "--", "decisions/"])
      .split("\n").map((l) => /^decisions\/(D\d{4})\.md$/.exec(l.trim())?.[1]).filter(Boolean);
  } catch (e) {
    return ["", `Rozhodnutia: git log zlyhal: ${(e.stderr || e.message || "").toString().trim().slice(0, 300)}`];
  }
  files = [...new Set(files)].sort();
  const field = (text, k) => new RegExp(`^${k}:[ \\t]*(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
  const lines = ["", `Nové rozhodnutia za 24 h (${files.length}):`, ""];
  for (const id of files) {
    let t = "";
    try { t = readFileSync(join(repo, "decisions", `${id}.md`), "utf8"); } catch { /* záznam zmizol */ }
    lines.push(`- ${id}, zapísal ${field(t, "zapisal") || "?"}, rozhodol ${field(t, "rozhodol") || "?"}, moc ${field(t, "moc") || "?"}, kľúč ${field(t, "kluc") || "?"}: ${field(t, "nazov")}`);
  }
  if (!files.length) lines.push("- žiadne");
  const found = check(join(HERE, "lib", "rozhodnutia.mjs"), join(repo, "decisions")).split("\n").map((l) => l.trim()).filter(Boolean);
  lines.push("", found.length ? `Kontrola rozhodnutí (vráť commitom, autorovi pošli číslo):` : "Kontrola rozhodnutí: v poriadku.");
  for (const l of found) lines.push(`- ${l}`);
  return lines;
}

// Rozloženie práce za 24 h (úloha 513): z tabuľky `work` Taskera počet úloh a relácií
// po agentovi a projekte, z gitu commity po autorovi v cfg.workRepos. DB sa otvára len na
// čítanie, `git` je vstrekovaný kvôli testu, nič sa nezapisuje. Chyba vráti riadok, nie výnimku.
export function workSection(cfg, now = Date.now(), deps = {}) {
  const git = deps.git || ((a) => execFileSync("git", a, { encoding: "utf8", timeout: 30_000 }));
  const lines = ["", "Rozloženie práce za 24 h:", ""];
  try {
    const db = new DatabaseSync(cfg.taskerDb, { readOnly: true });
    let rows;
    try {
      rows = db.prepare(
        `SELECT w.agent AS agent, COALESCE(NULLIF(t.project, ''), 'bez projektu') AS project,
                w.task_id AS task_id, w.thread AS thread
           FROM work w LEFT JOIN tasks t ON t.id = w.task_id
          WHERE w.since >= ? ORDER BY w.agent, project, w.task_id`).all(now - 24 * 3600_000);
    } finally { db.close(); }
    const groups = new Map();
    for (const r of rows) {
      const k = `${r.agent}\u0000${r.project}`;
      const g = groups.get(k) || { agent: r.agent, project: r.project, tasks: new Set(), threads: new Set() };
      g.tasks.add(r.task_id);
      if (r.thread) g.threads.add(r.thread);
      groups.set(k, g);
    }
    lines.push("Úlohy a relácie podľa agenta a projektu:");
    if (!groups.size) lines.push("- žiadna práca");
    for (const g of groups.values()) {
      const ids = [...g.tasks].sort((a, b) => a - b);
      const more = ids.length > 10 ? ", ďalšie" : "";
      lines.push(`- ${g.agent}, ${g.project}: ${g.tasks.size} úloh, ${g.threads.size} relácií (${ids.slice(0, 10).join(", ")}${more})`);
    }
  } catch (e) {
    lines.push(`Úlohy a relácie: čítanie databázy Taskera zlyhalo: ${(e.message || "").toString().trim().slice(0, 300)}`);
  }
  const authors = new Map();
  for (const repo of cfg.workRepos || []) {
    if (!existsSync(repo)) continue;
    try {
      for (const a of git(["-C", repo, "log", "--since=24 hours ago", "--format=%an"]).split("\n").map((l) => l.trim()).filter(Boolean)) {
        const m = authors.get(a) || new Map();
        m.set(basename(repo), (m.get(basename(repo)) || 0) + 1);
        authors.set(a, m);
      }
    } catch (e) {
      lines.push(`Commity: git log v ${repo} zlyhal: ${(e.stderr || e.message || "").toString().trim().slice(0, 200)}`);
    }
  }
  lines.push("", "Commity za 24 h podľa autora:");
  if (!authors.size) lines.push("- žiadne");
  for (const a of [...authors.keys()].sort()) {
    const m = authors.get(a);
    const total = [...m.values()].reduce((x, y) => x + y, 0);
    lines.push(`- ${a}: ${total} (${[...m].sort().map(([r, n]) => `${r} ${n}`).join(", ")})`);
  }
  lines.push("", "Porovnaj s rolami v roles/agents.md, prácu mimo roly agenta hlás operátorovi a presuň.");
  return lines;
}

const OPERATOR_NOISE = [/^\[harness/, /^Na vedomie, /, /^Schránka: /, /^<schranka/, /^Sprava z minuleho kontextu/, /^Spusti skill/];

// Správa operátora z webu T3: nie správa budiča, nie /clear, nie notifikácia ani text vložený hookom.
export function isOperatorMessage(payload) {
  if (payload?.role !== undefined && payload.role !== "user") return false;
  // Operátor píše z webu aj z mobilu (creationSource "mobile", 27. 10. 2026 súhrn vynechal 5 správ).
  if (payload?.createdBy !== "user" || !["web", "mobile"].includes(payload?.creationSource)) return false;
  if ("notification" in payload) return false;
  if (String(payload.id ?? "").includes("-inbox-")) return false;
  const text = String(payload.text ?? "").trim();
  if (text === "/clear") return false;
  return !OPERATOR_NOISE.some((re) => re.test(text));
}

const hhmm = (iso) => new Intl.DateTimeFormat("sk-SK", { timeZone: "Europe/Bratislava", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(iso));
const idList = (ids) => [...new Set(ids)].sort((a, b) => a - b).join(", ") || "-";

// Zásahy operátora za 24 h (úloha 605): z Taskera udalosti operátora (`operatorActors()`) podľa druhu
// s číslami úloh, posuny poradia (`edited` s detailom `priority`) od kohokoľvek a zvlášť od operátora,
// komentáre, ktoré agent zapísal za operátora (telo začína AGENT_OPERATOR_NAME, bez neho položka
// odpadne); z T3 (cfg.t3Db) správy operátora z webu. Obe DB sa otvárajú len na čítanie, chyba
// vráti riadok, nie výnimku.
export function operatorSection(cfg, now = Date.now(), deps = {}) {
  const env = deps.env || process.env;
  const lines = ["", "Zásahy operátora za 24 h:", ""];
  const since = now - 24 * 3600_000;
  try {
    const actors = operatorActors(env);
    const db = new DatabaseSync(cfg.taskerDb, { readOnly: true });
    let events, comments;
    try {
      events = db.prepare("SELECT task_id, actor, kind, detail FROM events WHERE at >= ? ORDER BY id").all(since);
      comments = db.prepare("SELECT task_id, body FROM comments WHERE created_at >= ? ORDER BY id").all(since);
    } finally { db.close(); }
    const byKind = new Map();
    for (const e of events) {
      if (!actors.has(e.actor)) continue;
      const g = byKind.get(e.kind) || [];
      g.push(e.task_id);
      byKind.set(e.kind, g);
    }
    lines.push("Tasker, udalosti operátora podľa druhu:");
    if (!byKind.size) lines.push("- žiadne");
    for (const k of [...byKind.keys()].sort()) lines.push(`- ${k}: ${byKind.get(k).length} (úlohy ${idList(byKind.get(k))})`);
    const moves = events.filter((e) => e.kind === "edited" && e.detail === "priority");
    const byOp = moves.filter((e) => actors.has(e.actor));
    lines.push(`Posuny poradia: ${moves.length} (úlohy ${idList(moves.map((e) => e.task_id))}), z toho operátor ${byOp.length}`);
    const name = String(env.AGENT_OPERATOR_NAME || "").trim();
    if (name) {
      const mine = comments.filter((c) => String(c.body).startsWith(name));
      lines.push(`Komentáre agenta za operátora (telo začína "${name}"): ${mine.length} (úlohy ${idList(mine.map((c) => c.task_id))})`);
    }
  } catch (e) {
    lines.push(`Tasker: čítanie databázy zlyhalo: ${(e.message || "").toString().trim().slice(0, 300)}`);
  }
  lines.push("");
  if (!cfg.t3Db || !existsSync(cfg.t3Db)) {
    lines.push("T3: databáza nie je");
  } else {
    try {
      const db = new DatabaseSync(cfg.t3Db, { readOnly: true });
      let rows;
      try {
        rows = db.prepare(
          `SELECT m.created_at AS created_at, m.payload_json AS payload, t.title AS title, m.thread_id AS thread_id
             FROM orchestration_v2_projection_messages m
             LEFT JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
            WHERE m.role = 'user' AND m.created_at >= ? ORDER BY m.created_at`).all(new Date(since).toISOString());
      } finally { db.close(); }
      const msgs = [];
      for (const r of rows) {
        let p;
        try { p = JSON.parse(r.payload); } catch { continue; }
        if (!isOperatorMessage({ ...p, role: "user" })) continue;
        msgs.push({ at: r.created_at, title: r.title || r.thread_id, text: String(p.text ?? "").trim().replace(/\s+/g, " ") });
      }
      lines.push(`T3, správy operátora z webu: ${msgs.length}`);
      const byTitle = new Map();
      for (const m of msgs) byTitle.set(m.title, (byTitle.get(m.title) || 0) + 1);
      for (const [t, n] of [...byTitle].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) lines.push(`- ${t}: ${n}`);
      if (msgs.length) lines.push("");
      for (const m of msgs.slice(0, 60)) lines.push(`- ${hhmm(m.at)} ${m.title.slice(0, 30)}: ${m.text.slice(0, 120)}`);
      if (msgs.length > 60) lines.push(`- ... ďalších ${msgs.length - 60}`);
    } catch (e) {
      lines.push(`T3: čítanie databázy zlyhalo: ${(e.message || "").toString().trim().slice(0, 300)}`);
    }
  }
  lines.push("", "Spočítaj nútené zásahy operátora (oprava, námietka, chyba, ktorú mal nájsť agent, posun stojacej úlohy) a v súhrne uveď ich počet, posuny poradia a príčinu každého druhu.");
  return lines;
}

// ---- Úloha 607: dáta pre report ----

const IDLE_STATES = new Set(["queued", "handoff", "needs_human", "blocked", "waiting", "todo", "scheduled"]);
const STALL_MS = 3600_000;
const cut = (t, n) => { const x = String(t ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? `${x.slice(0, n - 1)}…` : x; };
const fmtDur = (ms) => {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${String(m % 60).padStart(2, "0")} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
};
const fmtAt = (ms) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("sk-SK", { timeZone: "Europe/Bratislava", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.day}. ${p.month}. ${p.hour}:${p.minute}`;
};

// Príčina stojacej úlohy: blocked block_reason a blokéri (udalosti `blocker` +N/-N), waiting dôvod
// z udalosti `wait` (inak tasks.wait_reason), needs_human posledný komentár pred vstupom do stavu (otázka).
function stallCause(state, start, end, ev, comments, task) {
  const upTo = end ?? Infinity;
  if (state === "blocked") {
    const reasons = ev.filter((e) => e.kind === "block_reason" && e.at >= start - 5000 && e.at <= upTo);
    const set = new Set();
    for (const e of ev.filter((x) => x.kind === "blocker" && x.at <= upTo)) {
      const m = /^([+-])#?(\d+)$/.exec(String(e.detail ?? "").trim());
      if (m) m[1] === "+" ? set.add(m[2]) : set.delete(m[2]);
    }
    const parts = [];
    if (set.size) parts.push(`blokér ${[...set].join(", ")}`);
    if (reasons.length) parts.push(cut(reasons.at(-1).detail, 160));
    return parts.join(": ") || "bez dôvodu v Taskeri";
  }
  if (state === "waiting") {
    const w = ev.filter((e) => e.kind === "wait" && e.at >= start - 5000 && e.at <= upTo).at(-1);
    return cut(w?.detail || task.wait_reason, 160) || "bez dôvodu v Taskeri";
  }
  if (state === "needs_human") {
    const c = comments.filter((x) => x.created_at <= start + 5000).at(-1);
    return c ? `otázka (${c.author}): ${cut(c.body, 160)}` : "bez komentára";
  }
  return "";
}

// Beží (úloha 662): úlohy v stave in_progress s riešiteľom, projektom, časom vstupu do stavu (posledná
// udalosť created alebo status do in_progress, inak updated_at) a otvorenou prácou z tabuľky work (ended_at
// null, until v budúcnosti). `tasker summary` dáva len počet. DB len na čítanie, chyba vráti riadok.
export function runningSection(cfg, now = Date.now()) {
  try {
    const db = new DatabaseSync(cfg.taskerDb, { readOnly: true });
    let tasks, events, work;
    try {
      tasks = db.prepare("SELECT id, title, assignee, project, updated_at FROM tasks WHERE status = 'in_progress'").all();
      events = db.prepare("SELECT task_id, at, kind, to_status FROM events WHERE task_id IS NOT NULL AND (kind = 'created' OR kind = 'status') AND to_status = 'in_progress' ORDER BY id").all();
      work = db.prepare("SELECT task_id, agent, since FROM work WHERE ended_at IS NULL AND until > ?").all(now);
    } finally { db.close(); }
    const lastIn = new Map();
    for (const e of events) lastIn.set(e.task_id, e.at);
    const rows = tasks.map((t) => ({ t, start: lastIn.get(t.id) ?? t.updated_at })).sort((a, b) => a.start - b.start || a.t.id - b.t.id);
    const lines = ["", `Beží (úlohy in_progress: ${rows.length}), od vstupu do stavu:`, ""];
    if (!rows.length) lines.push("- žiadne");
    for (const { t, start } of rows) {
      const open = work.filter((w) => w.task_id === t.id).map((w) => `pracuje ${w.agent} od ${now - w.since > 24 * 3600_000 ? fmtAt(w.since) : hhmm(w.since)}`);
      lines.push(`- úloha ${t.id} ${t.assignee || "bez riešiteľa"}, ${t.project || "bez projektu"}, "${cut(t.title, 70)}": od ${fmtAt(start)} (${fmtDur(now - start)}), ${open.length ? open.join("; ") : "bez otvorenej práce"}`);
    }
    return lines;
  } catch (e) {
    return ["", "", `Beží: čítanie databázy Taskera zlyhalo: ${(e.message || "").toString().trim().slice(0, 300)}`];
  }
}

// Stojace úlohy za 24 h (úloha 607): prechody stavu (udalosti `created` a `status`) zložené do intervalov. Interval
// v stave bez práce (IDLE_STATES) dlhší než hodina v okne ide do zoznamu s trvaním v okne a celým trvaním od vstupu.
// Otvorené needs_human idú zvlášť s vekom od vstupu, hoci vstúpili pred oknom. Úlohy unassigned bez prechodu
// stavu v okne sa len spočítajú. DB len na čítanie, chyba vráti riadok, nie výnimku.
export function stalledSection(cfg, now = Date.now()) {
  const since = now - 24 * 3600_000;
  const lines = ["", "Úlohy, ktoré v okne 24 h stáli viac ako hodinu v stave bez práce:", ""];
  try {
    const db = new DatabaseSync(cfg.taskerDb, { readOnly: true });
    let tasks, events, comments;
    try {
      tasks = db.prepare("SELECT id, title, status, assignee, project, wait_reason FROM tasks").all();
      events = db.prepare("SELECT task_id, at, kind, from_status, to_status, detail FROM events WHERE task_id IS NOT NULL ORDER BY id").all();
      comments = db.prepare("SELECT task_id, author, body, created_at FROM comments ORDER BY id").all();
    } finally { db.close(); }
    const byTask = (rows) => { const m = new Map(); for (const r of rows) { const a = m.get(r.task_id) || []; a.push(r); m.set(r.task_id, a); } return m; };
    const evBy = byTask(events), cmBy = byTask(comments);
    const found = [], openHuman = [];
    let unassigned = 0;
    for (const t of tasks) {
      const ev = evBy.get(t.id) || [], cm = cmBy.get(t.id) || [];
      const trans = ev.filter((e) => (e.kind === "created" || e.kind === "status") && e.to_status);
      if (t.status === "unassigned" && !trans.some((e) => e.at >= since)) { unassigned++; continue; }
      for (let i = 0; i < trans.length; i++) {
        const state = trans[i].to_status;
        if (!IDLE_STATES.has(state)) continue;
        const start = trans[i].at, end = trans[i + 1]?.at ?? null;
        const open = end === null && t.status === state;
        if (end === null && !open) continue;
        const inWin = Math.min(end ?? now, now) - Math.max(start, since);
        const cause = stallCause(state, start, end, ev, cm, t);
        const row = { t, state, start, end, inWin, cause };
        if (open && state === "needs_human") openHuman.push(row);
        else if (inWin > STALL_MS) found.push(row);
      }
    }
    const head = (r) => `úloha ${r.t.id} ${r.state}, ${r.t.assignee || "bez riešiteľa"}, ${r.t.project || "bez projektu"}, "${cut(r.t.title, 70)}"`;
    found.sort((a, b) => a.start - b.start);
    if (!found.length) lines.push("- žiadne");
    for (const r of found.slice(0, 40)) {
      const full = (r.end ?? now) - r.start;
      lines.push(`- ${head(r)}: v okne ${fmtDur(r.inWin)}${full - r.inWin > 60_000 ? ` (od vstupu ${fmtDur(full)})` : ""}, ${fmtAt(r.start)} až ${r.end ? fmtAt(r.end) : "doteraz"}${r.cause ? `; ${r.cause}` : ""}`);
    }
    if (found.length > 40) lines.push(`- ... ďalších ${found.length - 40}`);
    lines.push("", `Otvorené needs_human (${openHuman.length}), vek od vstupu do stavu:`, "");
    if (!openHuman.length) lines.push("- žiadne");
    openHuman.sort((a, b) => a.start - b.start);
    for (const r of openHuman) lines.push(`- ${head(r)}: ${fmtDur(now - r.start)} (od ${fmtAt(r.start)}); ${r.cause}`);
    lines.push("", `Úlohy unassigned bez prechodu stavu v okne: ${unassigned} (nevypisujem, bez práce, nie stojace).`);
  } catch (e) {
    lines.push(`Stojace úlohy: čítanie databázy Taskera zlyhalo: ${(e.message || "").toString().trim().slice(0, 300)}`);
  }
  return lines;
}

const RUN_NOISE = new Set(["work", "work_stop", "delivered", "worktree", "run", "handoff_stale"]);
// Zásah riešiteľa tesne po konci prerušeného behu (komentár ho často prerušil) patrí k behu.
const AFTER_RUN_MS = 60_000;

// Prerušené behy za 24 h (úloha 607): behy killed a cancelled, ktoré skončili v okne, s udalosťami tej úlohy
// počas behu (komentár, zmena stavu, kto). DB len na čítanie, chyba vráti riadok.
export function interruptedSection(cfg, now = Date.now()) {
  const since = now - 24 * 3600_000;
  const lines = ["", "Prerušené behy za 24 h (killed, cancelled):", ""];
  try {
    const db = new DatabaseSync(cfg.taskerDb, { readOnly: true });
    let runs;
    const evOf = new Map();
    try {
      runs = db.prepare(
        `SELECT r.id AS id, r.task_id AS task_id, r.agent AS agent, r.status AS status, r.result_subtype AS sub,
                r.started_at AS started_at, r.ended_at AS ended_at, t.title AS title
           FROM runs r LEFT JOIN tasks t ON t.id = r.task_id
          WHERE r.status IN ('killed', 'cancelled') AND COALESCE(r.ended_at, r.started_at) >= ? ORDER BY r.id`).all(since);
      for (const r of runs) {
        const cm = db.prepare("SELECT created_at, body FROM comments WHERE task_id = ? AND created_at >= ? AND created_at <= ?").all(r.task_id, r.started_at, (r.ended_at ?? now) + AFTER_RUN_MS);
        evOf.set(r.id, db.prepare("SELECT at, actor, kind, from_status, to_status, detail FROM events WHERE task_id = ? AND at >= ? AND at <= ? ORDER BY id")
          .all(r.task_id, r.started_at, (r.ended_at ?? now) + AFTER_RUN_MS).filter((e) => !RUN_NOISE.has(e.kind))
          .map((e) => (e.kind === "comment" ? { ...e, detail: cm.find((c) => Math.abs(c.created_at - e.at) <= 50)?.body ?? e.detail } : e)));
      }
    } finally { db.close(); }
    if (!runs.length) lines.push("- žiadne");
    for (const r of runs) {
      lines.push(`- beh ${r.id}, úloha ${r.task_id} "${cut(r.title, 70)}", ${r.agent}, ${r.status}${r.sub ? `/${r.sub}` : ""}, ${fmtAt(r.started_at)} až ${r.ended_at ? fmtAt(r.ended_at) : "doteraz"} (${fmtDur((r.ended_at ?? now) - r.started_at)})`);
      const ev = evOf.get(r.id);
      if (!ev.length) lines.push("  počas behu bez udalostí úlohy");
      for (const e of ev.slice(0, 6)) {
        const late = r.ended_at && e.at > r.ended_at ? `po konci behu +${Math.round((e.at - r.ended_at) / 1000)} s` : "počas behu";
        lines.push(`  ${late} ${fmtAt(e.at)}: ${e.kind === "status" ? `stav ${e.from_status} → ${e.to_status}` : e.kind}, ${e.actor}${e.detail && e.kind !== "status" ? `, ${cut(e.detail, 80)}` : ""}`);
      }
      if (ev.length > 6) lines.push(`  ... ďalších ${ev.length - 6} udalostí`);
    }
  } catch (e) {
    lines.push(`Prerušené behy: čítanie databázy Taskera zlyhalo: ${(e.message || "").toString().trim().slice(0, 300)}`);
  }
  return lines;
}

// Klony z cfg.workRepos s neprázdnym `git status --short` (úloha 607): repo a počet riadkov.
// `git --no-optional-locks` nezapíše index. `git` je vstrekovaný kvôli testu.
export function reposSection(cfg, deps = {}) {
  const git = deps.git || ((a) => execFileSync("git", a, { encoding: "utf8", timeout: 30_000 }));
  const dirty = [], errors = [];
  let checked = 0;
  for (const repo of cfg.workRepos || []) {
    if (!existsSync(repo)) continue;
    checked++;
    try {
      const n = git(["--no-optional-locks", "-C", repo, "status", "--short"]).split("\n").filter((l) => l.trim()).length;
      if (n) dirty.push(`- ${basename(repo)}: riadkov ${n} (${repo})`);
    } catch (e) {
      errors.push(`- ${basename(repo)}: git status zlyhal: ${cut((e.stderr || e.message || "").toString(), 160)}`);
    }
  }
  return ["", `Klony s neprázdnym git status --short (${dirty.length} z ${checked}):`, "", ...(dirty.length ? dirty : ["- žiadne"]), ...errors];
}

const SKIP_SENDERS = new Set(["tasker", "ranny"]);

// Správy iných agentov v processed za 24 h (úloha 607): od, téma, prvý riadok Výsledok (inak prvý riadok tela)
// a riadok Otvorené. Čas je mtime súboru (presun ho nemení). Správy tasker a ranny sa nevypisujú.
export function repliesSection(cfg, now = Date.now()) {
  const since = now - 24 * 3600_000;
  const lines = ["", "Správy iných agentov v processed za 24 h:", ""];
  const dir = join(cfg.box || "", "processed");
  let names;
  try { names = readdirSync(dir); } catch (e) { return [...lines, `Processed: priečinok ${dir} sa nedá čítať: ${cut(e.message, 160)}`]; }
  const items = [];
  for (const name of names) {
    if (!name.endsWith(".md") || !NAME_RE.test(name)) continue;
    let mtime, text;
    try { mtime = statSync(join(dir, name)).mtimeMs; if (mtime < since) continue; text = readFileSync(join(dir, name), "utf8"); } catch { continue; }
    const h = parseHeader(text);
    const parsed = parseName(name);
    const sender = h.meta?.od || parsed.sender;
    if (SKIP_SENDERS.has(sender) || sender === cfg.name) continue;
    const body = h.body.split("\n").map((l) => l.trim()).filter(Boolean);
    const open = /(?:^|\s)Otvorené:\s*(.+)$/m.exec(h.body)?.[1];
    const res = body.find((l) => l.startsWith("Výsledok:")) ?? body[0] ?? "";
    items.push({ mtime, line: `- ${sender}, téma ${h.meta?.tema || parsed.topic || "bez témy"}, ${fmtAt(mtime)} (${h.mode ?? "bez režimu"}): ${cut(res.replace(/\s*Otvorené:.*$/, ""), 200)}${open ? ` | Otvorené: ${cut(open, 100)}` : ""}` });
  }
  items.sort((a, b) => a.mtime - b.mtime);
  if (!items.length) lines.push("- žiadne");
  for (const i of items.slice(0, 30)) lines.push(i.line);
  if (items.length > 30) lines.push(`- ... ďalších ${items.length - 30}`);
  return lines;
}

// ---- Úloha 653: účasť operátora na hotovej úlohe ----

// Čísla úloh v názve vlákna T3: `úloha 14`, `Úloha 614:`, `#351`, `u621`, `u621b`. Holé číslo nie.
const TASK_IN_TITLE_RE = /(?:^|[^\p{L}\d])(?:úloha|uloha|#|u)\s?(\d{1,6})(?![\d])/giu;
export function taskIdsInTitle(title) {
  const out = new Set();
  for (const m of String(title ?? "").matchAll(TASK_IN_TITLE_RE)) out.add(Number(m[1]));
  return out;
}

export function operatorMark(env = process.env) {
  const w = String(env.AGENT_OPERATOR_WITH || "").trim();
  if (w) return `[s ${w}]`;
  const name = String(env.AGENT_OPERATOR_NAME || "").trim();
  return name ? `[s ${name}om]` : "[s operátorom]";
}

// Úlohy, na ktorých sa operátor v okne zúčastnil: Map id -> zoznam zdrojov ("T3 <názov vlákna>",
// "komentár"). Obe DB len na čítanie, chyba ide do `errors`, nie výnimkou.
export function operatorTasks(cfg, now = Date.now(), deps = {}) {
  const env = deps.env || process.env;
  const since = now - 24 * 3600_000;
  const tasks = new Map();
  const errors = [];
  const add = (id, src) => { const g = tasks.get(id) || []; if (!g.includes(src)) g.push(src); tasks.set(id, g); };
  const operators = new Set(String(env.TASKER_OPERATORS || "operator").split(":").filter(Boolean));
  const name = String(env.AGENT_OPERATOR_NAME || "").trim();
  try {
    const db = new DatabaseSync(cfg.taskerDb, { readOnly: true });
    let comments;
    try { comments = db.prepare("SELECT task_id, author, body FROM comments WHERE created_at >= ? ORDER BY id").all(since); } finally { db.close(); }
    for (const c of comments) {
      if (operators.has(String(c.author)) || (name && String(c.body).startsWith(name))) add(c.task_id, "komentár");
    }
  } catch (e) {
    errors.push(`Tasker: čítanie komentárov zlyhalo: ${(e.message || "").toString().trim().slice(0, 300)}`);
  }
  if (cfg.t3Db && existsSync(cfg.t3Db)) {
    try {
      const db = new DatabaseSync(cfg.t3Db, { readOnly: true });
      let rows;
      try {
        rows = db.prepare(
          `SELECT m.payload_json AS payload, t.title AS title
             FROM orchestration_v2_projection_messages m
             JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
            WHERE m.role = 'user' AND m.created_at >= ?`).all(new Date(since).toISOString());
      } finally { db.close(); }
      for (const r of rows) {
        const ids = taskIdsInTitle(r.title);
        if (!ids.size) continue;
        let p;
        try { p = JSON.parse(r.payload); } catch { continue; }
        if (!isOperatorMessage({ ...p, role: "user" })) continue;
        for (const id of ids) add(id, `T3 ${cut(r.title, 40)}`);
      }
    } catch (e) {
      errors.push(`T3: čítanie správ zlyhalo: ${(e.message || "").toString().trim().slice(0, 300)}`);
    }
  }
  return { tasks, errors };
}

// Do výstupu `tasker summary` doplní značku za každý riadok `- #N ...` v časti `## Hotové`, ktorého
// úloha je v `part.tasks`. Vráti text a riadky s počtom pod časťou.
export function markDone(summary, part, mark) {
  const lines = String(summary ?? "").split("\n");
  let inDone = false;
  const withOp = [], without = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^## /.test(l)) { inDone = /^## Hotové(\s|$)/.test(l); continue; }
    if (!inDone) continue;
    const m = l.match(/^- #(\d+)\b/);
    if (!m) continue;
    const id = Number(m[1]);
    if (part.tasks.has(id)) { lines[i] = `${l} ${mark}`; withOp.push(id); } else without.push(id);
  }
  const tail = [];
  if (withOp.length || without.length) {
    tail.push("", `Hotové ${mark}, len počet, bez opisu: ${withOp.length} (úlohy ${idList(withOp)})`);
    for (const id of withOp) tail.push(`- #${id}: ${part.tasks.get(id).join(", ")}`);
    tail.push(`Hotové bez účasti operátora, do súhrnu s opisom: ${without.length} (úlohy ${idList(without)})`);
  }
  for (const e of part.errors) tail.push(e);
  return { text: lines.join("\n"), lines: tail };
}

export function build(cfg, run = execFileSync, now = Date.now(), deps = {}) {
  let tasker;
  try {
    tasker = run(cfg.taskerBin, ["summary", "--since", "24h"], {
      encoding: "utf8", timeout: 60_000, env: { ...process.env, TASKER_HOME: cfg.taskerHome, TASKER_DB: cfg.taskerDb },
    }).trim();
  } catch (e) {
    tasker = `tasker summary zlyhal: ${(e.stderr || e.message || "").toString().trim().slice(0, 1000)}`;
  }
  const mark = operatorMark(deps.env || process.env);
  const done = markDone(tasker, operatorTasks(cfg, now, deps), mark);
  return [
    "Ranný súhrn. Napíš operátorovi do tohto vlákna stav firmy podľa svojej persony:",
    "Hotové, Beží, Čaká na teba, každá položka jeden riadok obyčajnými slovami.",
    "Report napíš len z týchto dát, nástroj použi len na akciu (oprava, úloha). Chýbajúci údaj je úloha na morning.mjs, nie ručný dopyt.",
    `Hotovú úlohu so značkou ${mark} uveď len v počte, bez opisu, opis dostane len práca bez účasti operátora.`,
    "",
    "Tasker za posledných 24 h:",
    "",
    done.text,
    ...done.lines,
    ...runningSection(cfg, now),
    ...stalledSection(cfg, now),
    ...interruptedSection(cfg, now),
    ...repliesSection(cfg, now),
    ...heldSection(sweepHeld(cfg, now)),
    ...decisionsSection(cfg, deps.git, deps.check),
    ...workSection(cfg, now, deps),
    ...reposSection(cfg, deps),
    ...operatorSection(cfg, now, deps),
  ].join("\n");
}

// Bez argumentu zapíše správu do schránky, s `--stdout` vypíše telo súhrnu (bez hlavičky
// `odpoveď:` a pod.) a do schránky nič nezapíše. Iný argument skončí kódom 2.
export function main(argv = process.argv.slice(2), cfg = config(), out = (t) => process.stdout.write(t)) {
  const bad = argv.filter((a) => a !== "--stdout");
  if (bad.length) {
    process.stderr.write(`morning.mjs: neznámy argument ${bad.join(" ")}, platí len --stdout\n`);
    return 2;
  }
  const text = build(cfg);
  if (argv.includes("--stdout")) {
    out(text.endsWith("\n") ? text : `${text}\n`);
    log("agent-morning", "súhrn na stdout");
    return 0;
  }
  const name = writeInbox(cfg.box, "ranny", text, null, "nečakám");
  log("agent-morning", `zapísané ${name}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main();
