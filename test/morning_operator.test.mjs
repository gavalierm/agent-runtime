// Ranný súhrn: zásahy operátora za 24 h (úloha 605). Obe DB sú dočasné v mkdtemp,
// nič sa nečíta zo živých DB. Mená sú vymyslené.
import "../lib/git_isolate.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { operatorSection, isOperatorMessage, build } from "../morning.mjs";

const NOW = Date.parse("2026-10-26T06:00:07Z");
const H = 3600_000;
const ENV = { TASKER_OPERATORS: "adam", AGENT_OPERATOR_NAME: "Adam" };

function taskerDb() {
  const dir = mkdtempSync(join(tmpdir(), "adam-op-"));
  const path = join(dir, "tasker.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE events (id INTEGER PRIMARY KEY, task_id INTEGER, at INTEGER NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT);
           CREATE TABLE comments (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, author_kind TEXT, author TEXT, body TEXT NOT NULL, created_at INTEGER NOT NULL)`);
  const e = db.prepare("INSERT INTO events (task_id, at, actor, kind, detail) VALUES (?, ?, ?, ?, ?)");
  e.run(10, NOW - H, "human:adam", "created", null);
  e.run(11, NOW - 2 * H, "human:adam", "created", null);
  e.run(12, NOW - H, "human:adam", "edited", "priority");
  e.run(13, NOW - H, "human:eva", "edited", "priority");
  e.run(13, NOW - H, "human:eva", "edited", "title");
  e.run(14, NOW - H, "human:eva", "created", null);
  e.run(15, NOW - 30 * H, "human:adam", "created", null);
  e.run(16, NOW - 30 * H, "human:oskar", "edited", "priority");
  const c = db.prepare("INSERT INTO comments (task_id, author_kind, author, body, created_at) VALUES (?, 'human', ?, ?, ?)");
  c.run(20, "eva", "Adam 25. 10.: schválil návrh", NOW - H);
  c.run(21, "eva", "Adam: ďalší", NOW - 3 * H);
  c.run(21, "eva", "Eva: vlastný komentár", NOW - H);
  c.run(22, "eva", "Adam: starý", NOW - 30 * H);
  db.close();
  return path;
}

function t3Db() {
  const dir = mkdtempSync(join(tmpdir(), "adam-t3-"));
  const path = join(dir, "state.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, created_at TEXT, payload_json TEXT);
           CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT)`);
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?)").run("t1", "Vlákno jedna");
  db.prepare("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?)").run("t2", "Veľmi dlhý názov vlákna, ktorý sa musí skrátiť na tridsať znakov");
  const m = db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES (?, ?, ?, ?, ?)");
  const iso = (ago) => new Date(NOW - ago).toISOString();
  let n = 0;
  const add = (thread, ago, text, extra = {}, role = "user") => {
    const id = extra.id ?? `m${++n}`;
    m.run(id, thread, role, iso(ago), JSON.stringify({ createdBy: "user", creationSource: "web", id, text, ...extra }));
  };
  add("t1", H, "Oprav   to\n  prosím");                                  // operátor, biele znaky sa zlúčia
  add("t1", 2 * H, "Druhá správa");                                      // operátor
  add("t2", 3 * H, "x".repeat(200));                                     // operátor, dlhý text
  add("t1", H, "/clear");                                                // /clear
  add("t1", H, "  /clear  ");
  add("t1", H, "Na vedomie, niečo");                                     // text budiča
  add("t1", H, "Schránka: od eva");
  add("t1", H, "<schranka od=eva id=1>");
  add("t1", H, "[harness] pripomienka");
  add("t1", H, "Sprava z minuleho kontextu: ...");
  add("t1", H, "Spusti skill x");
  add("t1", H, "správa budiča", { id: "x-inbox-1" });                    // id budiča
  add("t1", H, "notifikácia", { notification: { kind: "x" } });          // notifikácia
  add("t1", H, "od agenta", { createdBy: "agent" });                     // agent
  add("t1", H, "z providera", { creationSource: "provider" });
  add("t1", H, "odpoveď asistenta", {}, "assistant");                    // iná rola
  add("t1", 30 * H, "stará správa");                                     // mimo okna 24 h
  db.close();
  return path;
}

test("filter správ operátora: operátor áno, budič, /clear, notifikácia, agent nie", () => {
  const ok = { createdBy: "user", creationSource: "web", id: "a", text: "ahoj" };
  assert.equal(isOperatorMessage(ok), true);
  assert.equal(isOperatorMessage({ ...ok, createdBy: "agent" }), false);
  assert.equal(isOperatorMessage({ ...ok, creationSource: "provider" }), false);
  assert.equal(isOperatorMessage({ ...ok, creationSource: "mobile" }), true);
  assert.equal(isOperatorMessage({ ...ok, creationSource: "mcp" }), false);
  assert.equal(isOperatorMessage({ ...ok, notification: {} }), false);
  assert.equal(isOperatorMessage({ ...ok, id: "q-inbox-2" }), false);
  assert.equal(isOperatorMessage({ ...ok, text: " /clear " }), false);
  assert.equal(isOperatorMessage({ ...ok, text: "/clear teraz" }), true);
  assert.equal(isOperatorMessage({ ...ok, text: "Spusti skill x" }), false);
});

