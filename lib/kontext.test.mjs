// kontext.sh: odovzdávka pri čistom kontexte. Všetko v dočasných adresároch,
// KONTEXT_DIR je vždy nastavený, živé ~/.local/state sa nedotkne.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { main, parseArgs, takeHandoff, writeHandoff, staleWaiting } from "./kontext.mjs";

const SH = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "kontext.sh");
const ID = "056439af-f468-4146-95ca-2b3874c95058";
const tmp = () => mkdtempSync(join(tmpdir(), "kontext-"));

// Skript spustený z procesu, ktorý vyzerá ako claude vlákna T3: ID relácie
// nesie príkazový riadok rodiča (--resume), ako ho nájde originalId().
function runAsT3(args, dir, id = ID) {
  const code = `const r = require("node:child_process").spawnSync(${JSON.stringify(SH)}, ${JSON.stringify(args)}, { env: { PATH: process.env.PATH, HOME: ${JSON.stringify(dir)}, KONTEXT_DIR: ${JSON.stringify(dir)} }, encoding: "utf8" }); process.stdout.write(JSON.stringify(r));`;
  const extra = ["--", "--resume", id];
  const r = spawnSync(process.execPath, ["-e", code, ...extra], { encoding: "utf8" });
  return JSON.parse(r.stdout);
}

test("parseArgs: pokracuj bez --dalej je chyba, spanok ide bez prepínačov", () => {
  assert.match(parseArgs(["pokracuj"]).error, /--dalej/);
  assert.match(parseArgs(["pokracuj", "--stav", "x"]).error, /--dalej/);
  assert.deepEqual(parseArgs(["spanok"]), { rezim: "spanok", dalej: null, stav: null });
  assert.deepEqual(parseArgs(["pokracuj", "--dalej", "krok", "--stav", "s"]), { rezim: "pokracuj", dalej: "krok", stav: "s" });
  assert.ok(parseArgs(["inak"]).error);
  assert.ok(parseArgs(["spanok", "--dalej"]).error);
});

test("kontext.sh pokracuj bez --dalej skončí kódom 2 a nič nezapíše", () => {
  const dir = tmp();
  const r = runAsT3(["pokracuj"], dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--dalej/);
  assert.deepEqual(readdirSync(dir), []);
});

test("kontext.sh mimo T3 (žiadny predok s --resume) skončí chybou a nič nezapíše", () => {
  // Test beží pod skutočným claude, preto sa ID hľadá od pid 1 a nie od predkov testu.
  const dir = tmp();
  let err = "";
  const code = main(["spanok"], { env: { KONTEXT_DIR: dir }, pid: 1, out: { write() {} }, err: { write: (x) => { err += x; } } });
  assert.equal(code, 1);
  assert.match(err, /ID relácie/);
  assert.deepEqual(readdirSync(dir), []);
});

test("kontext.sh pokracuj: súbor <id>.json s právami 600 a riadok s kľúčom na stdout", () => {
  const dir = tmp();
  const r = runAsT3(["pokracuj", "--dalej", "dokončiť úlohu 7", "--stav", "pamäť zapísaná"], dir);
  assert.equal(r.status, 0, r.stderr);
  const file = join(dir, `${ID}.json`);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const d = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(d.rezim, "pokracuj");
  assert.equal(d.dalej, "dokončiť úlohu 7");
  assert.equal(d.stav, "pamäť zapísaná");
  assert.match(d.key, /^[0-9a-f]{16}$/);
  assert.ok(d.cwd && d.at);
  assert.equal(r.stdout, `HOTOVO-KONTEXT pokracuj ${d.key}\n`);
  assert.deepEqual(readdirSync(dir), [`${ID}.json`], "žiadny dočasný súbor");
});

test("kontext.sh spanok bez prepínačov: riadok HOTOVO-KONTEXT spanok <kľúč>", () => {
  const dir = tmp();
  const r = runAsT3(["spanok"], dir);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^HOTOVO-KONTEXT spanok [0-9a-f]{16}\n$/);
});

