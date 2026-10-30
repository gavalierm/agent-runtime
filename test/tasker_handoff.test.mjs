// Odovzdanie agentovi vlákna T3 (úloha 496, D0168): most po zápise správy zapíše doručenie do Taskera
// (`tasker delivered`) a poistka handoff_stale pošle riešiteľovi správu znova. Len DB a schránky v tmp,
// príkaz Taskera je skript v tmp, ktorý zapíše argumenty.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync as mkdtempRaw, mkdirSync, readdirSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bridgeTick, recordDelivered } from "../tasker_events.mjs";

// Dočasné priečinky testu sa na konci zmažú (úloha 701).
const tmpDirs = [];
const mkdtempSync = (prefix) => { const d = mkdtempRaw(prefix); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), "bridge-handoff-"));
  assert.ok(root.startsWith(tmpdir()));
  const box = join(root, "box");
  const borisBox = join(root, "boris");
  for (const b of [box, borisBox]) mkdirSync(join(b, "inbox"), { recursive: true });
  const log = join(root, "tk.log");
  const cmd = join(root, "tk.sh");
  writeFileSync(cmd, `#!/bin/sh\necho "$AGENT_NAME $*" >> "${log}"\n`);
  chmodSync(cmd, 0o755);
  const cfg = { name: "adam", box, state: join(root, "state"), taskerDb: join(root, "tasker.db"), routeCmd: cmd };
  assert.ok(cfg.taskerDb.startsWith(tmpdir()) && cfg.box.startsWith(tmpdir()) && !cfg.box.startsWith("/var/lib"));
  const db = new DatabaseSync(cfg.taskerDb);
  db.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT, status TEXT, assignee TEXT, project TEXT);
    CREATE TABLE runs (id INTEGER PRIMARY KEY, task_id INTEGER, agent_summary TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, task_id INTEGER, author_kind TEXT, author TEXT, body TEXT, created_at INTEGER);
    CREATE TABLE events (id INTEGER PRIMARY KEY, task_id INTEGER, run_id INTEGER, at INTEGER NOT NULL,
      actor TEXT NOT NULL, kind TEXT NOT NULL, from_status TEXT, to_status TEXT, detail TEXT, quiet INTEGER NOT NULL DEFAULT 0);
    INSERT INTO tasks VALUES (1, 'Pre Borisa', 'telo', 'handoff', 'boris', NULL);
    INSERT INTO events (task_id, at, actor, kind) VALUES (0, 1, 'x', 'created'), (1, 1, 'human:adam', 'created');`);
  const agents = [{ name: "adam", box }, { name: "boris", box: borisBox }];
  return { cfg, db, agents, box, borisBox, log };
}

const msgs = (box) => readdirSync(join(box, "inbox")).map((n) => readFileSync(join(box, "inbox", n), "utf8"));

test("most: správa riešiteľovi v handoff sa zapíše do schránky a doručenie do Taskera", async () => {
  const { cfg, db, agents, borisBox, log } = setup();
  await bridgeTick(cfg, agents);
  db.prepare("INSERT INTO events (task_id, at, actor, kind, from_status, to_status) VALUES (1, 5, 'human:adam', 'status', 'blocked', 'handoff')").run();
  const r = await bridgeTick(cfg, agents);
  assert.equal(r.written, 1);
  assert.equal(msgs(borisBox).length, 1);
  assert.equal(readFileSync(log, "utf8").trim(), "adam delivered 1 --to boris --via inbox");
});

test("most: zlyhanie zápisu doručenia správu nezdrží, bez routeCmd sa nezapíše nič", async () => {
  const { cfg, db, agents, borisBox } = setup();
  cfg.routeCmd = "/nonexistent/tk";
  await bridgeTick(cfg, agents);
  db.prepare("INSERT INTO events (task_id, at, actor, kind, from_status, to_status) VALUES (1, 5, 'human:adam', 'status', 'blocked', 'handoff')").run();
  assert.equal((await bridgeTick(cfg, agents)).written, 1);
  assert.equal(msgs(borisBox).length, 1);
  assert.equal(recordDelivered({}, 1, "boris"), false);
});

test("poistka: handoff_stale pošle riešiteľovi správu znova a zakladateľovi ohlásenie, doručenie sa zapíše", async () => {
  const { cfg, db, agents, box, borisBox, log } = setup();
  await bridgeTick(cfg, agents);
  db.prepare("INSERT INTO events (task_id, at, actor, kind, detail) VALUES (1, 9, 'tasker', 'handoff_stale', 'boris: 11 min bez tasker start, správa doručená')").run();
  const r = await bridgeTick(cfg, agents);
  assert.equal(r.written, 2);
  const [resend] = msgs(borisBox);
  assert.match(resend, /^odpoveď: nečakám\nTasker: úloha #1 pre teba, odovzdanie si neprevzal \(tasker start\), posielam správu znova\./);
  const [note] = msgs(box);
  assert.match(note, /Tasker: odovzdanie úlohy #1 agentovi boris nikto neprevzal \(boris: 11 min bez tasker start/);
  assert.match(note, /Komu: zakladateľ\./);
  assert.match(readFileSync(log, "utf8"), /delivered 1 --to boris/);
  assert.equal((await bridgeTick(cfg, agents)).written, 0, "druhý beh tú istú udalosť nepošle");
});

test("poistka: handoff_stale na úlohe, ktorú riešiteľ medzitým prevzal, nepošle nič", async () => {
  const { cfg, db, agents, box, borisBox } = setup();
  await bridgeTick(cfg, agents);
  db.prepare("UPDATE tasks SET status = 'in_progress'").run();
  db.prepare("INSERT INTO events (task_id, at, actor, kind, detail) VALUES (1, 9, 'tasker', 'handoff_stale', 'x')").run();
  assert.equal((await bridgeTick(cfg, agents)).written, 0);
  assert.deepEqual([msgs(box), msgs(borisBox)], [[], []]);
  assert.ok(!existsSync(join(cfg.state, "nothing")));
});
