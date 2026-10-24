#!/usr/bin/env node
// Ranný súhrn: zapíše do schránky agenta správu ranny-<čas>.md so súhrnom
// Taskera za 24 h (`tasker summary`), prvý riadok `odpoveď: nečakám`
// (budí a vynesie držané správy na vedomie). Správy na vedomie staršie
// než 24 h presunie do processed a vypíše v súhrne (sweepHeld). Agent z neho napíše operátorovi súhrn
// do svojho vlákna. Spúšťa ho agent-morning.timer.
// Keď `tasker summary` zlyhá, správa nesie chybu, súhrn neodpadne potichu.
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { basename, join } from "node:path";
import { config, inboxEntries, log, parseHeader, parseName, writeInbox } from "./lib.mjs";

const DAY_MS = 24 * 3600 * 1000;

// Držané správy na vedomie staršie než 24 h: presunie ich zo schránky
// agenta do processed a vráti zoznam pre súhrn. Schránky berie z
// cfg.sweepBoxes, bez nich (cfg bez poľa) nerobí nič.
// poistka: zachytí správu na vedomie len pri výpadku budiča alebo vlákne,
// ktoré bolo 12 h trvalo zaneprázdnené. Jadro je doručenie po behu vlákna
// alebo po lehote 12 h v driver.mjs (úloha 518).
export function sweepHeld(cfg, now = Date.now()) {
  const out = [];
  for (const box of cfg.sweepBoxes ?? []) {
    let entries;
    try { entries = inboxEntries(box); } catch { continue; }
    for (const { name, mtime } of entries) {
      if (now - mtime <= DAY_MS) continue;
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
  const lines = ["", `Držané správy na vedomie staršie než 24 h, presunuté do processed (${items.length}):`, ""];
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
  ].join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cfg = config();
  const name = writeInbox(cfg.box, "ranny", build(cfg), null, "nečakám");
  log("agent-morning", `zapísané ${name}`);
}
