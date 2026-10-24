// Test todo_after_comment.mjs (úloha 425). Dočasná SQLite so schémou Taskera
// (tasks, comments), TASKER_DB ukazuje do tmp, HOME v tmp. Nevolá živý Tasker.
// Replay: úloha 390 a 420 (komentár Huga, ostala v poradí) hook zastaví, ťah bez
// komentára a úloha po done/wait/block pustí.
// Spustenie: node --test hooks/todo_after_comment.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { defaultDb } from "../lib/tasker_read.mjs";
import { turnStart } from "../hooks/todo_after_comment.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "../hooks/todo_after_comment.mjs");
const T0 = Date.parse("2026-10-23T10:00:00Z");

const dir = mkdtempSync(join(tmpdir(), "todo-after-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

// Cesta na živý Tasker sa nesmie dať použiť: test vždy dá TASKER_DB do tmp.
assert.ok(dir.startsWith(tmpdir()) && dir !== dirname(defaultDb(process.env)));

function mkDb(name, tasks, comments) {
  const p = join(dir, name);
  const d = new DatabaseSync(p);
  d.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued',
    assignee TEXT, parent_id INTEGER, priority INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, project TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, author_kind TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  for (const t of tasks) d.prepare("INSERT INTO tasks (id, title, status, assignee) VALUES (?,?,?,?)").run(...t);
  for (const c of comments) d.prepare("INSERT INTO comments (task_id, author_kind, author, body, created_at) VALUES (?,?,?,?,?)").run(c[0], "human", c[1], "x", c[2]);
  d.close();
  return p;
}

function transcript(name, userIso) {
  const p = join(dir, name);
  writeFileSync(p, [
    { type: "user", timestamp: "2026-10-23T09:00:00Z", message: { content: "starý ťah" } },
    { type: "user", timestamp: userIso, message: { content: [{ type: "text", text: "pokyn" }] } },
    { type: "user", timestamp: "2026-10-23T10:05:00Z", message: { content: [{ type: "tool_result", content: "ok" }] } },
  ].map((e) => JSON.stringify(e)).join("\n"));
  return p;
}

function run(db, tr, env = {}) {
  assert.ok(db.startsWith(dir), "DB musí byť v tmp");
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ transcript_path: tr, ...env.input }),
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: dir, TASKER_DB: db, TASKER_USER: "adam", ...env.vars },
  });
  return { ...r, out: r.stdout ? JSON.parse(r.stdout) : null };
}

const tr = () => transcript("t.jsonl", "2026-10-23T10:00:00Z");

test("turnStart vezme poslednú správu s textom, nie tool_result", () => {
  assert.equal(turnStart(readT()), T0);
  function readT() { return [
    { type: "user", timestamp: "2026-10-23T09:00:00Z", message: { content: "a" } },
    { type: "user", timestamp: "2026-10-23T10:00:00Z", message: { content: "b" } },
    { type: "user", timestamp: "2026-10-23T10:05:00Z", message: { content: [{ type: "tool_result" }] } },
  ].map((e) => JSON.stringify(e)).join("\n"); }
});

test("replay 390: komentár v ťahu, podmienka splnená, ostala v poradí, hook zastaví", () => {
  const db = mkDb("a.db", [[390, "Rozhodnutia", "queued", "adam"]], [[390, "adam", T0 + 60000]]);
  const r = run(db, tr());
  assert.equal(r.out.decision, "block");
  assert.match(r.out.reason, /390 \(Rozhodnutia\)/);
  assert.match(r.out.reason, /Správny postup: .*tasker done.*tasker wait.*--reason.*--until.*tasker block.*--by/s);
});

test("replay 420: komentár v ťahu, ostala v poradí, hook zastaví", () => {
  const db = mkDb("b.db", [[420, "Nasadenie", "queued", "adam"]], [[420, "adam", T0 + 1000]]);
  assert.equal(run(db, tr()).out.decision, "block");
});

