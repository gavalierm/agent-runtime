// Opravy 23. 10. 2026: most a vlákno témy, most a dispečer, osirelé úlohy,
// dávka v tick(), pretek sledovača /clear, mutex. Všetko v tmp, bez živých služieb.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { startFakeT3 } from "./fake_t3.mjs";
import { T3Client, serial } from "../lib.mjs";
import { tick as taskerTick, bridgeTick } from "../tasker_events.mjs";
import { tick as driverTick } from "../driver.mjs";
import { watchStep } from "../clear_watch.mjs";
import { setTopic } from "../route.mjs";

function boxes(...names) {
  const root = mkdtempSync(join(tmpdir(), "adam-fix-"));
  const out = { root };
  for (const n of names) {
    out[n] = join(root, n);
    for (const d of ["inbox", "outbox", "processed"]) mkdirSync(join(out[n], d), { recursive: true });
  }
  return out;
}

const SCHEMA = `
  CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT, status TEXT, assignee TEXT, project TEXT);
  CREATE TABLE agents (name TEXT PRIMARY KEY, enabled INTEGER NOT NULL);
  CREATE TABLE runs (id INTEGER PRIMARY KEY, task_id INTEGER, agent_summary TEXT);
  CREATE TABLE comments (id INTEGER PRIMARY KEY, task_id INTEGER, author_kind TEXT, author TEXT, body TEXT, created_at INTEGER);
  CREATE TABLE events (id INTEGER PRIMARY KEY, task_id INTEGER, run_id INTEGER, at INTEGER NOT NULL,
    actor TEXT NOT NULL, kind TEXT NOT NULL, from_status TEXT, to_status TEXT, detail TEXT, quiet INTEGER NOT NULL DEFAULT 0);
  INSERT INTO events (task_id, at, actor, kind) VALUES (0, 1, 'x', 'created');`;

function setup(extra = []) {
  const b = boxes("adam", "boris", ...extra);
  const cfg = { name: "adam", box: b.adam, state: join(b.root, "state"), taskerDb: join(b.root, "tasker.db"), taskerHome: "/h/.tasker", topicsFile: join(b.root, "topics.json") };
  const db = new DatabaseSync(cfg.taskerDb);
  db.exec(SCHEMA);
  const task = db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?, ?)");
  const ev = db.prepare("INSERT INTO events (task_id, at, actor, kind, from_status, to_status, detail) VALUES (?, 2, ?, ?, ?, ?, ?)");
  const comment = db.prepare("INSERT INTO comments (task_id, author_kind, author, body, created_at) VALUES (?, 'human', ?, ?, 3)");
  const read = (box) => readdirSync(join(box, "inbox")).sort().map((n) => ({ n, t: readFileSync(join(box, "inbox", n), "utf8") }));
  return { ...b, cfg, db, task, ev, comment, read };
}

// 1a
test("most: správa pre agenta dostane tému zo zoznamu tém jeho schránky, Boris bez zoznamu tému nemá", async () => {
  const s = setup(["agent"]);
  const { cfg, db, task, ev } = s;
  const agents = [{ name: "boris", box: s.boris }, { name: "agent", box: s.agent }];
  writeFileSync(join(s.boris, "topics.json"), "{}");
  setTopic({ box: s.agent }, "projekt_a", "thr-k");
  // Zoznam hlavného vlákna s touto témou pre agenta nesmie platiť.
  setTopic(cfg, "projekt_a", "thr-adam-k");
  assert.match((await bridgeTick(cfg, agents)).reason, /most začína/);
  task.run(1, "Pre agenta", "", "handoff", "agent", "projekt_a");
  task.run(2, "Pre Borisa", "", "handoff", "boris", "projekt_a");
  ev.run(1, "human:operator", "created", null, "handoff", null);
  ev.run(2, "human:operator", "created", null, "handoff", null);
  const r = await bridgeTick(cfg, agents);
  assert.equal(r.written, 2);
  assert.match(s.read(s.agent)[0].n, /^tasker-projekt_a-\d{8}-\d{6}-/);
  assert.match(s.read(s.boris)[0].n, /^tasker-\d{8}-\d{6}-/);
  db.close();
});

// 1b
async function driverSetup(t) {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  const b = boxes("box");
  const state = join(b.root, "state");
  mkdirSync(state);
  writeFileSync(join(state, "thread_id"), "thr-adam\n");
  const cfg = { name: "adam", box: b.box, state, t3Url: t3.url, pollMs: 10 };
  const client = new T3Client({ url: t3.url, token: t3.token, timeoutMs: 3000 });
  let n = 0;
  const put = (name, text) => {
    const p = join(b.box, "inbox", name);
    writeFileSync(p, text);
    const d = new Date(Date.now() - 100000 + n++ * 1000);
    utimesSync(p, d, d);
  };
  return { t3, cfg, client, put, box: b.box };
}