test("takeHandoff prečíta a zmaže, druhé čítanie je null", () => {
  const dir = tmp();
  writeHandoff({ dir, id: ID, rezim: "spanok" });
  assert.equal(takeHandoff(dir, ID).rezim, "spanok");
  assert.equal(takeHandoff(dir, ID), null);
  assert.equal(takeHandoff(dir, null), null);
});

// Úloha 399 z 23. 10. 2026: waiting o 1792772356109, vlastný komentár o 1792786154356.
const ev = (at, kind, actor, to_status = null) => ({ at, kind, actor, to_status });
const task399 = (events) => ({ id: 399, status: "waiting", wait_reason: "Cyril potvrdí check.mjs", events });
const fakeTasker = (task) => (args) => (args[1] === "list" ? [{ id: task.id, status: "waiting" }] : task);
const base399 = [
  ev(1792764114738, "status", "human:adam", "blocked"),
  ev(1792772355947, "comment", "human:adam"),
  ev(1792772356109, "status", "human:adam", "waiting"),
];

test("staleWaiting: replay úlohy 399 (vlastný komentár po waiting) nájde úlohu", () => {
  const t = task399([...base399, ev(1792786154356, "comment", "human:adam")]);
  const r = staleWaiting("adam", fakeTasker(t));
  assert.equal(r.length, 1);
  assert.equal(r[0].id, 399);
  assert.equal(r[0].commentAt, 1792786154356);
});

test("staleWaiting: waiting bez novšieho vlastného komentára prejde", () => {
  assert.deepEqual(staleWaiting("adam", fakeTasker(task399(base399))), []);
});

test("staleWaiting: novší komentár iného autora prejde", () => {
  const t = task399([...base399, ev(1792786154356, "comment", "human:cyril")]);
  assert.deepEqual(staleWaiting("adam", fakeTasker(t)), []);
});

test("staleWaiting: stav zmenený po komentári prejde", () => {
  const t = task399([...base399, ev(1792786154356, "comment", "human:adam"), ev(1792786200000, "status", "human:adam", "waiting")]);
  assert.deepEqual(staleWaiting("adam", fakeTasker(t)), []);
  const u = { ...t, status: "queued" };
  assert.deepEqual(staleWaiting("adam", (a) => (a[1] === "list" ? [] : u)), []);
});

// Úloha 401 z 23. 10. 2026: tasker wait na úlohe, ktorá už čaká, zapíše
// udalosť "wait", nie "status". Nové čakanie po komentári kontext pustí.
test("staleWaiting: replay úlohy 401 (wait znova po komentári) prejde", () => {
  const t = task399([...base399, ev(1792789557107, "comment", "human:adam"), ev(1792789557196, "wait", "human:adam")]);
  assert.deepEqual(staleWaiting("adam", fakeTasker(t)), []);
});

test("main: replay 399 odmietne s kódom 1, správou na stderr a bez odovzdávky", () => {
  const dir = tmp();
  const t = task399([...base399, ev(1792786154356, "comment", "human:adam")]);
  let o = "", e = "";
  const code = main(["spanok", "--stav", "x"], {
    env: { AGENT_NAME: "adam", KONTEXT_DIR: dir }, pid: process.pid,
    out: { write: (x) => (o += x) }, err: { write: (x) => (e += x) }, tasker: fakeTasker(t),
  });
  assert.equal(code, 1);
  assert.match(e, /úloha 399 čaká \(Cyril potvrdí check\.mjs\), ale tvoj komentár z .* je novší\.\nSprávny postup: zmeň stav/);
  assert.equal(o, "");
  assert.deepEqual(readdirSync(dir), []);
});

