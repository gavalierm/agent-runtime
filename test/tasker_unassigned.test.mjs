// Most: úloha bez riešiteľa, ktorú Tasker sám presunul blocked -> unassigned, ide
// zakladateľovi, ak je to agent s mostom (chyba 23. 10. 2026, úloha 427).
// Len DB a schránky v tmp, agents sa predáva explicitne, živá cesta sa nečíta.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bridgeTick } from "../tasker_events.mjs";

process.env.TASKER_WEB_URL = "https://tasker.example.ts.net:8801";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "adam-unas-"));
  assert.ok(root.startsWith(tmpdir()));
  const box = join(root, "box");
  const borisBox = join(root, "boris");
  for (const b of [box, borisBox]) mkdirSync(join(b, "inbox"), { recursive: true });
  const cfg = { name: "adam", box, state: join(root, "state"), taskerDb: join(root, "tasker.db"), taskerHome: "/h/.tasker" };
  assert.ok(cfg.taskerDb.startsWith(tmpdir()) && cfg.box.startsWith(tmpdir()) && !cfg.box.startsWith("/var/lib"));
  const db = new DatabaseSync(cfg.taskerDb);
  db.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT, status TEXT, assignee TEXT, project TEXT);
    CREATE TABLE runs (id INTEGER PRIMARY KEY, task_id INTEGER, agent_summary TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, task_id INTEGER, author_kind TEXT, author TEXT, body TEXT, created_at INTEGER);
    CREATE TABLE events (id INTEGER PRIMARY KEY, task_id INTEGER, run_id INTEGER, at INTEGER NOT NULL,
      actor TEXT NOT NULL, kind TEXT NOT NULL, from_status TEXT, to_status TEXT, detail TEXT, quiet INTEGER NOT NULL DEFAULT 0);
    INSERT INTO tasks VALUES
      (1, 'Bez riešiteľa, od Adama', 'telo 1', 'blocked', NULL, 'agenti'),
      (2, 'S riešiteľom boris, od Adama', 'telo 2', 'blocked', 'boris', NULL),
      (3, 'Bez riešiteľa, od cudzieho', 'telo 3', 'blocked', NULL, NULL),
      (4, 'Bez riešiteľa, od Borisa', 'telo 4', 'blocked', NULL, NULL);
    INSERT INTO events (task_id, at, actor, kind) VALUES (0, 1, 'x', 'created'),
      (1, 1, 'human:adam', 'created'), (2, 1, 'human:adam', 'created'),
      (3, 1, 'human:operator', 'created'), (4, 1, 'human:boris', 'created');`);
  const agents = [{ name: "adam", box }, { name: "boris", box: borisBox }];
  return { cfg, db, agents, box, borisBox };
}

const msgs = (box) => readdirSync(join(box, "inbox")).map((n) => readFileSync(join(box, "inbox", n), "utf8"));

function unblock(db, id, actor = "tasker") {
  const st = db.prepare("SELECT assignee FROM tasks WHERE id = ?").get(id).assignee ? "handoff" : "unassigned";
  db.prepare("INSERT INTO events (task_id, at, actor, kind, from_status, to_status) VALUES (?, 5, ?, 'status', 'blocked', ?)").run(id, actor, st);
  db.prepare("UPDATE tasks SET status = ? WHERE id = ?").run(st, id);
}

test("most: odblokovaná úloha bez riešiteľa dá zakladateľovi adam jednu správu nečakám, druhý beh nič", async () => {
  const { cfg, db, agents, box, borisBox } = setup();
  await bridgeTick(cfg, agents);
  unblock(db, 1);
  const r = await bridgeTick(cfg, agents);
  assert.equal(r.written, 1);
  const [m] = msgs(box);
  assert.match(m, /^odpoveď: nečakám\nTasker: úloha #1, ktorú si založil, je odblokovaná a nemá riešiteľa/);
  assert.match(m, /Odkaz: https:\/\/\S+\/tasks\/1\n/);
  assert.match(m, /Názov: Bez riešiteľa, od Adama/);
  assert.match(m, /Detail: AGENT_NAME=adam \/opt\/agentic-workflow\/bin\/tk task show 1 --json/);
  assert.match(m, /Hotovo: AGENT_NAME=adam \/opt\/agentic-workflow\/bin\/tk done 1 --summary/);
  assert.deepEqual(msgs(borisBox), []);
  assert.equal((await bridgeTick(cfg, agents)).written, 0, "druhý beh tú istú udalosť nepošle");
  assert.equal(msgs(box).length, 1);
});

test("most: odblokovaná úloha s riešiteľom boris ide ako dnes, jednou bežnou správou Borisovi, Adamovi nič", async () => {
  const { cfg, db, agents, box, borisBox } = setup();
  await bridgeTick(cfg, agents);
  unblock(db, 2);
  const r = await bridgeTick(cfg, agents);
  assert.equal(r.written, 1);
  assert.deepEqual(msgs(box), []);
  assert.match(msgs(borisBox)[0], /^odpoveď: nečakám\nTasker: úloha #2 pre teba, úloha je v poradí/);
});

test("most: zakladateľ, ktorý nie je agent s mostom, správu nedá", async () => {
  const { cfg, db, agents, box, borisBox } = setup();
  await bridgeTick(cfg, agents);
  unblock(db, 3);
  assert.equal((await bridgeTick(cfg, agents)).written, 0);
  assert.deepEqual(msgs(box), []);
  assert.deepEqual(msgs(borisBox), []);
});

test("most: zakladateľ boris dostane správu do svojej schránky, nie Adam", async () => {
  const { cfg, db, agents, box, borisBox } = setup();
  await bridgeTick(cfg, agents);
  unblock(db, 4);
  assert.equal((await bridgeTick(cfg, agents)).written, 1);
  assert.deepEqual(msgs(box), []);
  assert.match(msgs(borisBox)[0], /^odpoveď: nečakám\nTasker: úloha #4, ktorú si založil, je odblokovaná/);
});

test("most: prechod blocked -> unassigned, ktorý neurobil tasker, správu nedá", async () => {
  const { cfg, db, agents, box } = setup();
  await bridgeTick(cfg, agents);
  unblock(db, 1, "human:operator");
  assert.equal((await bridgeTick(cfg, agents)).written, 0);
  assert.deepEqual(msgs(box), []);
});

test("most: zakladateľ s enabled=1 v Taskeri správu nedostane, spúšťa ho dispečer", async () => {
  const { cfg, db, agents, box } = setup();
  db.exec("CREATE TABLE agents (name TEXT, enabled INTEGER); INSERT INTO agents VALUES ('adam', 1), ('boris', 0);");
  await bridgeTick(cfg, agents);
  unblock(db, 1);
  assert.equal((await bridgeTick(cfg, agents)).written, 0);
  assert.deepEqual(msgs(box), []);
});