test("budič: správa Taskera o úlohe #N ide do vlákna s #N v titulku, aj v projekte MCP", async (t) => {
  const { t3, cfg, client, put } = await driverSetup(t);
  t3.addThread("thr-adam", { projectId: "p1" });
  t3.addThread("mcp:70", { title: "Tasker #70", projectId: "p1" });
  t3.addThread("mcp:x", { title: "projekt_d #7", projectId: "mcp:p3" });
  put("tasker-20261023-120000-1.md", "odpoveď: nečakám\nTasker: úloha #7 pre teba, úloha je v poradí.\nNázov: x\n");
  const r = await driverTick(cfg, client);
  assert.equal(r.sent, 1);
  assert.equal(t3.state.messages.at(-1).threadId, "mcp:x");
});

test("budič: vlákno #N iného agenta ani sub-agenta sa nevyberie, bez zhody ide správa do hlavného", async (t) => {
  const { t3, cfg, client, put } = await driverSetup(t);
  const boris = join(dirname(cfg.state), "boris");
  mkdirSync(boris);
  writeFileSync(join(boris, "thread_id"), "thr-boris\n");
  t3.addThread("thr-adam", { projectId: "p1" });
  t3.addThread("thr-boris", { projectId: "p2" });
  t3.addThread("mcp:70", { title: "Tasker #70", projectId: "p1" });
  t3.addThread("thr-boris-7", { title: "Boris #7", projectId: "p2" });
  t3.addThread("thread:provider:sub", { title: "Úloha #7 sub-agent", projectId: "p1" });
  put("tasker-20261023-120000-1.md", "odpoveď: nečakám\nTasker: úloha #7 pre teba.\n");
  put("tasker-20261023-120001-2.md", "odpoveď: nečakám\nNiečo iné ako úloha #7.\n");
  const r = await driverTick(cfg, client);
  assert.equal(r.sent, 2);
  assert.deepEqual(t3.state.messages.map((m) => m.threadId), ["thr-adam"]);
});

