// Ranný súhrn: značka účasti operátora pri hotovej úlohe (úloha 653). Obe DB sú dočasné
// v mkdtemp, nič sa nečíta zo živých DB. Mená sú vymyslené.
import "../lib/git_isolate.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync as mkdtempRaw, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taskIdsInTitle, operatorMark, operatorTasks, markDone, build } from "../morning.mjs";

// Dočasné priečinky testu sa na konci zmažú (úloha 701).
const tmpDirs = [];
const mkdtempSync = (prefix) => { const d = mkdtempRaw(prefix); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

const NOW = Date.parse("2026-10-26T06:00:07Z");
const H = 3600_000;
const ENV = { TASKER_OPERATORS: "adam", AGENT_OPERATOR_NAME: "Adam" };

const SUMMARY = `Úlohy: done 3

## Hotové
- #30 Prvá (eva) [neoverené]
- #44 Druhá (eva) [overené]

## Čaká na človeka
- #30 Tretia (eva)`;

function taskerDb() {
  const dir = mkdtempSync(join(tmpdir(), "adam-done-"));
  const path = join(dir, "tasker.db");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE comments (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, author_kind TEXT, author TEXT, body TEXT NOT NULL, created_at INTEGER NOT NULL)");
  const c = db.prepare("INSERT INTO comments (task_id, author_kind, author, body, created_at) VALUES (?, 'human', ?, ?, ?)");
  c.run(30, "adam", "schválené", NOW - H);
  c.run(31, "eva", "Adam: pridaj test", NOW - 2 * H);
  c.run(32, "eva", "Eva: vlastný komentár", NOW - H);
  c.run(33, "adam", "starý komentár", NOW - 30 * H);
  db.close();
  return path;
}

function t3Db() {
  const dir = mkdtempSync(join(tmpdir(), "adam-done-t3-"));
  const path = join(dir, "state.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, created_at TEXT, payload_json TEXT);
           CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT)`);
  const th = db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?)");
  th.run("t40", "Úloha 40: x");
  th.run("t41", "Úloha 41: y");
  th.run("t42", "Úloha 42");
  th.run("th", "Hlavné");
  const m = db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES (?, ?, ?, ?, ?)");
  let n = 0;
  const add = (thread, ago, text, extra = {}) => {
    const id = `m${++n}`;
    m.run(id, thread, "user", new Date(NOW - ago).toISOString(), JSON.stringify({ createdBy: "user", creationSource: "web", id, text, ...extra }));
  };
  add("t40", H, "pokračuj");
  add("t41", H, "od agenta", { createdBy: "agent" });
  add("t42", 30 * H, "stará správa");
  add("th", H, "ahoj");
  db.close();
  return path;
}

test("taskIdsInTitle: úloha N, #N, uN, holé číslo a slovo s číslom nie", () => {
  const ids = (t) => [...taskIdsInTitle(t)].sort((a, b) => a - b);
  assert.deepEqual(ids("Projekt kolobeh (úloha 14)"), [14]);
  assert.deepEqual(ids("Úloha 614: pamäť"), [614]);
  assert.deepEqual(ids("domovnik #351"), [351]);
  assert.deepEqual(ids("agentic-workflow u621b: hooky"), [621]);
  assert.deepEqual(ids("skuska-casovac-612"), []);
  assert.deepEqual(ids("Eva (hlavné vlákno)"), []);
  assert.deepEqual(ids("úloha 1 a #2"), [1, 2]);
});

test("operatorMark: AGENT_OPERATOR_WITH, meno + om, bez oboch", () => {
  assert.equal(operatorMark({ AGENT_OPERATOR_WITH: "Oskarom", AGENT_OPERATOR_NAME: "Adam" }), "[s Oskarom]");
  assert.equal(operatorMark({ AGENT_OPERATOR_NAME: "Adam" }), "[s Adamom]");
  assert.equal(operatorMark({}), "[s operátorom]");
});

test("operatorTasks: komentáre operátora a správy operátora vo vlákne s číslom úlohy, okno 24 h", () => {
  const { tasks, errors } = operatorTasks({ taskerDb: taskerDb(), t3Db: t3Db() }, NOW, { env: ENV });
  assert.deepEqual(tasks.get(30), ["komentár"]);
  assert.deepEqual(tasks.get(31), ["komentár"]);
  assert.deepEqual(tasks.get(40), ["T3 Úloha 40: x"]);
  for (const id of [32, 33, 41, 42]) assert.equal(tasks.has(id), false, `úloha ${id}`);
  assert.equal(tasks.size, 3);
  assert.deepEqual(errors, []);
});

test("operatorTasks: chýbajúca DB Taskera je chyba, chýbajúca T3 DB sa ticho preskočí", () => {
  const missing = join(tmpdir(), "adam-done-nie", "x.db");
  const a = operatorTasks({ taskerDb: missing, t3Db: t3Db() }, NOW, { env: ENV });
  assert.ok(a.errors.some((e) => e.includes("Tasker: čítanie komentárov zlyhalo")));
  assert.deepEqual(a.tasks.get(40), ["T3 Úloha 40: x"]);
  const b = operatorTasks({ taskerDb: taskerDb(), t3Db: missing }, NOW, { env: ENV });
  assert.deepEqual(b.errors, []);
  assert.deepEqual(b.tasks.get(30), ["komentár"]);
  assert.equal(b.tasks.has(40), false);
});

test("markDone: značka len pri hotovej úlohe s účasťou, počty a zdroje v riadkoch", () => {
  const part = { tasks: new Map([[30, ["komentár"]]]), errors: [] };
  const r = markDone(SUMMARY, part, "[s Adamom]");
  const rows = r.text.split("\n");
  assert.ok(rows.includes("- #30 Prvá (eva) [neoverené] [s Adamom]"));
  assert.ok(rows.includes("- #44 Druhá (eva) [overené]"));
  assert.ok(rows.includes("- #30 Tretia (eva)"));
  assert.equal(rows.filter((l) => l.includes("[s Adamom]")).length, 1);
  assert.ok(r.lines.includes("Hotové [s Adamom], len počet, bez opisu: 1 (úlohy 30)"));
  assert.ok(r.lines.includes("- #30: komentár"));
  assert.ok(r.lines.includes("Hotové bez účasti operátora, do súhrnu s opisom: 1 (úlohy 44)"));
});

test("markDone: bez časti Hotové ostane text nezmenený, chyby z part sa objavia v lines", () => {
  const part = { tasks: new Map([[30, ["komentár"]]]), errors: [] };
  const r = markDone("tasker ok", part, "[s Adamom]");
  assert.equal(r.text, "tasker ok");
  assert.deepEqual(r.lines, []);
  const e = markDone(SUMMARY, { tasks: new Map(), errors: ["Tasker: čítanie komentárov zlyhalo: x"] }, "[s Adamom]");
  assert.ok(e.lines.includes("Tasker: čítanie komentárov zlyhalo: x"));
});

test("build(): pokyn, označený riadok a počet Hotové pred stojacimi úlohami", () => {
  const cfg = { taskerDb: taskerDb(), t3Db: t3Db() };
  const out = build(cfg, () => SUMMARY, NOW, { env: ENV, git: () => "" });
  assert.ok(out.includes("Hotovú úlohu so značkou [s Adamom] uveď len v počte"));
  assert.ok(out.split("\n").includes("- #30 Prvá (eva) [neoverené] [s Adamom]"));
  const count = out.indexOf("Hotové [s Adamom], len počet");
  const stalled = out.indexOf("Úlohy, ktoré v okne 24 h stáli");
  assert.ok(count >= 0 && stalled >= 0);
  assert.ok(count < stalled);
});