test("main: nedostupný Tasker neblokuje, len varuje", () => {
  const dir = tmp();
  let e = "";
  main(["spanok"], { env: { AGENT_NAME: "adam", KONTEXT_DIR: dir }, pid: process.pid, out: { write() {} }, err: { write: (x) => (e += x) }, tasker: () => { throw new Error("nejde"); } });
  assert.match(e, /Tasker/);
  assert.doesNotMatch(e, /čaká/);
});

// Úloha 542: kontext.sh pred čistým kontextom ukončí prácu (tasker work) svojej relácie.
// 25. 10. 2026: tk start 529 zapísal work start s thread S, /clear dal novú reláciu
// a hook tasker_work.mjs jej hlásil, že úlohu drží stará.
const SESS = "11111111-aaaa-bbbb-cccc-222222222222";
const FUTURE = new Date(Date.now() + 3600_000).toISOString();
const PAST = new Date(Date.now() - 3600_000).toISOString();
const workEv = (id, thread, until = FUTURE, actor = "human:adam") => ({ id, at: id, kind: "work", actor, detail: `start until ${until} thread ${thread}` });

// Falošný Tasker: zaznamená každé volanie, úlohy dá z mapy { id: {events} }.
function work542({ tasks = {}, listed = Object.keys(tasks).map(Number), fail = null } = {}) {
  const calls = [];
  const tasker = (args) => {
    calls.push(args.join(" "));
    if (fail) throw new Error(fail);
    if (args[0] === "task" && args[1] === "list") return listed.map((id) => ({ id, status: "in_progress" }));
    if (args[0] === "task" && args[1] === "show") return { id: Number(args[2]), status: "in_progress", events: tasks[args[2]]?.events || [] };
    return null;
  };
  return { calls, tasker };
}

function run542(env, tasker, cache) {
  const dir = tmp();
  let o = "", e = "";
  const code = main(["spanok"], {
    env: { AGENT_NAME: "adam", KONTEXT_DIR: dir, HOME: cache, XDG_CACHE_HOME: cache, ...env }, pid: process.pid,
    out: { write: (x) => (o += x) }, err: { write: (x) => (e += x) }, tasker,
  });
  return { code, o, e };
}

test("main 542: work start tejto relácie na úlohe 529 sa pred odovzdávkou ukončí (work 529 --stop)", () => {
  const cache = tmp();
  const f = work542({ tasks: { 529: { events: [workEv(1, SESS)] } } });
  const r = run542({ CLAUDE_CODE_SESSION_ID: SESS }, f.tasker, cache);
  assert.equal(r.code, 0, r.e);
  assert.match(r.o, /^HOTOVO-KONTEXT spanok /);
  assert.ok(f.calls.some((c) => /^work 529 --stop/.test(c)), f.calls.join("\n"));
});

test("main 542: záznam inej relácie sa neukončí", () => {
  const cache = tmp();
  const f = work542({ tasks: { 529: { events: [workEv(1, "ina-relacia")] } } });
  const r = run542({ CLAUDE_CODE_SESSION_ID: SESS }, f.tasker, cache);
  assert.equal(r.code, 0);
  assert.ok(!f.calls.some((c) => c.startsWith("work ")), f.calls.join("\n"));
});

test("main 542: záznam s until v minulosti alebo už zastavený sa neukončí", () => {
  const cache = tmp();
  const f = work542({ tasks: {
    529: { events: [workEv(1, SESS, PAST)] },
    530: { events: [workEv(1, SESS), { id: 2, kind: "work_stop", actor: "human:adam" }] },
    531: { events: [workEv(1, SESS), { id: 2, kind: "status", actor: "human:adam", to_status: "done" }] },
  } });
  run542({ CLAUDE_CODE_SESSION_ID: SESS }, f.tasker, cache);
  assert.ok(!f.calls.some((c) => c.startsWith("work ")), f.calls.join("\n"));
});