test("bežný ťah bez komentára pustí", () => {
  const db = mkDb("c.db", [[7, "Iná", "queued", "adam"]], []);
  assert.equal(run(db, tr()).stdout, "");
});

test("komentár spred ťahu pustí", () => {
  const db = mkDb("d.db", [[7, "Iná", "queued", "adam"]], [[7, "adam", T0 - 3600000]]);
  assert.equal(run(db, tr()).stdout, "");
});

test("každý zo štyroch stavov v poradí hook zastaví (úloha 496)", () => {
  for (const st of ["queued", "scheduled", "handoff", "unassigned"]) {
    const db = mkDb(`s-${st}.db`, [[9, "x", st, "adam"]], [[9, "adam", T0 + 1]]);
    assert.match(run(db, tr()).stdout, /"decision":\s*"block"|block/, st);
  }
});

test("komentár iného autora, cudzia úloha, úloha v inom stave pustí", () => {
  const db = mkDb("e.db", [[1, "a", "queued", "adam"], [2, "b", "queued", "boris"], [3, "c", "done", "adam"], [4, "d", "blocked", "adam"], [5, "e", "waiting", "adam"]],
    [[1, "boris", T0 + 1], [2, "adam", T0 + 1], [3, "adam", T0 + 1], [4, "adam", T0 + 1], [5, "adam", T0 + 1]]);
  assert.equal(run(db, tr()).stdout, "");
});

test("stop_hook_active, bez TASKER_USER a neexistujúca DB pustí", () => {
  const db = mkDb("f.db", [[390, "x", "queued", "adam"]], [[390, "adam", T0 + 1]]);
  assert.equal(run(db, tr(), { input: { stop_hook_active: true } }).stdout, "");
  assert.equal(run(db, tr(), { vars: { TASKER_USER: "" }, input: { cwd: dir } }).stdout, "", "bez mena a bez persony mlčí");
  assert.equal(run(join(dir, "nie-je.db"), tr()).stdout, "", "neexistujúca DB nesmie hodiť pád");
});

test("vlákno T3 bez TASKER_USER: meno z PERSONA.md v cwd, replay 390 zastaví", () => {
  const db = mkDb("g.db", [[390, "Rozhodnutia", "queued", "adam"]], [[390, "adam", T0 + 60000]]);
  const proj = join(dir, "adam-proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "PERSONA.md"), "# Adam\n\nRole: x\n");
  assert.equal(run(db, tr(), { vars: { TASKER_USER: "" }, input: { cwd: proj } }).out.decision, "block");
});

test("DB Taskera z TASKER_HOME v runtime.env agenta, keď TASKER_DB nie je", () => {
  const home = join(dir, "tasker-home");
  mkdirSync(home, { recursive: true });
  const db = mkDb("tasker-home/tasker.db", [[390, "Rozhodnutia", "queued", "adam"]], [[390, "adam", T0 + 60000]]);
  mkdirSync(join(dir, ".config/adam"), { recursive: true });
  writeFileSync(join(dir, ".config/adam/runtime.env"), `TASKER_HOME=${home}\n`);
  const r = run(db, tr(), { vars: { TASKER_DB: "" } });
  assert.equal(r.out?.decision, "block");
  assert.match(r.out.reason, /390/);
  const r2 = run(db, tr(), { vars: { TASKER_DB: "", TASKER_USER: "boris" } });
  assert.equal(r2.stdout, "");
});

test("odkaz na obal tk v postupe: klon repa pravidiel z AGENT_RULES_REPO", () => {
  const db = mkDb("rules.db", [[390, "Rozhodnutia", "queued", "adam"]], [[390, "adam", T0 + 60000]]);
  const r = run(db, tr(), { vars: { AGENT_RULES_REPO: "/srv/pravidla" } });
  assert.match(r.out.reason, /`\/srv\/pravidla\/bin\/tk \.\.\.`/);
});
