#!/usr/bin/env node
// Ranný súhrn: zapíše do schránky agenta správu ranny-<čas>.md so súhrnom
// Taskera za 24 h (`tasker summary`), prvý riadok `odpoveď: nečakám`
// (budí a vynesie držané správy na vedomie). Každú držanú správu na vedomie
// presunie do processed a vypíše v súhrne (sweepHeld). Agent z neho napíše operátorovi súhrn
// do svojho vlákna. Spúšťa ho agent-morning.timer.
// Keď `tasker summary` zlyhá, správa nesie chybu, súhrn neodpadne potichu.
// Časti súhrnu: držané správy, nové rozhodnutia, rozloženie práce (workSection)
// a zásahy operátora za 24 h (operatorSection, úloha 605): udalosti operátora
// a posuny poradia v Taskeri, komentáre agenta za operátora (telo začína
// AGENT_OPERATOR_NAME) a správy operátora z webu v T3 (cfg.t3Db). Obe DB len na čítanie.
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { config, inboxEntries, log, parseHeader, parseName, writeInbox } from "./lib.mjs";
import { operatorActors } from "./tasker_events.mjs";

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

// Nové rozhodnutia za 24 h z git logu repa pravidiel (nové súbory rozhodnutia/D*.md)
// a výstup `rozhodnutia.mjs check` (problémy a upozornenia na rovnaký názov
// pri rôznych kľúčoch). Úloha 470, replay S9. Bez cfg.rulesRepo nerobí nič.
// `git` a `check` sú vstrekované kvôli testu, nič sa nezapisuje.
export function decisionsSection(cfg, git = (a) => execFileSync("git", a, { encoding: "utf8", timeout: 30_000 }),
  check = (lib, dir) => spawnSync("node", [lib, "check", "--dir", dir], { encoding: "utf8", timeout: 30_000 }).stdout ?? "") {
  const repo = cfg.rulesRepo;
  if (!repo) return [];
  let files;
  try {
    files = git(["-C", repo, "log", "--since=24 hours ago", "--diff-filter=A", "--name-only", "--format=", "--", "rozhodnutia/"])
      .split("\n").map((l) => /^rozhodnutia\/(D\d{4})\.md$/.exec(l.trim())?.[1]).filter(Boolean);
  } catch (e) {
    return ["", `Rozhodnutia: git log zlyhal: ${(e.stderr || e.message || "").toString().trim().slice(0, 300)}`];
  }
  files = [...new Set(files)].sort();
  const field = (text, k) => new RegExp(`^${k}:[ \\t]*(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
  const lines = ["", `Nové rozhodnutia za 24 h (${files.length}):`, ""];
  for (const id of files) {
    let t = "";
    try { t = readFileSync(join(repo, "rozhodnutia", `${id}.md`), "utf8"); } catch { /* záznam zmizol */ }
    lines.push(`- ${id}, zapísal ${field(t, "zapisal") || "?"}, rozhodol ${field(t, "rozhodol") || "?"}, moc ${field(t, "moc") || "?"}, kľúč ${field(t, "kluc") || "?"}: ${field(t, "nazov")}`);
  }
  if (!files.length) lines.push("- žiadne");
  const found = check(join(repo, "lib", "rozhodnutia.mjs"), join(repo, "rozhodnutia")).split("\n").map((l) => l.trim()).filter(Boolean);
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
  if (payload?.createdBy !== "user" || payload?.creationSource !== "web") return false;
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

export function build(cfg, run = execFileSync, now = Date.now(), deps = {}) {
  let tasker;
  try {
    tasker = run(cfg.taskerBin, ["summary", "--since", "24h"], {
      encoding: "utf8", timeout: 60_000, env: { ...process.env, TASKER_HOME: cfg.taskerHome, TASKER_DB: cfg.taskerDb },
    }).trim();
  } catch (e) {
    tasker = `tasker summary zlyhal: ${(e.stderr || e.message || "").toString().trim().slice(0, 1000)}`;
  }
  return [
    "Ranný súhrn. Napíš operátorovi do tohto vlákna stav firmy podľa svojej persony:",
    "Hotové, Beží, Čaká na teba, každá položka jeden riadok obyčajnými slovami.",
    "",
    "Tasker za posledných 24 h:",
    "",
    tasker,
    ...heldSection(sweepHeld(cfg, now)),
    ...decisionsSection(cfg, deps.git, deps.check),
    ...workSection(cfg, now, deps),
    ...operatorSection(cfg, now, deps),
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = config();
  const name = writeInbox(cfg.box, "ranny", build(cfg), null, "nečakám");
  log("agent-morning", `zapísané ${name}`);
}
