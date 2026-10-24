// Most: komentár operátora (operator) po needs_human ide Adamovi ako čakám
// "zapíš rozhodnutie"; otázka, ktorú Adam položil sám (tasker ask), ho nebudí.
// Len DB a schránky v tmp, agents sa predáva explicitne, živá cesta sa nečíta.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tick, bridgeTick } from "../tasker_events.mjs";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "adam-dec-"));
  assert.ok(root.startsWith(tmpdir()));
  const box = join(root, "box");
  const borisBox = join(root, "boris");
  for (const b of [box, borisBox]) mkdirSync(join(b, "inbox"), { recursive: true });
  const cfg = { name: "adam", box, state: join(root, "state"), taskerDb: join(root, "tasker.db"), taskerHome: "/h/.tasker" };
  const db = new DatabaseSync(cfg.taskerDb);
  db.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT, status TEXT, assignee TEXT, project TEXT);
    CREATE TABLE runs (id INTEGER PRIMARY KEY, task_id INTEGER, agent_summary TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, task_id INTEGER, author_kind TEXT, author TEXT, body TEXT, created_at INTEGER);
    CREATE TABLE events (id INTEGER PRIMARY KEY, task_id INTEGER, run_id INTEGER, at INTEGER NOT NULL,
      actor TEXT NOT NULL, kind TEXT NOT NULL, from_status TEXT, to_status TEXT, detail TEXT, quiet INTEGER NOT NULL DEFAULT 0);
    INSERT INTO tasks VALUES (1, 'Plagáty', 'telo', 'needs_human', 'web', NULL), (2, 'Otázka Adama', 'telo', 'needs_human', 'adam', NULL),
      (3, 'Otázka Borisa', 'telo', 'needs_human', 'boris', NULL);
    INSERT INTO events (task_id, at, actor, kind) VALUES (0, 1, 'x', 'created');`);
  const agents = [{ name: "adam", box }, { name: "boris", box: borisBox }];
  return { cfg, db, agents, box, borisBox };
}

const msgs = (box) => readdirSync(join(box, "inbox")).map((n) => readFileSync(join(box, "inbox", n), "utf8"));

// Komentár človeka na needs_human zapíše Tasker ako comment a hneď status needs_human -> todo.
function humanComment(db, id, author, body, at = 5) {
  db.prepare("INSERT INTO comments (task_id, author_kind, author, body, created_at) VALUES (?, 'human', ?, ?, ?)").run(id, author, body, at);
  const ev = db.prepare("INSERT INTO events (task_id, at, actor, kind, from_status, to_status) VALUES (?, ?, ?, ?, ?, ?)");
  ev.run(id, at, `human:${author}`, "comment", null, null);
  ev.run(id, at, `human:${author}`, "status", "needs_human", "todo");
  db.prepare("UPDATE tasks SET status = 'todo' WHERE id = ?").run(id);
}

test("most: komentár operator na needs_human dá Adamovi správu čakám so zapíš rozhodnutie", async () => {
  const { cfg, db, agents, box } = setup();
  await bridgeTick(cfg, agents);
  humanComment(db, 1, "operator", "Plagáty všetkých projektov farebne.");
  const r = await bridgeTick(cfg, agents);
  assert.equal(r.written, 1);
  const [m] = msgs(box);
  assert.match(m, /^odpoveď: čakám\nTasker: úloha #1, komentár operator po needs_human, zapíš rozhodnutie/);
  assert.match(m, /Plagáty všetkých projektov farebne\./);
  assert.match(m, /rozhodni\.sh/);
  assert.equal((await bridgeTick(cfg, agents)).written, 0, "druhý beh nič nepošle");
});

test("most: komentár iného človeka než operátora správu rozhodnutia nedá", async () => {
  const { cfg, db, agents, box } = setup();
  await bridgeTick(cfg, agents);
  humanComment(db, 1, "visitor", "poznámka");
  await bridgeTick(cfg, agents);
  assert.deepEqual(msgs(box), []);
});

test("most: komentár operator na úlohe, ktorá nebola v needs_human, správu rozhodnutia nedá", async () => {
  const { cfg, db, agents, box } = setup();
  await bridgeTick(cfg, agents);
  db.prepare("INSERT INTO comments (task_id, author_kind, author, body, created_at) VALUES (1, 'human', 'operator', 'x', 5)").run();
  db.prepare("INSERT INTO events (task_id, at, actor, kind) VALUES (1, 5, 'human:operator', 'comment')").run();
  await bridgeTick(cfg, agents);
  assert.deepEqual(msgs(box), []);
});

test("most: úloha Adama s komentárom operator dostane jednu správu rozhodnutia, nie dve", async () => {
  const { cfg, db, agents, box } = setup();
  await bridgeTick(cfg, agents);
  humanComment(db, 2, "operator", "Áno, B.");
  const r = await bridgeTick(cfg, agents);
  assert.equal(r.written, 1);
  assert.match(msgs(box)[0], /^odpoveď: čakám\n.*zapíš rozhodnutie/);
});

test("most: úloha Borisa s komentárom operator ide Borisovi bežnou správou a Adamovi rozhodnutie", async () => {
  const { cfg, db, agents, box, borisBox } = setup();
  await bridgeTick(cfg, agents);
  humanComment(db, 3, "operator", "Variant A.");
  const r = await bridgeTick(cfg, agents);
  assert.equal(r.written, 2);
  assert.match(msgs(borisBox)[0], /^odpoveď: nečakám\n.*pre teba[\s\S]*Variant A\./);
  assert.match(msgs(box)[0], /^odpoveď: čakám\n.*zapíš rozhodnutie/);
});

test("tick: tasker ask od adam do needs_human správu nedá, ask od boris áno ako čakám", async () => {
  const { cfg, db, box } = setup();
  await tick(cfg);
  const ev = db.prepare("INSERT INTO events (task_id, at, actor, kind, from_status, to_status, detail) VALUES (?, 5, ?, 'status', 'in_progress', 'needs_human', ?)");
  ev.run(2, "human:adam", "ask");
  let r = await tick(cfg);
  assert.equal(r.written, 0);
  assert.deepEqual(msgs(box), []);
  ev.run(3, "human:boris", "ask");
  r = await tick(cfg);
  assert.equal(r.written, 1);
  assert.match(msgs(box)[0], /^odpoveď: čakám\nTasker: úloha #3 čaká na človeka/);
});

test("tick: prechod do needs_human od adam bez detailu ask správu dá", async () => {
  const { cfg, db, box } = setup();
  await tick(cfg);
  db.prepare("INSERT INTO events (task_id, at, actor, kind, from_status, to_status) VALUES (2, 5, 'human:adam', 'status', 'in_progress', 'needs_human')").run();
  assert.equal((await tick(cfg)).written, 1);
  assert.equal(msgs(box).length, 1);
});
