// Ranný súhrn: časť Beží, úlohy in_progress s časom vstupu a otvorenou prácou (úloha 662). Všetky DB a priečinky
// sú dočasné v mkdtemp, nič sa nečíta zo živých. Mená sú vymyslené.
import "../lib/git_isolate.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runningSection, build } from "../morning.mjs";

const NOW = Date.parse("2026-10-26T06:00:07Z");
const H = 3600_000;
const M = 60_000;

function taskerDb({ empty = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "adam-run-"));
  const path = join(dir, "tasker.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, status TEXT, assignee TEXT, project TEXT, wait_reason TEXT, updated_at INTEGER);
           CREATE TABLE events (id INTEGER PRIMARY KEY, task_id INTEGER, run_id INTEGER, at INTEGER NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, from_status TEXT, to_status TEXT, detail TEXT);
           CREATE TABLE comments (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, author_kind TEXT, author TEXT, body TEXT NOT NULL, created_at INTEGER NOT NULL);
           CREATE TABLE runs (id INTEGER PRIMARY KEY, task_id INTEGER, agent TEXT, status TEXT, result_subtype TEXT, started_at INTEGER, ended_at INTEGER);
           CREATE TABLE work (id INTEGER PRIMARY KEY, task_id INTEGER, agent TEXT, thread TEXT, since INTEGER, until INTEGER, ended_at INTEGER)`);
  if (!empty) {
    const t = db.prepare("INSERT INTO tasks (id, title, status, assignee, project, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
    const e = db.prepare("INSERT INTO events (task_id, at, actor, kind, from_status, to_status) VALUES (?, ?, ?, ?, ?, ?)");
    const w = db.prepare("INSERT INTO work (task_id, agent, thread, since, until, ended_at) VALUES (?, ?, ?, ?, ?, ?)");
    // 1: in_progress od pred 5 h (posledný vstup), otvorená práca od pred 20 min
    t.run(1, "Adamova hlavná úloha", "in_progress", "eva", "alfa", NOW - 10 * M);
    e.run(1, NOW - 9 * H, "human:adam", "created", null, "todo");
    e.run(1, NOW - 8 * H, "tasker", "status", "todo", "in_progress");
    e.run(1, NOW - 7 * H, "tasker", "status", "in_progress", "waiting");
    e.run(1, NOW - 5 * H, "tasker", "status", "waiting", "in_progress");
    w.run(1, "eva", "t-1", NOW - 20 * M, NOW + 10 * M, null);
    // 2: in_progress bez udalosti, bez riešiteľa a projektu, od updated_at (pred 30 h)
    t.run(2, "Bez udalostí", "in_progress", null, null, NOW - 30 * H);
    // 3: in_progress, starý work (until v minulosti, ended_at null) a ukončený work
    t.run(3, "Starý work", "in_progress", "adam", "beta", NOW - H);
    e.run(3, NOW - 2 * H, "tasker", "status", "queued", "in_progress");
    w.run(3, "adam", "t-3", NOW - 3 * H, NOW - 2 * H, null);
    w.run(3, "adam", "t-3", NOW - 3 * H, NOW + H, NOW - 2 * H);
    // 4: done sa nevypíše
    t.run(4, "Hotová", "done", "eva", "alfa", NOW - H);
    e.run(4, NOW - 50 * H, "tasker", "status", "queued", "in_progress");
    w.run(4, "eva", "t-4", NOW - 20 * M, NOW + 10 * M, null);
    // 5: dvaja agenti s otvorenou prácou
    t.run(5, "Dvaja pracujú", "in_progress", "eva", "alfa", NOW - H);
    e.run(5, NOW - H, "tasker", "status", "queued", "in_progress");
    w.run(5, "eva", "t-5", NOW - 30 * M, NOW + 10 * M, null);
    w.run(5, "adam", "t-6", NOW - 15 * M, NOW + 10 * M, null);
  }
  db.close();
  return path;
}

test("beží: číslo, riešiteľ, projekt, názov, trvanie od posledného vstupu a otvorená práca", () => {
  const out = runningSection({ taskerDb: taskerDb() }, NOW).join("\n");
  assert.match(out, /^\nBeží \(úlohy in_progress: 4\), od vstupu do stavu:\n\n- /);
  assert.match(out, /- úloha 1 eva, alfa, "Adamova hlavná úloha": od 26\. 10\. 02:00 \(5 h 00 min\), pracuje eva od 06:40$/m);
});

test("beží: bez udalosti sa berie updated_at, bez riešiteľa, projektu a otvorenej práce", () => {
  const out = runningSection({ taskerDb: taskerDb() }, NOW).join("\n");
  assert.match(out, /- úloha 2 bez riešiteľa, bez projektu, "Bez udalostí": od 25\. 10\. \d\d:\d\d \(30 h 00 min\), bez otvorenej práce$/m);
});

test("beží: starý work s until v minulosti a ukončený work sa nepočítajú, viac agentov oddelí bodkočiarka", () => {
  const out = runningSection({ taskerDb: taskerDb() }, NOW).join("\n");
  assert.match(out, /- úloha 3 adam, beta, "Starý work": .*\(2 h 00 min\), bez otvorenej práce$/m);
  assert.match(out, /- úloha 5 eva, alfa, "Dvaja pracujú": .*, pracuje eva od \d\d:\d\d; pracuje adam od \d\d:\d\d$/m);
});

test("beží: done sa nevypíše a poradie ide od najstaršieho vstupu", () => {
  const out = runningSection({ taskerDb: taskerDb() }, NOW).join("\n");
  assert.doesNotMatch(out, /úloha 4 /);
  const pos = [2, 1, 3, 5].map((n) => out.indexOf(`- úloha ${n} `));
  assert.ok(pos.every((p) => p >= 0), String(pos));
  assert.deepEqual([...pos].sort((a, b) => a - b), pos);
});

test("beží: bez in_progress je riadok žiadne", () => {
  const out = runningSection({ taskerDb: taskerDb({ empty: true }) }, NOW).join("\n");
  assert.match(out, /Beží \(úlohy in_progress: 0\), od vstupu do stavu:\n\n- žiadne$/);
});

test("beží: chýbajúca DB Taskera je riadok, nie výnimka", () => {
  const cfg = { taskerDb: join(tmpdir(), "adam-nie", "t.db") };
  assert.match(runningSection(cfg, NOW).join("\n"), /Beží: čítanie databázy Taskera zlyhalo/);
});

test("build(): časť Beží je pred stojacimi úlohami", () => {
  const box = mkdtempSync(join(tmpdir(), "adam-box-"));
  mkdirSync(join(box, "processed"));
  const cfg = { taskerDb: taskerDb(), t3Db: "/nie/je", taskerBin: "/nie/je", taskerHome: tmpdir(), workRepos: [], box, name: "adam" };
  const out = build(cfg, () => "x", NOW, { git: () => "" });
  const a = out.indexOf("Beží (úlohy in_progress");
  const b = out.indexOf("Úlohy, ktoré v okne 24 h stáli");
  assert.ok(a >= 0 && b > a, `${a} ${b}`);
});
