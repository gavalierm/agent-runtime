// Ranný súhrn: rozloženie práce za 24 h (úloha 513). DB je dočasná v mkdtemp, git je zástupná
// funkcia, nič sa nečíta zo živej DB ani zo živých repí.
import "../lib/git_isolate.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync as mkdtempRaw, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { workSection } from "../morning.mjs";

// Dočasné priečinky testu sa na konci zmažú (úloha 701).
const tmpDirs = [];
const mkdtempSync = (prefix) => { const d = mkdtempRaw(prefix); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

const NOW = 1_800_000_000_000;
const H = 3600_000;

function fakeDb() {
  const dir = mkdtempSync(join(tmpdir(), "adam-work-"));
  const path = join(dir, "tasker.db");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, project TEXT); CREATE TABLE work (id INTEGER PRIMARY KEY, task_id INTEGER, agent TEXT, thread TEXT, since INTEGER)");
  const t = db.prepare("INSERT INTO tasks (id, project) VALUES (?, ?)");
  t.run(1, "tasker"); t.run(2, "tasker"); t.run(3, null); t.run(4, "agenti");
  const w = db.prepare("INSERT INTO work (task_id, agent, thread, since) VALUES (?, ?, ?, ?)");
  w.run(1, "adam", "s1", NOW - H); w.run(1, "adam", "s2", NOW - 2 * H); w.run(2, "adam", "s2", NOW - 3 * H);
  w.run(3, "adam", "s3", NOW - H); w.run(4, "eva", "s4", NOW - H);
  w.run(4, "eva", "stara", NOW - 30 * H);
  db.close();
  return { dir, path };
}

test("práca po agentovi a projekte: počty úloh a relácií, bez projektu, staré mimo, commity po autorovi", () => {
  const { dir, path } = fakeDb();
  const calls = [];
  const git = (a) => { calls.push(a); return a[1] === dir ? "Adam (server)\nAdam (server)\nEva (server)\n" : ""; };
  const out = workSection({ taskerDb: path, workRepos: [dir, join(dir, "chyba")] }, NOW, { git }).join("\n");
  assert.match(out, /Rozloženie práce za 24 h/);
  assert.match(out, /- adam, bez projektu: 1 úloh, 1 relácií \(3\)/);
  assert.match(out, /- adam, tasker: 2 úloh, 2 relácií \(1, 2\)/);
  assert.match(out, /- eva, agenti: 1 úloh, 1 relácií \(4\)/);
  assert.ok(out.indexOf("adam, bez projektu") < out.indexOf("adam, tasker") && out.indexOf("adam, tasker") < out.indexOf("eva, agenti"));
  assert.match(out, /- Adam \(server\): 2/);
  assert.match(out, /- Eva \(server\): 1/);
  assert.equal(calls.length, 1, "neexistujúci priečinok sa preskočí");
  assert.match(out, /Porovnaj s rolami v roles\/agents\.md, prácu mimo roly agenta hlás operátorovi a presuň\./);
});

test("chýbajúca DB vráti riadok s chybou, nie výnimku, commity idú ďalej", () => {
  const out = workSection({ taskerDb: join(tmpdir(), "adam-neexistuje", "x.db"), workRepos: [] }, NOW, { git: () => "" }).join("\n");
  assert.match(out, /čítanie databázy Taskera zlyhalo/);
  assert.match(out, /Commity za 24 h podľa autora/);
});

test("najviac 10 čísel úloh v riadku", () => {
  const dir = mkdtempSync(join(tmpdir(), "adam-work-"));
  const path = join(dir, "t.db");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, project TEXT); CREATE TABLE work (id INTEGER PRIMARY KEY, task_id INTEGER, agent TEXT, thread TEXT, since INTEGER)");
  for (let i = 1; i <= 12; i++) { db.prepare("INSERT INTO tasks VALUES (?, 'p')").run(i); db.prepare("INSERT INTO work (task_id, agent, thread, since) VALUES (?, 'a', 't', ?)").run(i, NOW - H); }
  db.close();
  const out = workSection({ taskerDb: path, workRepos: [] }, NOW).join("\n");
  assert.match(out, /12 úloh, 1 relácií \(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, ďalšie\)/);
});
