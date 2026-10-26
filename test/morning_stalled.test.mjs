// Ranný súhrn: dáta pre report bez ručného dopytovania (úloha 607, D0179). Všetky DB a priečinky sú
// dočasné v mkdtemp, nič sa nečíta zo živých. Mená sú vymyslené.
import "../lib/git_isolate.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stalledSection, interruptedSection, reposSection, repliesSection, build } from "../morning.mjs";

const NOW = Date.parse("2026-10-26T06:00:07Z");
const H = 3600_000;
const M = 60_000;

function taskerDb() {
  const dir = mkdtempSync(join(tmpdir(), "adam-st-"));
  const path = join(dir, "tasker.db");
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, status TEXT, assignee TEXT, project TEXT, wait_reason TEXT, updated_at INTEGER);
           CREATE TABLE events (id INTEGER PRIMARY KEY, task_id INTEGER, run_id INTEGER, at INTEGER NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, from_status TEXT, to_status TEXT, detail TEXT);
           CREATE TABLE comments (id INTEGER PRIMARY KEY, task_id INTEGER NOT NULL, author_kind TEXT, author TEXT, body TEXT NOT NULL, created_at INTEGER NOT NULL);
           CREATE TABLE runs (id INTEGER PRIMARY KEY, task_id INTEGER, agent TEXT, status TEXT, result_subtype TEXT, started_at INTEGER, ended_at INTEGER)`);
  const t = db.prepare("INSERT INTO tasks (id, title, status, assignee, project, wait_reason) VALUES (?, ?, ?, ?, ?, ?)");
  const e = db.prepare("INSERT INTO events (task_id, at, actor, kind, from_status, to_status, detail) VALUES (?, ?, ?, ?, ?, ?, ?)");
  const c = db.prepare("INSERT INTO comments (task_id, author_kind, author, body, created_at) VALUES (?, 'human', ?, ?, ?)");
  const r = db.prepare("INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?, ?)");
  // 1: blocked pred oknom, v okne 1,5 h, potom queued -> done
  t.run(1, "Blokovaná adamova úloha", "done", "eva", "alfa", null);
  e.run(1, NOW - 30 * H, "human:adam", "created", null, "queued", null);
  e.run(1, NOW - 29 * H, "human:adam", "block_reason", null, null, "čaká na úlohu 2");
  e.run(1, NOW - 29 * H, "human:adam", "blocker", null, null, "+2");
  e.run(1, NOW - 29 * H, "human:adam", "status", "queued", "blocked", null);
  e.run(1, NOW - 22.5 * H, "tasker", "status", "blocked", "queued", null);
  e.run(1, NOW - 22 * H, "tasker", "status", "queued", "done", null);
  // 2: needs_human 1,5 h v okne, otázka v komentári pred vstupom
  t.run(2, "Otázka pre adama", "done", "eva", "alfa", null);
  e.run(2, NOW - 10 * H, "human:adam", "created", null, "todo", null);
  e.run(2, NOW - 10 * H + 1000, "tasker", "status", "todo", "in_progress", null);
  c.run(2, "eva", "Má to ísť cez A alebo B?", NOW - 8 * H - 1000);
  e.run(2, NOW - 8 * H, "tasker", "status", "in_progress", "needs_human", "ask");
  e.run(2, NOW - 6.5 * H, "human:adam", "status", "needs_human", "queued", null);
  e.run(2, NOW - 6.4 * H, "tasker", "status", "queued", "done", null);
  // 3: otvorené needs_human z predošlých dní
  t.run(3, "Stará otázka", "needs_human", "adam", "beta", null);
  e.run(3, NOW - 50 * H, "human:adam", "created", null, "needs_human", "ask");
  c.run(3, "adam", "Kde to pobeží?", NOW - 50 * H - 100);
  // 4: queued iba 30 minút, nie stojaca
  t.run(4, "Krátko čakala", "done", "eva", "alfa", null);
  e.run(4, NOW - 5 * H, "human:adam", "created", null, "queued", null);
  e.run(4, NOW - 4.5 * H, "tasker", "status", "queued", "done", null);
  // 5: unassigned bez prechodu v okne (zmenil sa len názov) a 6: unassigned s prechodom v okne
  t.run(5, "Nepridelená", "unassigned", null, "alfa", null);
  e.run(5, NOW - 40 * H, "human:adam", "created", null, "unassigned", null);
  e.run(5, NOW - 3 * H, "human:adam", "edited", null, null, "title");
  t.run(6, "Nepridelená dnes", "unassigned", null, "alfa", null);
  e.run(6, NOW - 3 * H, "human:adam", "created", null, "unassigned", null);
  // 7: waiting otvorené 3 h, dôvod z udalosti wait
  t.run(7, "Čaká na eva", "waiting", "eva", "alfa", "čaká na evu");
  e.run(7, NOW - 4 * H, "tasker", "status", "in_progress", "in_progress", null);
  e.run(7, NOW - 3 * H, "human:eva", "wait", null, null, "eva pošle kľúč");
  e.run(7, NOW - 3 * H, "human:eva", "status", "in_progress", "waiting", null);
  // behy: killed s komentárom tesne po konci, cancelled, finished (nie je v zozname), starý killed
  t.run(8, "Zabitý beh", "queued", "eva", "alfa", null);
  e.run(8, NOW - 12 * H, "tasker", "status", "queued", "in_progress", null);
  r.run(10, 8, "eva", "killed", "interrupted", NOW - 12 * H, NOW - 12 * H + 2 * M);
  e.run(8, NOW - 12 * H + 2 * M + 19000, "human:eva", "comment", null, null, null);
  c.run(8, "eva", "Zmena zadania po zabití", NOW - 12 * H + 2 * M + 19000);
  e.run(8, NOW - 12 * H + 30 * M, "human:eva", "comment", null, null, null); // už mimo 60 s po behu
  e.run(8, NOW - 12 * H + 1000, "tasker", "work", null, null, "start");        // šum
  r.run(11, 8, "eva", "cancelled", null, NOW - 5 * H, NOW - 5 * H + M);
  r.run(12, 8, "eva", "finished", "success", NOW - 4 * H, NOW - 4 * H + M);
  r.run(13, 8, "eva", "killed", "interrupted", NOW - 40 * H, NOW - 40 * H + M);
  db.close();
  return path;
}

test("stojace úlohy: trvanie v okne, príčina, otvorené needs_human s vekom, unassigned len počet", () => {
  const out = stalledSection({ taskerDb: taskerDb() }, NOW).join("\n");
  assert.match(out, /úloha 1 blocked, eva, alfa, "Blokovaná adamova úloha": v okne 1 h 30 min \(od vstupu 6 h 30 min\).*; blokér 2: čaká na úlohu 2/);
  assert.match(out, /úloha 2 needs_human, eva, alfa, "Otázka pre adama": v okne 1 h 30 min.*; otázka \(eva\): Má to ísť cez A alebo B\?/);
  assert.match(out, /úloha 7 waiting, eva, alfa.*v okne 3 h 00 min.*doteraz; eva pošle kľúč/);
  assert.doesNotMatch(out.split("Otvorené needs_human")[0], /úloha 4 /);
  const open = out.split("Otvorené needs_human")[1];
  assert.match(open, /\(1\), vek/);
  assert.match(open, /úloha 3 needs_human, adam, beta, "Stará otázka": 2 d 2 h \(od 24\. 10\. 06:00\); otázka \(adam\): Kde to pobeží\?/);
  assert.doesNotMatch(out.split("Otvorené needs_human")[0], /úloha 3 /);
  assert.match(out, /unassigned bez prechodu stavu v okne: 1 \(/);
  assert.doesNotMatch(out, /úloha 5 |úloha 6 /);
});

test("prerušené behy: killed a cancelled v okne, udalosti počas behu a do minúty po ňom, bez šumu", () => {
  const out = interruptedSection({ taskerDb: taskerDb() }, NOW).join("\n");
  assert.match(out, /- beh 10, úloha 8 "Zabitý beh", eva, killed\/interrupted, .*\(2 min\)/);
  assert.match(out, /po konci behu \+19 s .*: comment, human:eva, Zmena zadania po zabití/);
  assert.match(out, /- beh 11, úloha 8 .*cancelled,/);
  assert.match(out, /beh 11[^\n]*\n  počas behu bez udalostí úlohy|beh 11[\s\S]*počas behu/);
  assert.doesNotMatch(out, /beh 12|beh 13/);
  assert.doesNotMatch(out, /\bwork\b/);
  assert.equal((out.match(/comment, human:eva/g) || []).length, 1);
});

test("chýbajúca DB Taskera: riadok, nie výnimka", () => {
  const cfg = { taskerDb: join(tmpdir(), "adam-nie", "t.db") };
  assert.match(stalledSection(cfg, NOW).join("\n"), /Stojace úlohy: čítanie databázy Taskera zlyhalo/);
  assert.match(interruptedSection(cfg, NOW).join("\n"), /Prerušené behy: čítanie databázy Taskera zlyhalo/);
});

test("klony: len neprázdny git status s počtom riadkov, chyba je riadok", () => {
  const dir = mkdtempSync(join(tmpdir(), "adam-repos-"));
  const mk = (n) => { const p = join(dir, n); mkdirSync(p); return p; };
  const [a, b, c] = [mk("klon-a"), mk("klon-b"), mk("klon-c")];
  const git = (args) => {
    assert.ok(args.includes("--no-optional-locks") && args.includes("status") && args.includes("--short"));
    const repo = args[args.indexOf("-C") + 1];
    if (repo === a) return " M x\n?? y\n";
    if (repo === b) return "";
    throw Object.assign(new Error("x"), { stderr: "fatal: dubious ownership" });
  };
  const out = reposSection({ workRepos: [a, b, c, join(dir, "nie-je")] }, { git }).join("\n");
  assert.match(out, /\(1 z 3\)/);
  assert.match(out, /- klon-a: riadkov 2/);
  assert.doesNotMatch(out, /klon-b: riadkov|nie-je/);
  assert.match(out, /- klon-c: git status zlyhal: fatal: dubious ownership/);
  assert.match(reposSection({ workRepos: [b] }, { git }).join("\n"), /\(0 z 1\):\n\n- žiadne/);
});

test("odpovede v processed: okno 24 h, od a téma z hlavičky, Výsledok a Otvorené, tasker a ranný preskočené", () => {
  const box = mkdtempSync(join(tmpdir(), "adam-box-"));
  const dir = join(box, "processed");
  mkdirSync(dir);
  const put = (name, text, agoMs) => {
    writeFileSync(join(dir, name), text);
    const t = new Date(NOW - agoMs);
    utimesSync(join(dir, name), t, t);
  };
  put("eva-pravidla-20261025-142546-72650.md", "odpoveď: na vedomie\nid: x\nod: eva\nkomu: adam\ntéma: pravidla\nk: y\nVýsledok: nasadené na Macu.\nDôkaz: ls\nOtvorené: nič\n", 3 * H);
  put("oskar-20261025-100000-1.md", "odpoveď: čakám\nPrvý riadok bez hlavičky. Otvorené: dorobiť test.\n", 5 * H);
  put("eva-stara-20261020-100000-1.md", "odpoveď: na vedomie\nVýsledok: staré\n", 40 * H);
  put("tasker-20261025-100000-1-ab.md", "odpoveď: nečakám\nÚloha 1\n", H);
  put("ranny-20261026-070007-1-ab.md", "odpoveď: nečakám\nRanný súhrn\n", H);
  put("eva-pravidla-20261025-142546-72650.md.080832.60894.reply", "x", H);
  const out = repliesSection({ box, name: "adam" }, NOW).join("\n");
  assert.match(out, /- eva, téma pravidla, .*\(na vedomie\): Výsledok: nasadené na Macu\. \| Otvorené: nič/);
  assert.match(out, /- oskar, téma bez témy, .*\(čakám\): Prvý riadok bez hlavičky\. \| Otvorené: dorobiť test\./);
  assert.doesNotMatch(out, /staré|tasker|ranny|Ranný|Úloha 1|reply/);
  assert.match(repliesSection({ box: join(box, "nie") }, NOW).join("\n"), /Processed: priečinok .* sa nedá čítať/);
});

test("build(): pokyn za prvými dvoma riadkami, nové časti sú v poradí, sweepHeld bez sweepBoxes nič nepresúva", () => {
  const box = mkdtempSync(join(tmpdir(), "adam-box-"));
  mkdirSync(join(box, "processed"));
  const cfg = { taskerDb: taskerDb(), t3Db: "/nie/je", taskerBin: "/nie/je", taskerHome: tmpdir(), workRepos: [], box, name: "adam" };
  const out = build(cfg, () => "tasker ok", NOW, { git: () => "" });
  const lines = out.split("\n");
  assert.match(lines[2], /^Report napíš len z týchto dát, nástroj použi len na akciu/);
  assert.match(lines[2], /Chýbajúci údaj je úloha na morning\.mjs, nie ručný dopyt\./);
  const pos = ["Tasker za posledných 24 h:", "stáli viac ako hodinu", "Prerušené behy", "Správy iných agentov", "Rozloženie práce", "Klony s neprázdnym", "Zásahy operátora"].map((s) => out.indexOf(s));
  assert.ok(pos.every((p) => p >= 0), String(pos));
  assert.deepEqual([...pos].sort((a, b) => a - b), pos);
});
