// Úloha 560: správa mosta o úlohe, ktorej bloker alebo predok patrí téme, ide do vlákna témy.
// Prípad z 25. 10. 2026: nadväzujúca úloha (blokér = úloha témy) prešla po done blokéra do handoff
// a správa šla do hlavného vlákna, hoci vlákno témy blokér viedlo. Len DB, schránky a zoznam tém v tmp.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bridgeTick, topicFor } from "../tasker_events.mjs";

function setup() {
  const root = mkdtempSync(join(tmpdir(), "bridge-blocker-topic-"));
  const box = join(root, "box");
  mkdirSync(join(box, "inbox"), { recursive: true });
  const cfg = { name: "adam", box, state: join(root, "state"), taskerDb: join(root, "tasker.db"), topicsFile: join(root, "topics.json") };
  assert.ok(cfg.taskerDb.startsWith(tmpdir()) && cfg.box.startsWith(tmpdir()) && !cfg.box.startsWith("/var/lib"));
  writeFileSync(cfg.topicsFile, JSON.stringify({ jadro: { thread: "thr-jadro", at: "x", tasks: [100] } }, null, 1));
  const db = new DatabaseSync(cfg.taskerDb);
  db.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT, status TEXT, assignee TEXT, project TEXT, parent_id INTEGER);
    CREATE TABLE blockers (task_id INTEGER NOT NULL, blocker_id INTEGER NOT NULL, PRIMARY KEY (task_id, blocker_id));
    CREATE TABLE runs (id INTEGER PRIMARY KEY, task_id INTEGER, agent_summary TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, task_id INTEGER, author_kind TEXT, author TEXT, body TEXT, created_at INTEGER);
    CREATE TABLE events (id INTEGER PRIMARY KEY, task_id INTEGER, run_id INTEGER, at INTEGER NOT NULL,
      actor TEXT NOT NULL, kind TEXT NOT NULL, from_status TEXT, to_status TEXT, detail TEXT, quiet INTEGER NOT NULL DEFAULT 0);
    INSERT INTO tasks VALUES
      (100, 'Blokér v téme', 'x', 'done', 'adam', 'agenti', NULL),
      (101, 'Nadväzujúca', 'telo', 'handoff', 'adam', 'agenti', NULL),
      (102, 'Nadväzujúca cez dva', 'telo', 'handoff', 'adam', 'agenti', NULL),
      (103, 'Podúloha nadväzujúcej', 'telo', 'handoff', 'adam', 'agenti', 101),
      (104, 'Bez väzby', 'telo', 'handoff', 'adam', 'agenti', NULL),
      (110, 'Cyklus A', 'x', 'x', 'adam', 'agenti', NULL), (111, 'Cyklus B', 'x', 'x', 'adam', 'agenti', NULL);
    INSERT INTO blockers VALUES (101, 100), (102, 101), (110, 111), (111, 110);
    INSERT INTO events (task_id, at, actor, kind) VALUES (0, 1, 'x', 'created');`);
  return { cfg, db, box };
}

test("topicFor: bloker v téme dá tému aj nadväzujúcej úlohe, aj cez reťaz blokérov a podúloh, cyklus nezacyklí", () => {
  const { cfg, db } = setup();
  assert.equal(topicFor(cfg, "agenti", 100, db), "jadro");
  assert.equal(topicFor(cfg, "agenti", 101, db), "jadro");
  assert.equal(topicFor(cfg, "agenti", 102, db), "jadro");
  assert.equal(topicFor(cfg, "agenti", 103, db), "jadro");
  assert.equal(topicFor(cfg, "agenti", 104, db), null);
  assert.equal(topicFor(cfg, "agenti", 110, db), null);
  db.close();
});

test("topicFor: bez tabuľky blockers (staré DB) funguje ako doteraz", () => {
  const { cfg, db } = setup();
  db.exec("DROP TABLE blockers");
  assert.equal(topicFor(cfg, "agenti", 101, db), null);
  assert.equal(topicFor(cfg, "agenti", 100, db), "jadro");
  db.close();
});

test("most: handoff po done blokéra z témy ide do vlákna témy, nie do hlavného", async () => {
  const { cfg, db, box } = setup();
  await bridgeTick(cfg, [{ name: "adam", box }]);
  db.prepare("INSERT INTO events (task_id, at, actor, kind, from_status, to_status) VALUES (101, 5, 'tasker', 'status', 'blocked', 'handoff')").run();
  db.prepare("INSERT INTO events (task_id, at, actor, kind, from_status, to_status) VALUES (104, 6, 'tasker', 'status', 'blocked', 'handoff')").run();
  const r = await bridgeTick(cfg, [{ name: "adam", box }]);
  assert.equal(r.written, 2);
  const names = readdirSync(join(box, "inbox")).sort();
  assert.equal(names.filter((n) => /^tasker-jadro-\d{8}-\d{6}-/.test(n)).length, 1);
  assert.equal(names.filter((n) => /^tasker-\d{8}-\d{6}-/.test(n)).length, 1);
  db.close();
});
