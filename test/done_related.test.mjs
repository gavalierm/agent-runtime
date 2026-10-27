// Test done_related.mjs. Dočasná SQLite so schémou Taskera, TASKER_DB ukazuje
// do tmp, HOME v tmp. Nevolá živý Tasker.
// Replay 27. 10. 2026: 612 (agenti) zavretá v ťahu, 609 needs_human adam bez
// komentára, hook zastaví. Po komentári alebo cancel 609 pustí, iný projekt,
// iný riešiteľ a ťah bez zavretia pustí.
// Spustenie: node --test test/done_related.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { defaultDb } from "../lib/tasker_read.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "../hooks/done_related.mjs");
const T0 = Date.parse("2026-10-27T06:00:00Z");

const dir = mkdtempSync(join(tmpdir(), "done-related-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
assert.ok(dir.startsWith(tmpdir()) && dir !== dirname(defaultDb(process.env)));

// tasks: [id, title, status, assignee, project, updated_at]; comments: [task_id, author, created_at]
function mkDb(name, tasks, comments) {
  const p = join(dir, name);
  const d = new DatabaseSync(p);
  d.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'queued',
    assignee TEXT, parent_id INTEGER, priority INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0, project TEXT);
    CREATE TABLE comments (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, author_kind TEXT NOT NULL, author TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  for (const t of tasks) d.prepare("INSERT INTO tasks (id, title, status, assignee, project, updated_at) VALUES (?,?,?,?,?,?)").run(...t);
  for (const c of comments) d.prepare("INSERT INTO comments (task_id, author_kind, author, body, created_at) VALUES (?,?,?,?,?)").run(c[0], "agent", c[1], "x", c[2]);
  d.close();
  return p;
}

function transcript() {
  const p = join(dir, "t.jsonl");
  writeFileSync(p, [
    { type: "user", timestamp: "2026-10-27T05:00:00Z", message: { content: "starý ťah" } },
    { type: "user", timestamp: "2026-10-27T06:00:00Z", message: { content: [{ type: "text", text: "pokyn" }] } },
    { type: "user", timestamp: "2026-10-27T06:05:00Z", message: { content: [{ type: "tool_result", content: "ok" }] } },
  ].map((e) => JSON.stringify(e)).join("\n"));
  return p;
}

function run(db, env = {}) {
  assert.ok(db.startsWith(dir), "DB musí byť v tmp");
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({ transcript_path: transcript(), ...env.input }),
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: dir, TASKER_DB: db, TASKER_USER: "adam", ...env.vars },
  });
  return { ...r, out: r.stdout ? JSON.parse(r.stdout) : null };
}

const base = () => [
  [612, "Audit T3", "done", "adam", "agenti", T0 + 120000],
  [609, "Vlákna píšu do jedného stromu", "needs_human", "adam", "agenti", T0 - 86400000],
];

test("replay 609: 612 zavretá v ťahu, 609 needs_human bez komentára, hook zastaví", () => {
  const r = run(mkDb("a.db", base(), [[609, "operator", T0 - 50000000]]));
  assert.equal(r.out.decision, "block");
  assert.match(r.out.reason, /609 \(Vlákna píšu do jedného stromu; projekt agenti, zavretá 612\)/);
  assert.match(r.out.reason, /Správny postup: .*tasker cancel <id>.*komentár.*\/bin\/tk/s);
});

test("komentár riešiteľa k 609 v ťahu pustí, komentár spred ťahu nie", () => {
  assert.equal(run(mkDb("b.db", base(), [[609, "adam", T0 + 130000]])).stdout, "");
  assert.equal(run(mkDb("c.db", base(), [[609, "adam", T0 - 1000]])).out.decision, "block");
});

test("609 zrušená alebo v inom projekte, iný riešiteľ, zavretie spred ťahu pustí", () => {
  assert.equal(run(mkDb("d.db", [base()[0], [609, "x", "cancelled", "adam", "agenti", T0 + 1]], [])).stdout, "");
  assert.equal(run(mkDb("e.db", [base()[0], [609, "x", "needs_human", "adam", "web", 0]], [])).stdout, "");
  assert.equal(run(mkDb("f.db", [base()[0], [609, "x", "needs_human", "boris", "agenti", 0]], [])).stdout, "");
  assert.equal(run(mkDb("g.db", [[612, "x", "done", "adam", "agenti", T0 - 1], base()[1]], [])).stdout, "");
  assert.equal(run(mkDb("h.db", [[612, "x", "done", "boris", "agenti", T0 + 1], base()[1]], [])).stdout, "");
});

test("zavretá úloha bez projektu pustí, viac otázok vypíše každú raz", () => {
  assert.equal(run(mkDb("i.db", [[612, "x", "done", "adam", null, T0 + 1], [609, "x", "needs_human", "adam", null, 0]], [])).stdout, "");
  const r = run(mkDb("j.db", [...base(), [616, "y", "done", "adam", "agenti", T0 + 1], [457, "Hosting", "needs_human", "adam", "agenti", 0]], []));
  assert.equal(r.out.decision, "block");
  assert.equal((r.out.reason.match(/\b609 \(/g) || []).length, 1);
  assert.match(r.out.reason, /457 \(Hosting/);
});

test("stop_hook_active, bez mena a neexistujúca DB pustí", () => {
  const db = mkDb("k.db", base(), []);
  assert.equal(run(db, { input: { stop_hook_active: true } }).stdout, "");
  assert.equal(run(db, { vars: { TASKER_USER: "" }, input: { cwd: dir } }).stdout, "");
  assert.equal(run(join(dir, "nie-je.db")).stdout, "");
});
