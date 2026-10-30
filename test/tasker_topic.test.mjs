import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync as mkdtempRaw, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tick, render, topicFor } from "../tasker_events.mjs";
import { setTopic } from "../route.mjs";

// Dočasné priečinky testu sa na konci zmažú (úloha 701).
const tmpDirs = [];
const mkdtempSync = (prefix) => { const d = mkdtempRaw(prefix); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

// Všetko v dočasnom priečinku a dočasnej DB, živý /var/lib/adam ani Tasker sa nečítajú.
function setup() {
  const root = mkdtempSync(join(tmpdir(), "adam-tt-"));
  const box = join(root, "box");
  for (const d of ["inbox", "outbox", "processed"]) mkdirSync(join(box, d), { recursive: true });
  const cfg = { name: "adam", box, state: join(root, "state"), taskerDb: join(root, "tasker.db"), topicsFile: join(root, "topics.json") };
  const db = new DatabaseSync(cfg.taskerDb);
  db.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT, assignee TEXT, project TEXT, parent_id INTEGER);
    CREATE TABLE runs (id INTEGER PRIMARY KEY, task_id INTEGER, agent_summary TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY, task_id INTEGER, run_id INTEGER, at INTEGER NOT NULL,
      actor TEXT NOT NULL, kind TEXT NOT NULL, from_status TEXT, to_status TEXT, detail TEXT, quiet INTEGER NOT NULL DEFAULT 0);
    INSERT INTO tasks VALUES (1, 'S témou', 'x', 'dev', 'projekt_b', NULL), (2, 'Bez témy', 'x', 'dev', 'inyprojekt', NULL), (3, 'Bez projektu', 'x', 'dev', NULL, NULL);
    INSERT INTO events (task_id, at, actor, kind, to_status) VALUES (1, 1, 'tasker', 'status', 'handoff');`);
  return { cfg, db, box };
}

test("tasker_events: správa ide k téme podľa projektu, bez témy a bez projektu do hlavného vlákna", async () => {
  const { cfg, db, box } = setup();
  setTopic(cfg, "projekt_b", "thr-tema");
  await tick(cfg);
  const ins = db.prepare("INSERT INTO events (task_id, at, actor, kind, from_status, to_status) VALUES (?, 2, 'run:1', 'status', 'in_progress', 'needs_human')");
  for (const id of [1, 2, 3]) ins.run(id);
  const r = await tick(cfg);
  assert.equal(r.written, 3);
  assert.match(r.names[0], /^tasker-projekt_b-\d{8}-\d{6}-/);
  assert.match(r.names[1], /^tasker-\d{8}-\d{6}-/);
  assert.match(r.names[2], /^tasker-\d{8}-\d{6}-/);
  assert.match(readFileSync(join(box, "inbox", r.names[0]), "utf8"), /\nProjekt: projekt_b\n/);
  assert.match(readFileSync(join(box, "inbox", r.names[1]), "utf8"), /\nProjekt: inyprojekt\n/);
  assert.doesNotMatch(readFileSync(join(box, "inbox", r.names[2]), "utf8"), /Projekt:/);
  assert.equal(readdirSync(join(box, "inbox")).length, 3);
  db.close();
});

test("tasker_events: bez súboru zoznamu tém ide správa do hlavného vlákna", async () => {
  const { cfg, db } = setup();
  await tick(cfg);
  db.prepare("INSERT INTO events (task_id, at, actor, kind, from_status, to_status) VALUES (1, 2, 'run:1', 'status', 'in_progress', 'failed')").run();
  const r = await tick(cfg);
  assert.match(r.names[0], /^tasker-\d{8}-\d{6}-/);
  db.close();
});

test("render: riadok Projekt len keď úloha projekt má", () => {
  const ev = { task_id: 1, to_status: "done", from_status: "in_progress", actor: "x", at: 0 };
  assert.doesNotMatch(render(ev), /Projekt:/);
  assert.match(render({ ...ev, project: "p" }), /\nProjekt: p\n/);
  assert.match(render({ ...ev, to_status: "failed", project: "p" }), /\nProjekt: p\n/);
});

test("tasker_events: done, ktorý agent zavrel sám, správu nepíše, done z behu áno", async () => {
  const { cfg, db } = setup();
  await tick(cfg);
  db.exec(`INSERT INTO events (task_id, at, actor, kind, to_status) VALUES (2, 1, 'human:adam', 'created', NULL), (3, 1, 'human:adam', 'created', NULL);
    INSERT INTO events (task_id, at, actor, kind, from_status, to_status) VALUES (2, 2, 'human:adam', 'status', 'needs_human', 'done'), (3, 2, 'tasker', 'status', 'in_progress', 'done');`);
  const r = await tick(cfg);
  assert.equal(r.written, 1);
  db.close();
});

test("tasker_events: téma podľa stromu úloh (pole tasks), potom projekt, cyklus nezacyklí", async () => {
  const { cfg, db, box } = setup();
  db.exec(`INSERT INTO tasks VALUES (10, 'Koreň', 'x', 'dev', 'agenti', NULL), (11, 'Podúloha', 'x', 'dev', 'agenti', 10),
    (12, 'Vnúča', 'x', 'dev', 'agenti', 11), (13, 'Mimo', 'x', 'dev', 'projekt_b', NULL),
    (20, 'Cyklus A', 'x', 'dev', NULL, 21), (21, 'Cyklus B', 'x', 'dev', NULL, 20);`);
  setTopic(cfg, "pravidla", "thr-pravidla");
  setTopic(cfg, "projekt_b", "thr-vas");
  const t = JSON.parse(readFileSync(cfg.topicsFile, "utf8"));
  t.pravidla.tasks = [10];
  writeFileSync(cfg.topicsFile, JSON.stringify(t));
  assert.equal(topicFor(cfg, "agenti", 10, db), "pravidla");
  assert.equal(topicFor(cfg, "agenti", 11, db), "pravidla");
  assert.equal(topicFor(cfg, "agenti", 12, db), "pravidla");
  assert.equal(topicFor(cfg, "projekt_b", 13, db), "projekt_b");
  assert.equal(topicFor(cfg, "agenti", 14, db), null);
  assert.equal(topicFor(cfg, null, 20, db), null);
  await tick(cfg);
  db.prepare("INSERT INTO events (task_id, at, actor, kind, from_status, to_status) VALUES (12, 2, 'run:1', 'status', 'in_progress', 'needs_human')").run();
  const r = await tick(cfg);
  assert.match(r.names[0], /^tasker-pravidla-\d{8}-\d{6}-/);
  db.close();
});

test("route topic tasks: pridá id bez duplicít a list ich vypíše", () => {
  const { cfg } = setup();
  setTopic(cfg, "pravidla", "thr-pravidla");
  const run = (...a) => spawnSync(process.execPath, [join(import.meta.dirname, "..", "route.mjs"), "topic", ...a, "--file", cfg.topicsFile], { encoding: "utf8", env: { ...process.env, AGENT_BOX: cfg.box, AGENT_STATE: cfg.state } });
  assert.equal(run("tasks", "pravidla", "390", "391").status, 0);
  assert.equal(run("tasks", "pravidla", "391", "392").status, 0);
  assert.deepEqual(JSON.parse(readFileSync(cfg.topicsFile, "utf8")).pravidla.tasks, [390, 391, 392]);
  assert.match(run("list").stdout, /pravidla thr-pravidla úlohy 390,391,392/);
  assert.equal(run("tasks", "nema", "1").status, 1);
});