test("main 542: úloha zo stavu hooku tasker_work_current sa nájde, súbor sa zmaže", () => {
  const cache = tmp();
  const cur = join(cache, "agentic-workflow", "tasker_work_current", SESS);
  mkdirSync(dirname(cur), { recursive: true });
  writeFileSync(cur, JSON.stringify({ n: 529, reportedAt: 1 }));
  const f = work542({ tasks: { 529: { events: [workEv(1, SESS)] } }, listed: [] });
  const r = run542({ CLAUDE_CODE_SESSION_ID: SESS }, f.tasker, cache);
  assert.equal(r.code, 0);
  assert.ok(f.calls.some((c) => /^work 529 --stop/.test(c)), f.calls.join("\n"));
  assert.equal(existsSync(cur), false);
});

test("main 542: úloha s bežiacim sub-agentom sa neukončí, len varovanie", () => {
  const cache = tmp();
  const sub = join(cache, "agentic-workflow", "tasker_work", SESS);
  mkdirSync(sub, { recursive: true });
  writeFileSync(join(sub, "toolu_1"), "529\n");
  const f = work542({ tasks: { 529: { events: [workEv(1, SESS)] }, 530: { events: [workEv(1, SESS)] } } });
  const r = run542({ CLAUDE_CODE_SESSION_ID: SESS }, f.tasker, cache);
  assert.equal(r.code, 0);
  assert.ok(!f.calls.some((c) => /^work 529/.test(c)), f.calls.join("\n"));
  assert.ok(f.calls.some((c) => /^work 530 --stop/.test(c)), "ostatné úlohy sa ukončia");
  assert.match(r.e, /úloha 529 má bežiaceho sub-agenta/);
});

test("main 542: Tasker padne, kontext.sh aj tak vypíše HOTOVO-KONTEXT", () => {
  const cache = tmp();
  const r = run542({ CLAUDE_CODE_SESSION_ID: SESS }, () => { throw new Error("Tasker nejde"); }, cache);
  assert.equal(r.code, 0);
  assert.match(r.o, /^HOTOVO-KONTEXT spanok [0-9a-f]{16}\n$/);
  assert.match(r.e, /varovanie/);
});

test("main 542: zlyhanie jedného work --stop neukončí ostatné ani nezablokuje", () => {
  const cache = tmp();
  const f = work542({ tasks: { 529: { events: [workEv(1, SESS)] }, 530: { events: [workEv(1, SESS)] } } });
  const t = (args) => { if (args[0] === "work" && args[1] === "529") throw new Error("zlyhalo"); return f.tasker(args); };
  const r = run542({ CLAUDE_CODE_SESSION_ID: SESS }, t, cache);
  assert.equal(r.code, 0);
  assert.ok(f.calls.some((c) => /^work 530 --stop/.test(c)));
  assert.match(r.e, /úlohu 529 som neuvoľnil/);
});

test("main 542: bez CLAUDE_CODE_SESSION_ID len varovanie a odovzdávka prebehne", () => {
  const cache = tmp();
  const f = work542({ tasks: { 529: { events: [workEv(1, SESS)] } } });
  const r = run542({}, f.tasker, cache);
  assert.equal(r.code, 0);
  assert.match(r.e, /CLAUDE_CODE_SESSION_ID/);
  assert.ok(!f.calls.some((c) => c.startsWith("work ")));
});

test("main 542: pokracuj ukončí prácu rovnako ako spanok", () => {
  const cache = tmp();
  const dir = tmp();
  const f = work542({ tasks: { 529: { events: [workEv(1, SESS)] } } });
  const code = main(["pokracuj", "--dalej", "krok"], { env: { AGENT_NAME: "adam", KONTEXT_DIR: dir, HOME: cache, XDG_CACHE_HOME: cache, CLAUDE_CODE_SESSION_ID: SESS }, pid: process.pid, out: { write() {} }, err: { write() {} }, tasker: f.tasker });
  assert.equal(code, 0);
  assert.ok(f.calls.some((c) => /^work 529 --stop/.test(c)));
});
