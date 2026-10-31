import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync as mkdtempRaw, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, chmodSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { startFakeT3 } from "./fake_t3.mjs";
import { T3Client, writeInbox, parseHeader } from "../lib.mjs";
import { tick as taskerTick, bridgeTick } from "../tasker_events.mjs";
import { build as morningBuild } from "../morning.mjs";
import { start, startPrompt } from "../start_agent.mjs";
import { workflowDir } from "../lib/paths.mjs";

// Dočasné priečinky testu sa na konci zmažú (úloha 701).
const tmpDirs = [];
const mkdtempSync = (prefix) => { const d = mkdtempRaw(prefix); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

// Telo odpovede nesie povinné riadky Výsledok, Dôkaz a Otvorené (reply.sh).
const TRI = "Výsledok: v\nDôkaz: d\nOtvorené: nič\n";

const RUNTIME = join(dirname(fileURLToPath(import.meta.url)), "..");

function boxDir() {
  const root = mkdtempSync(join(tmpdir(), "adam-rt-"));
  const box = join(root, "box");
  for (const d of ["inbox", "outbox", "processed"]) mkdirSync(join(box, d), { recursive: true });
  return { root, box, state: join(root, "state") };
}

function taskerDb(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT, assignee TEXT, project TEXT);
    CREATE TABLE runs (id INTEGER PRIMARY KEY, task_id INTEGER, agent_summary TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY, task_id INTEGER, run_id INTEGER, at INTEGER NOT NULL,
      actor TEXT NOT NULL, kind TEXT NOT NULL, from_status TEXT, to_status TEXT, detail TEXT, quiet INTEGER NOT NULL DEFAULT 0);
    INSERT INTO tasks VALUES (1, 'Prvá', 'handoff', 'dev', NULL), (2, 'Druhá', 'handoff', 'dev', NULL);
    INSERT INTO events (task_id, at, actor, kind, from_status, to_status) VALUES (1, 1, 'tasker', 'status', 'handoff', 'needs_human');`);
  return db;
}

test("tasker_events: prvý beh začne od konca, potom pošle len needs_human a failed a nič dvakrát", async () => {
  const { root, box, state } = boxDir();
  const cfg = { name: "adam", box, state, taskerDb: join(root, "tasker.db") };
  const db = taskerDb(cfg.taskerDb);
  assert.match((await taskerTick(cfg)).reason, /začínam od udalosti 1/);
  assert.deepEqual(readdirSync(join(box, "inbox")), []);
  const ins = db.prepare("INSERT INTO events (task_id, at, actor, kind, from_status, to_status) VALUES (?, ?, ?, ?, ?, ?)");
  ins.run(1, 2, "run:5", "status", "handoff", "in_progress");
  ins.run(1, 3, "run:5", "status", "in_progress", "needs_human");
  ins.run(2, 4, "tasker", "comment", null, null);
  ins.run(2, 5, "tasker", "status", "in_progress", "failed");
  ins.run(2, 6, "tasker", "status", "failed", "handoff");
  db.prepare("INSERT INTO events (task_id, at, actor, kind, from_status, to_status, quiet) VALUES (2, 7, 'human:operator', 'status', 'handoff', 'failed', 1)").run();
  db.prepare("INSERT INTO runs (task_id, agent_summary) VALUES (1, 'Chýba heslo k API.')").run();
  const r = await taskerTick(cfg);
  assert.equal(r.written, 2);
  const files = readdirSync(join(box, "inbox")).sort();
  assert.ok(files.every((f) => /^tasker-\d{8}-\d{6}-/.test(f)));
  const texts = files.map((f) => readFileSync(join(box, "inbox", f), "utf8"));
  assert.ok(texts.every((t) => t.startsWith("odpoveď: čakám\n")), "needs_human a failed budia");
  assert.match(texts.join("\n"), /#1 čaká na človeka \(in_progress -> needs_human\)/);
  assert.match(texts.join("\n"), /Chýba heslo k API\./);
  assert.match(texts.join("\n"), /#2 zlyhala/);
  assert.equal(readFileSync(join(state, "tasker_events_last_id"), "utf8").trim(), "7", "kurzor prejde aj cez tichú udalosť");
  assert.equal((await taskerTick(cfg)).written, 0);
  // Prechod do done ide na vedomie, len keď úlohu založil agent sám.
  db.prepare("INSERT INTO tasks VALUES (3, 'Moja', 'in_progress', 'boris', NULL), (4, 'Cudzia', 'in_progress', 'boris', NULL)").run();
  const ev = db.prepare("INSERT INTO events (task_id, at, actor, kind, from_status, to_status, detail) VALUES (?, ?, ?, ?, ?, ?, ?)");
  ev.run(3, 7, "human:adam", "created", null, "handoff", null);
  ev.run(4, 8, "human:operator", "created", null, "handoff", null);
  ev.run(3, 9, "human:boris", "status", "in_progress", "done", "Kľúč pridaný.");
  ev.run(4, 10, "human:boris", "status", "in_progress", "done", null);
  const r2 = await taskerTick(cfg);
  assert.equal(r2.written, 1);
  const done = readFileSync(join(box, "inbox", r2.names[0]), "utf8");
  assert.match(done, /^odpoveď: na vedomie\nTasker: úloha #3, ktorú si založil, je hotová \(in_progress -> done\)\./);
  assert.match(done, /Zhrnutie: Kľúč pridaný\./);
  assert.match(done, /tasker task show 3 --json/);
  assert.equal(readFileSync(join(state, "tasker_events_last_id"), "utf8").trim(), "11");
  db.close();
});

test("tasker_events most: úloha agenta vo vlákne ide do jeho schránky raz, cudzia a koncová nie", async () => {
  const { root, box, state } = boxDir();
  const borisBox = join(root, "boris");
  mkdirSync(join(borisBox, "inbox"), { recursive: true });
  const cfg = { name: "adam", box, state, taskerDb: join(root, "tasker.db"), taskerHome: "/h/.tasker" };
  const db = new DatabaseSync(cfg.taskerDb);
  db.exec(`
    CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT, status TEXT, assignee TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, task_id INTEGER, author_kind TEXT, author TEXT, body TEXT, created_at INTEGER);
    CREATE TABLE events (id INTEGER PRIMARY KEY, task_id INTEGER, run_id INTEGER, at INTEGER NOT NULL,
      actor TEXT NOT NULL, kind TEXT NOT NULL, from_status TEXT, to_status TEXT, detail TEXT, quiet INTEGER NOT NULL DEFAULT 0);
    INSERT INTO events (task_id, at, actor, kind) VALUES (0, 1, 'x', 'created');`);
  const agents = [{ name: "boris", box: borisBox }];
  assert.match((await bridgeTick(cfg, agents)).reason, /most začína od udalosti 1/);
  const task = db.prepare("INSERT INTO tasks VALUES (?, ?, ?, ?, ?)");
  const ev = db.prepare("INSERT INTO events (task_id, at, actor, kind, to_status, detail) VALUES (?, 2, ?, ?, ?, ?)");
  task.run(1, "Nový kľúč", "Pridaj deploy kľúč.", "handoff", "boris");
  ev.run(1, "human:adam", "created", "handoff", null);
  ev.run(1, "human:adam", "assigned", null, "boris");
  task.run(2, "Cudzia", "", "handoff", "dev");
  ev.run(2, "human:adam", "created", "handoff", null);
  task.run(3, "Čaká na blokér", "", "blocked", "boris");
  ev.run(3, "human:adam", "created", "blocked", null);
  task.run(4, "Hotová", "", "done", "boris");
  ev.run(4, "human:adam", "comment", null, null);
  task.run(5, "Import", "", "handoff", "boris");
  db.prepare("INSERT INTO events (task_id, at, actor, kind, to_status, quiet) VALUES (5, 2, 'human:operator', 'created', 'handoff', 1)").run();
  let r = await bridgeTick(cfg, agents);
  assert.equal(r.written, 1);
  const [f] = readdirSync(join(borisBox, "inbox"));
  assert.match(f, /^tasker-\d{8}-\d{6}-/);
  const text = readFileSync(join(borisBox, "inbox", f), "utf8");
  assert.match(text, /^odpoveď: nečakám\n/, "most budí, odpoveď nečaká");
  assert.match(text, /úloha #1 pre teba, úloha je v poradí/);
  assert.match(text, /Pridaj deploy kľúč\./);
  assert.match(text, /AGENT_NAME=boris \/opt\/agentic-workflow\/bin\/tk done 1 --summary/);
  assert.doesNotMatch(text, /runuser/);
  assert.deepEqual(readdirSync(join(box, "inbox")), []);
  assert.equal((await bridgeTick(cfg, agents)).written, 0);
  db.prepare("INSERT INTO comments (task_id, author_kind, author, body, created_at) VALUES (1, 'human', 'boris', 'Robím.', 3)").run();
  ev.run(1, "human:boris", "comment", null, null);
  assert.equal((await bridgeTick(cfg, agents)).written, 0);
  db.prepare("INSERT INTO comments (task_id, author_kind, author, body, created_at) VALUES (1, 'human', 'adam', 'Aj druhý server.', 4)").run();
  ev.run(1, "human:adam", "comment", null, null);
  db.prepare("UPDATE tasks SET status = 'handoff' WHERE id = 3").run();
  ev.run(3, "tasker", "status", "handoff", null);
  r = await bridgeTick(cfg, agents);
  assert.equal(r.written, 2);
  const all = readdirSync(join(borisBox, "inbox")).map((n) => readFileSync(join(borisBox, "inbox", n), "utf8")).join("\n");
  assert.match(all, /#1 pre teba, nový komentár \(adam\)[\s\S]*Aj druhý server\./);
  assert.match(all, /#3 pre teba, úloha je v poradí/);
  db.close();
});

test("morning: súhrn Taskera aj chyba tasker summary skončia v správe", () => {
  const cfg = { taskerBin: "/x/tasker", taskerHome: "/h", taskerDb: "/h/tasker.db" };
  let args;
  const ok = morningBuild(cfg, (bin, a, o) => { args = [bin, a, o.env.TASKER_HOME]; return "## Hotové\n- #1\n"; });
  assert.deepEqual(args, ["/x/tasker", ["summary", "--since", "24h"], "/h"]);
  assert.match(ok, /Ranný súhrn/);
  assert.match(ok, /## Hotové/);
  const bad = morningBuild(cfg, () => { const e = new Error("x"); e.stderr = "DB chýba"; throw e; });
  assert.match(bad, /tasker summary zlyhal: DB chýba/);
});

test("writeInbox: riadok hlavičky podľa mode, bez mode nič", () => {
  const { box } = boxDir();
  const a = writeInbox(box, "ranny", "súhrn", null, "nečakám");
  assert.equal(readFileSync(join(box, "inbox", a), "utf8"), "odpoveď: nečakám\nsúhrn\n");
  const b = writeInbox(box, "x", "telo\n");
  assert.equal(readFileSync(join(box, "inbox", b), "utf8"), "telo\n");
  assert.deepEqual(parseHeader("odpoveď: nečakám\nsúhrn\n"), { mode: "nečakám", original: null, meta: null, body: "súhrn\n" });
  assert.deepEqual(parseHeader("odpoveď: xyz\nsúhrn\n"), { mode: null, original: null, meta: null, body: "odpoveď: xyz\nsúhrn\n" });
});

test("parseHeader: blok id, od, komu, téma, k sa odstráni z tela, k správe ostáva pôvodný režim", () => {
  const r = parseHeader("odpoveď: na vedomie\nk správe: čakám\nid: cyril-a-1.md\nod: cyril\nkomu: adam\ntéma: a\nk: adam-a-0.md\nTelo\n");
  assert.deepEqual(r, { mode: "na vedomie", original: "čakám", meta: { id: "cyril-a-1.md", od: "cyril", komu: "adam", tema: "a", k: "adam-a-0.md" }, body: "Telo\n" });
  assert.equal(parseHeader("odpoveď: čakám\nid: x.md\nod: a\nkomu: b\ntéma: \nTelo").meta.tema, "");
  assert.equal(parseHeader("odpoveď: čakám\nTelo\nid: x\n").meta, null, "riadok id v tele nie je hlavička");
});

test("start_agent: založí projekt a vlákno, druhý beh nerobí nič, --new založí nové", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  const { state } = boxDir();
  const cfg = { state };
  const client = new T3Client({ url: t3.url, token: t3.token, timeoutMs: 3000 });
  const env = { AGENT_MODEL: "claude-test", AGENT_WORKDIR: "/root/adam" };
  await assert.rejects(start(cfg, client, {}), /AGENT_MODEL/);
  const r = await start(cfg, client, env);
  assert.equal(r.created, true);
  assert.equal(readFileSync(join(state, "thread_id"), "utf8").trim(), r.threadId);
  assert.equal(t3.state.projects.length, 1);
  assert.equal(t3.state.projects[0].workspaceRoot, "/root/adam");
  const l = t3.state.launches[0];
  assert.deepEqual(l.modelSelection, { instanceId: "claudeAgent", model: "claude-test" });
  assert.equal(l.runtimeMode, "auto");
  assert.deepEqual(l.workspaceStrategy, { type: "root" });
  assert.equal(l.initialMessage.text, startPrompt("Agent", `AGENT_NAME=agent ${join(workflowDir(), "reply.sh")}`));
  assert.equal((await start(cfg, client, env)).created, false);
  assert.equal(t3.state.launches.length, 1);
  const r2 = await start(cfg, client, env, { forceNew: true });
  assert.notEqual(r2.threadId, r.threadId);
  assert.equal(t3.state.projects.length, 1, "existujúci projekt sa použije znova");
});

test("reply.sh: odpoveď odosielateľovi z AGENT_INBOX_ONLY ide len do jeho schránky, prepínače a zábrana", () => {
  const { root, box } = boxDir();
  // Server: /var/lib/cyril je schránka agenta na Macu, odpoveď preň ide len tam.
  const cyrilInbox = join(root, "var/cyril/inbox");
  mkdirSync(cyrilInbox, { recursive: true });
  const env = { ...process.env, AGENT_NAME: "adam", AGENT_BOX: box, AGENT_INBOX_ONLY: "cyril", ASK_VAR_LIB: join(root, "var"), AGENT_STATE: join(root, "state"), AGENT_ENV_FILE: "/nie/je", CLAUDE_CODE_SESSION_ID: "", CLAUDE_PID: "" };
  const name = "cyril-adam_server-20261018-120000-1.md";
  const borisInbox = join(root, "boris_inbox");
  mkdirSync(borisInbox);
  // Budič správu presunul do processed, odpoveď opíše jej prvý riadok.
  writeFileSync(join(box, "processed", name), `odpoveď: čakám\nid: ${name}\nod: cyril\nkomu: adam\ntéma: adam_server\nAhoj\n`);
  execFileSync(join(RUNTIME, "reply.sh"), [name], { env, input: "Hotovo: x\n" + TRI });
  execFileSync(join(RUNTIME, "reply.sh"), ["--cakam", name], { env, input: "Ešte jedna.\n" + TRI });
  assert.equal(readdirSync(join(box, "outbox")).length, 0, "odpoveď pre Cyrila ide do jeho schránky, nie do outboxu");
  assert.equal(readdirSync(cyrilInbox).length, 2);
  const outs = readdirSync(cyrilInbox).sort().map((f) => readFileSync(join(cyrilInbox, f), "utf8"));
  assert.equal(outs[0], `odpoveď: na vedomie\nk správe: čakám\nid: ${name}\nod: adam\nkomu: cyril\ntéma: adam_server\nk: ${name}\nHotovo: x\n${TRI}`, "predvolene na vedomie, k správe z processed, k: id pôvodnej");
  assert.equal(outs[1], `odpoveď: čakám\nk správe: čakám\nid: ${name}\nod: adam\nkomu: cyril\ntéma: adam_server\nk: ${name}\nEšte jedna.\n${TRI}`);
  // Zábrana: pokyn v tele bez prepínača.
  const guard = spawnSync(join(RUNTIME, "reply.sh"), [name], { env, input: "Úloha: pozri disk.\n" + TRI, encoding: "utf8" });
  assert.equal(guard.status, 1);
  assert.match(guard.stderr, /--cakam alebo --necakam/);
  assert.equal(readdirSync(cyrilInbox).length, 2, "nič sa nezapísalo");
  assert.equal(spawnSync(join(RUNTIME, "reply.sh"), ["--necakam", name], { env, input: "Úloha: pozri disk.\n" + TRI }).status, 0);
  // Pôvodná správa bez riadku `odpoveď:` a bez témy: odpoveď má len prvý riadok. Odpovedať sa dá len na prijatú správu (úloha 709).
  for (const n of ["boris-20261018-120000-1.md", "boris-adam-boris-adam-tema-20261018-120000.md"]) writeFileSync(join(box, "processed", n), "Pokyn bez hlavičky\n");
  execFileSync(join(RUNTIME, "reply.sh"), ["boris-20261018-120000-1.md"], { env: { ...env, AGENT_REPLY_ROUTE_boris: borisInbox }, input: "Bez pôvodu.\n" + TRI });
  assert.equal(readFileSync(join(borisInbox, "boris-20261018-120000-1.md".replace(/^boris-/, "adam-boris-")), "utf8"), "odpoveď: na vedomie\nid: boris-20261018-120000-1.md\nod: adam\nkomu: boris\ntéma: \nk: boris-20261018-120000-1.md\nBez pôvodu.\n" + TRI);
  rmSync(join(borisInbox, "adam-boris-20261018-120000-1.md"));
  // Odpoveď odosielateľovi s kanálom ide aj do jeho schránky.
  execFileSync(join(RUNTIME, "reply.sh"), ["boris-20261018-120000-1.md"], { env: { ...env, AGENT_REPLY_ROUTE_boris: borisInbox }, input: "Pre Borisa.\n" + TRI });
  assert.deepEqual(readdirSync(borisInbox), ["adam-boris-20261018-120000-1.md"]);
  // Odpoveď na odpoveď predpony nehromadí.
  execFileSync(join(RUNTIME, "reply.sh"), ["boris-adam-boris-adam-tema-20261018-120000.md"], { env: { ...env, AGENT_REPLY_ROUTE_boris: borisInbox }, input: "Znova.\n" + TRI });
  assert.ok(readdirSync(borisInbox).includes("adam-boris-tema-20261018-120000.md"));
  assert.equal(spawnSync(join(RUNTIME, "reply.sh"), ["../zle"], { env, input: "x" }).status, 1);
});

test("reply.sh pre iného agenta: AGENT_NAME určí schránku, env súbor a predponu", () => {
  const { root, box } = boxDir();
  const home = join(root, "home");
  mkdirSync(join(home, ".config/boris"), { recursive: true });
  const adamInbox = join(root, "adam_inbox");
  mkdirSync(adamInbox);
  // Ako v nasadení: cesty len v runtime.env agenta, vlákno T3 ich nededí.
  writeFileSync(join(home, ".config/boris/runtime.env"), `AGENT_BOX=${box}\nAGENT_REPLY_ROUTE_adam=${adamInbox}\n`);
  const env = { PATH: process.env.PATH, HOME: home, AGENT_NAME: "boris", CLAUDE_PID: "" };
  // Pôvodné správy prijal Boris, ležia v jeho processed (úloha 709).
  for (const n of ["adam-20261018-120000-1.md", "adam-boris-adam-boris-tema-20261018-120000.md"]) writeFileSync(join(box, "processed", n), "Pokyn bez hlavičky\n");
  execFileSync(join(RUNTIME, "reply.sh"), ["adam-20261018-120000-1.md"], { env, input: "Od Borisa.\n" + TRI });
  assert.deepEqual(readdirSync(join(box, "outbox")), ["adam-20261018-120000-1.md"]);
  assert.deepEqual(readdirSync(adamInbox), ["boris-adam-20261018-120000-1.md"]);
  execFileSync(join(RUNTIME, "reply.sh"), ["adam-boris-adam-boris-tema-20261018-120000.md"], { env, input: "Znova.\n" + TRI });
  assert.ok(readdirSync(adamInbox).includes("boris-adam-tema-20261018-120000.md"));
});

// Úloha 665: vlákno T3 agenta nemá AGENT_NAME, meno nesie PERSONA.md v cwd
// (lib/agent_name.sh). Prostredie je prázdne, schránky a runtime.env sú v tmp.
test("reply.sh bez AGENT_NAME odvodí meno z PERSONA.md: predpona a runtime.env agenta", () => {
  const { root, box } = boxDir();
  const home = join(root, "home");
  mkdirSync(join(home, ".config/delta"), { recursive: true });
  const adamInbox = join(root, "adam_inbox");
  mkdirSync(adamInbox);
  writeFileSync(join(home, ".config/delta/runtime.env"), `AGENT_BOX=${box}\nAGENT_REPLY_ROUTE_adam=${adamInbox}\n`);
  const cwd = join(root, "klon");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "PERSONA.md"), "# Delta\n");
  const env = { PATH: process.env.PATH, HOME: home, CLAUDE_PID: "" };
  writeFileSync(join(box, "processed", "adam-20261018-120000-1.md"), "Pokyn bez hlavičky\n");
  const r = spawnSync(join(RUNTIME, "reply.sh"), ["adam-20261018-120000-1.md"], { env, cwd, input: "Od Delty.\n" + TRI, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(readdirSync(join(box, "outbox")), ["adam-20261018-120000-1.md"]);
  assert.deepEqual(readdirSync(adamInbox), ["delta-adam-20261018-120000-1.md"]);
});

test("ask_agent.sh bez AGENT_NAME odvodí odosielateľa z PERSONA.md, bez mena ohlási PERSONA.md", () => {
  const root = mkdtempSync(join(tmpdir(), "ask-persona-"));
  const inbox = join(root, "boris_inbox");
  mkdirSync(inbox);
  const cwd = join(root, "klon");
  mkdirSync(cwd);
  writeFileSync(join(cwd, "PERSONA.md"), "# Delta\n");
  const env = { PATH: process.env.PATH, HOME: root, AGENT_SEND_boris: inbox, ASK_VAR_LIB: join(root, "var"), CLAUDE_PID: "", CLAUDE_CODE_SESSION_ID: "" };
  const r = spawnSync(join(RUNTIME, "bin/ask_agent.sh"), ["--hlavne", "boris", "Test"], { env, cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const [name] = readdirSync(inbox);
  assert.match(name, /^delta-\d{8}-\d{6}-\d+\.md$/);
  assert.match(readFileSync(join(inbox, name), "utf8"), /^od: delta$/m);
  const prazdny = join(root, "prazdny");
  mkdirSync(prazdny);
  const bez = spawnSync(join(RUNTIME, "bin/ask_agent.sh"), ["--hlavne", "boris", "Test"], { env, cwd: prazdny, encoding: "utf8" });
  assert.equal(bez.status, 1);
  assert.match(bez.stderr, /Chýba odosielateľ.*PERSONA\.md/);
  assert.equal(readdirSync(inbox).length, 1);
});