test("Tasker: udalosti operátora podľa druhu, posuny poradia, komentáre za operátora, okno 24 h", () => {
  const out = operatorSection({ taskerDb: taskerDb(), t3Db: join(tmpdir(), "adam-nie", "x") }, NOW, { env: ENV }).join("\n");
  assert.match(out, /Zásahy operátora za 24 h:/);
  assert.match(out, /- created: 2 \(úlohy 10, 11\)/);
  assert.match(out, /- edited: 1 \(úlohy 12\)/);
  assert.doesNotMatch(out, /úlohy 14|úlohy 15/);
  assert.match(out, /Posuny poradia: 2 \(úlohy 12, 13\), z toho operátor 1/);
  assert.match(out, /Komentáre agenta za operátora \(telo začína "Adam"\): 2 \(úlohy 20, 21\)/);
  assert.match(out, /Spočítaj nútené zásahy operátora \(oprava, námietka, chyba, ktorú mal nájsť agent, posun stojacej úlohy\)/);
});

test("bez AGENT_OPERATOR_NAME položka komentárov odpadne", () => {
  const out = operatorSection({ taskerDb: taskerDb(), t3Db: "/nie/je" }, NOW, { env: { TASKER_OPERATORS: "adam" } }).join("\n");
  assert.doesNotMatch(out, /Komentáre agenta za operátora/);
  assert.match(out, /- created: 2/);
});

test("T3: správy operátora, počty podľa vlákna, riadky v čase Bratislavy, skrátenie, okno", () => {
  const out = operatorSection({ taskerDb: taskerDb(), t3Db: t3Db() }, NOW, { env: ENV }).join("\n");
  assert.match(out, /T3, správy operátora z webu: 3\n/);
  assert.match(out, /- Vlákno jedna: 2/);
  assert.match(out, /- Veľmi dlhý názov vlákna, ktorý sa musí skrátiť na tridsať znakov: 1\n/);
  // NOW 06:00:07Z, v Bratislave platí od 25. 10. zimný čas (UTC+1): správy z 05:00Z, 04:00Z a 03:00Z
  assert.match(out, /- 06:00 Vlákno jedna: Oprav to prosím/);
  assert.match(out, /- 05:00 Vlákno jedna: Druhá správa/);
  const title30 = "Veľmi dlhý názov vlákna, ktorý sa musí skrátiť".slice(0, 30);
  assert.equal(title30.length, 30);
  assert.ok(out.includes(`- 04:00 ${title30}: ${"x".repeat(120)}\n`));
  assert.doesNotMatch(out, /x{121}/);
  assert.doesNotMatch(out, /stará správa|od agenta|notifikácia|budiča|clear/);
});

test("T3: najviac 60 riadkov správ", () => {
  const dir = mkdtempSync(join(tmpdir(), "adam-t3-"));
  const path = join(dir, "s.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, created_at TEXT, payload_json TEXT); CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, title TEXT)");
  for (let i = 0; i < 65; i++) db.prepare("INSERT INTO orchestration_v2_projection_messages VALUES (?, 't', 'user', ?, ?)").run(`m${i}`, new Date(NOW - H + i * 1000).toISOString(), JSON.stringify({ createdBy: "user", creationSource: "web", id: `m${i}`, text: `t${i}` }));
  db.close();
  const out = operatorSection({ taskerDb: taskerDb(), t3Db: path }, NOW, { env: ENV });
  assert.equal(out.filter((l) => /^- \d\d:\d\d /.test(l)).length, 60);
  assert.ok(out.includes("T3, správy operátora z webu: 65"));
  assert.ok(out.includes("- ... ďalších 5"));
});

test("chýbajúca T3 DB: riadok, nie chyba; chýbajúca DB Taskera: riadok, nie výnimka", () => {
  const out = operatorSection({ taskerDb: join(tmpdir(), "adam-nie", "t.db"), t3Db: join(tmpdir(), "adam-nie", "s.sqlite") }, NOW, { env: ENV }).join("\n");
  assert.match(out, /T3: databáza nie je/);
  assert.match(out, /Tasker: čítanie databázy zlyhalo/);
  assert.match(out, /Spočítaj nútené zásahy/);
});

test("build() zaradí časť za rozloženie práce", () => {
  const cfg = { taskerDb: taskerDb(), t3Db: "/nie/je", taskerBin: "/nie/je", taskerHome: tmpdir(), workRepos: [] };
  const old = { ...process.env };
  Object.assign(process.env, ENV);
  try {
    const out = build(cfg, () => "tasker ok", NOW, { git: () => "" });
    assert.ok(out.indexOf("Rozloženie práce za 24 h:") < out.indexOf("Zásahy operátora za 24 h:"));
  } finally { for (const k of Object.keys(ENV)) if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; }
});