// 2
test("most: agent s enabled=1 v Taskeri správu nedostane, enabled=0 áno, bez tabuľky agents ako doteraz", async () => {
  const s = setup();
  const { cfg, db, task, ev } = s;
  const agents = [{ name: "boris", box: s.boris }, { name: "adam", box: s.adam }];
  await bridgeTick(cfg, agents);
  db.exec("INSERT INTO agents VALUES ('boris', 1), ('adam', 0)");
  task.run(1, "Pre Borisa", "", "handoff", "boris", null);
  task.run(2, "Pre Adama", "", "handoff", "adam", null);
  ev.run(1, "human:operator", "created", null, "handoff", null);
  ev.run(2, "human:operator", "created", null, "handoff", null);
  const r = await bridgeTick(cfg, agents);
  assert.equal(r.written, 1);
  assert.deepEqual(s.read(s.boris), []);
  assert.match(s.read(s.adam)[0].t, /úloha #2 pre teba/);
  db.close();
});

// 3
test("most: úloha agenta s enabled=0 bez mosta ide vlastníkovi do jeho schránky raz", async () => {
  const s = setup();
  const { cfg, db, task, ev, comment } = s;
  const agents = [{ name: "boris", box: s.boris }, { name: "adam", box: s.adam }];
  await bridgeTick(cfg, agents);
  db.exec("INSERT INTO agents VALUES ('boris', 0), ('adam', 0), ('dev', 0), ('kvapka', 1)");
  setTopic(cfg, "proj", "thr-p");
  task.run(1, "Pre dev", "Telo", "handoff", "dev", "proj");
  task.run(2, "Pre kvapku", "", "handoff", "kvapka", null);
  ev.run(1, "human:operator", "created", null, "handoff", null);
  ev.run(1, "human:operator", "assigned", null, null, "dev");
  ev.run(2, "human:operator", "created", null, "handoff", null);
  const r = await bridgeTick(cfg, agents);
  assert.equal(r.written, 1, "jedna správa na úlohu, dispečerov agent s enabled=1 nič");
  const [m] = s.read(s.adam);
  assert.match(m.n, /^tasker-proj-\d{8}-\d{6}-/);
  assert.match(m.t, /^odpoveď: nečakám\nTasker: úloha #1 pre agenta dev, ktorý je vypnutý a nemá most, nikto ju nespustí\.\nOdkaz: http:\/\/127\.0\.0\.1:8801\/tasks\/1\nNázov: Pre dev\nStav: handoff\nProjekt: proj\n/);
  assert.match(m.t, /Detail: AGENT_NAME=dev \/opt\/agentic-workflow\/bin\/tk task show 1 --json/);
  assert.doesNotMatch(m.t, /runuser/);
  assert.deepEqual(s.read(s.boris), []);
  // Komentár iného autora na úlohe vypnutého agenta nesie text komentára.
  comment.run(1, "operator", "Prosím rýchlo.");
  ev.run(1, "human:operator", "comment", null, null, null);
  db.prepare("UPDATE tasks SET status = 'handoff' WHERE id = 1").run();
  assert.equal((await bridgeTick(cfg, agents)).written, 1);
  assert.match(s.read(s.adam).map((m) => m.t).join("\n"), /Posledný komentár \(operator,[^)]*\):\nProsím rýchlo\./);
  db.close();
});

test("most: komentár cudzieho človeka na koncovej úlohe alebo úlohe bez riešiteľa ide vlastníkovi, ostatné nič", async () => {
  const s = setup();
  const { cfg, db, task, ev, comment } = s;
  const agents = [{ name: "boris", box: s.boris }, { name: "adam", box: s.adam }];
  await bridgeTick(cfg, agents);
  db.exec("INSERT INTO agents VALUES ('boris', 0), ('adam', 0)");
  task.run(1, "Hotová", "", "done", "boris", null);
  task.run(2, "Nikoho", "", "handoff", null, null);
  task.run(3, "Beží", "", "in_progress", "boris", null);
  task.run(4, "Zrušená", "", "cancelled", "boris", null);
  comment.run(1, "operator", "Ešte jedna vec.");
  ev.run(1, "human:operator", "comment", null, null, null);
  comment.run(2, "operator", "Kto to vezme?");
  ev.run(2, "human:operator", "comment", null, null, null);
  ev.run(3, "human:operator", "comment", null, null, null); // nekoncová úloha s riešiteľom, nezobudí ju tento tok
  ev.run(4, "run:5", "comment", null, null, null);
  ev.run(4, "tasker", "comment", null, null, null);
  ev.run(4, "human:adam", "comment", null, null, null);
  ev.run(4, "human:boris", "comment", null, null, null);
  const r = await bridgeTick(cfg, agents);
  const msgs = s.read(s.adam);
  assert.equal(r.written, 3, "2 správy pre vlastníka + 1 most pre Borisa (komentár na nekoncovej úlohe)");
  const own = msgs.map((m) => m.t);
  assert.equal(own.length, 2);
  assert.match(own.join("\n"), /^odpoveď: nečakám\nTasker: úloha #1, komentár od operator nikoho nezobudí \(stav done, riešiteľ boris\)\.\n/m);
  assert.match(own.join("\n"), /Ešte jedna vec\./);
  assert.match(own.join("\n"), /komentár od operator nikoho nezobudí \(stav handoff, riešiteľ nikto\)\./);
  assert.match(own.join("\n"), /Prácu z neho zadaj novou úlohou alebo úlohu otvor \(tasker reopen\), ak treba\./);
  assert.equal(s.read(s.boris).length, 1);
  db.close();
});

// 4
test("tick: done zavreté agentom sa do dávky nerátajú, needs_human ide ako správa na úlohu", async () => {
  const s = setup();
  const { cfg, db, ev } = s;
  await taskerTick(cfg);
  for (let i = 1; i <= 6; i++) {
    db.prepare("INSERT INTO tasks VALUES (?, 't', '', 'done', 'dev', NULL)").run(10 + i);
    ev.run(10 + i, "human:adam", "created", null, "handoff", null);
    ev.run(10 + i, "human:adam", "status", "in_progress", "done", null);
  }
  db.prepare("INSERT INTO tasks VALUES (30, 'čaká', '', 'needs_human', 'dev', NULL)").run();
  ev.run(30, "run:1", "status", "in_progress", "needs_human", null);
  const r = await taskerTick(cfg);
  assert.equal(r.written, 1);
  const [m] = s.read(s.adam);
  assert.match(m.t, /^odpoveď: čakám\nTasker: úloha #30 čaká na človeka/);
  assert.doesNotMatch(m.t, /prechodov úloh naraz/);
  db.close();
});

test("tick: dávka s needs_human alebo failed budí (čakám), dávka len z done je na vedomie", async () => {
  const s = setup();
  const { cfg, db, ev } = s;
  await taskerTick(cfg);
  for (let i = 1; i <= 6; i++) {
    db.prepare("INSERT INTO tasks VALUES (?, 't', '', 'needs_human', 'dev', NULL)").run(i);
    ev.run(i, "run:1", "status", "in_progress", "needs_human", null);
  }
  const r = await taskerTick(cfg);
  assert.equal(r.written, 1);
  assert.match(s.read(s.adam)[0].t, /^odpoveď: čakám\nTasker: 6 prechodov úloh naraz/);
  const first = s.read(s.adam).length;
  assert.equal(first, 1);
  for (let i = 21; i <= 27; i++) {
    db.prepare("INSERT INTO tasks VALUES (?, 't', '', 'done', 'dev', NULL)").run(i);
    ev.run(i, "human:operator", "created", null, "handoff", null);
    ev.run(i, "run:1", "status", "in_progress", "done", null);
  }
  // Úlohy založil operátor, nie vlastník: done sa neposiela. Založené vlastníkom a zavreté behom idú.
  const r2 = await taskerTick(cfg);
  assert.equal(r2.written, 0);
  for (let i = 31; i <= 37; i++) {
    db.prepare("INSERT INTO tasks VALUES (?, 't', '', 'done', 'dev', NULL)").run(i);
    ev.run(i, "human:adam", "created", null, "handoff", null);
    ev.run(i, "run:1", "status", "in_progress", "done", null);
  }
  const r3 = await taskerTick(cfg);
  assert.equal(r3.written, 1);
  assert.match(s.read(s.adam).map((m) => m.t).join("\n"), /odpoveď: na vedomie\nTasker: 7 prechodov úloh naraz/);
  db.close();
});

// 5
test("sledovač: nový beh medzi posúdením a /clear znamená, že sa /clear nepošle a beh sa posúdi nabudúce", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  const root = mkdtempSync(join(tmpdir(), "clear-race-"));
  const state = join(root, "adam");
  mkdirSync(state);
  writeFileSync(join(state, "thread_id"), "thr-adam\n");
  const cfg = { name: "adam", state, pollMs: 10 };
  const real = new T3Client({ url: t3.url, token: t3.token, timeoutMs: 3000 });
  t3.addThread("thr-adam");
  t3.addThread("thr-tema", { title: "tema" });
  assert.equal((await watchStep(cfg, real))[0].action, "baseline");
  const dispatch = (text) => real.dispatch({ type: "message.dispatch", commandId: "c-" + Math.random(), messageId: "m", createdBy: "user", creationSource: "web", threadId: "thr-tema", text, attachments: [], dispatchMode: { type: "queue_after_active" } });
  await dispatch("práca");
  t3.finishRun("thr-tema", { reply: "Hotovo.\nHOTOVO-KONTEXT", usedTokens: 1 });
  // Klient po vrátení detailu spustí vo vlákne nový beh, ako keby prišla správa.
  let raced = false;
  const client = new Proxy(real, {
    get(target, prop) {
      if (prop !== "threadDetail") { const v = target[prop]; return typeof v === "function" ? v.bind(target) : v; }
      return async (id) => {
        const d = await target.threadDetail(id);
        if (!raced) { raced = true; await dispatch("nová správa"); }
        return d;
      };
    },
  });
  const r = await watchStep(cfg, client);
  assert.deepEqual(r, []);
  assert.equal(t3.state.messages.filter((m) => m.text === "/clear").length, 0, "žiadny /clear");
  const st = JSON.parse(readFileSync(join(state, "clear_watch.json"), "utf8"));
  assert.equal(st.checked["thr-tema"], undefined, "beh sa neposúdil");
  assert.deepEqual(st.pending, {});
  // Nový beh skončí bez slova, ďalší priechod ho posúdi a nič nepošle.
  t3.finishRun("thr-tema", { reply: "Robím." });
  assert.deepEqual(await watchStep(cfg, client), []);
  assert.equal(JSON.parse(readFileSync(join(state, "clear_watch.json"), "utf8")).checked["thr-tema"], t3.state.threads.get("thr-tema").latestRunId);
});

test("serial: dve súbežné úlohy s await sa neprekryjú a chyba jednej druhú nezastaví", async () => {
  const run = serial();
  const log = [];
  const job = (name, ms, fail = false) => run(async () => {
    log.push(`start ${name}`);
    await sleep(ms);
    log.push(`end ${name}`);
    if (fail) throw new Error("x");
    return name;
  });
  const a = job("a", 30, true);
  const b = job("b", 1);
  await assert.rejects(a, /x/);
  assert.equal(await b, "b");
  assert.deepEqual(log, ["start a", "end a", "start b", "end b"]);
});
