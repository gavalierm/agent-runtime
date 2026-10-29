// Hook topic_task.mjs: úloha založená vo vlákne témy sa zapíše do témy.
// Žiadny test nesiaha na živý topics.json ani na živú databázu T3.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { newTaskIds, newTaskProject, topicNameFor, threadsForNative, topicOfThreads, handle, recentTasks } from "../hooks/topic_task.mjs";

// Poistka: volanie tk, ktoré test nenahradil falošným, skončí chybou, nie živým Taskerom.
process.env.TK_BIN = "/nonexistent/tk";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "../hooks/topic_task.mjs");
const NATIVE = "11111111-1111-4111-8111-111111111111";
const MAIN_NATIVE = "22222222-2222-4222-8222-222222222222";
const T_PRAVIDLA = "thread:project:p:aaa";
const T_MCP = "mcp:bbb";
const NOVY_NATIVE = "44444444-4444-4444-8444-444444444444";
const SUB_NATIVE = "55555555-5555-4555-8555-555555555555";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "topic-task-"));
  const dbPath = join(dir, "t3.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, payload_json TEXT NOT NULL)");
  const ins = db.prepare("INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?)");
  const row = (n, thread, native) => ins.run(n, thread, JSON.stringify({ nativeThreadRef: { nativeId: native } }));
  row("a", T_PRAVIDLA, NATIVE);
  row("b", T_MCP, "33333333-3333-4333-8333-333333333333");
  row("c", "thread:project:p:main", MAIN_NATIVE);
  row("d", "thread:project:p:novy1234", NOVY_NATIVE);
  row("e", "thread:provider:sub", SUB_NATIVE);
  db.close();
  const topicsFile = join(dir, "topics.json");
  writeFileSync(topicsFile, JSON.stringify({ pravidla: { thread: T_PRAVIDLA, tasks: [390] }, projekt_c: { thread: T_MCP } }, null, 1) + "\n");
  const mainFile = join(dir, "thread_id");
  writeFileSync(mainFile, "thread:project:p:main\n");
  return { dir, dbPath, topicsFile, mainFile, topics: () => JSON.parse(readFileSync(topicsFile, "utf8")) };
}
const add = (stdout, command = "AGENT_NAME=adam /opt/agentic-workflow/bin/tk task add --title x --project p --json") => ({ tool_input: { command }, tool_response: { stdout, stderr: "" } });

test("newTaskIds: json, viac objektov, číslo bez --json, cudzí príkaz", () => {
  assert.deepEqual(newTaskIds("tasker task add --json", { stdout: '{\n "id": 421,\n "title": "a } {"\n}\n' }), [421]);
  assert.deepEqual(newTaskIds("tasker task add --json; tasker task add --json", { stdout: '{"id":5,"title":"a"}\n{"id":6,"title":"b"}\n' }), [5, 6]);
  assert.deepEqual(newTaskIds("tasker task add --title x --project p", { stdout: "77\n" }), [77]);
  assert.deepEqual(newTaskIds("tasker task add --json", { stdout: "77\n" }), [77]);
  assert.deepEqual(newTaskIds("AGENT_NAME=adam /opt/agentic-workflow/bin/tk task add --json", { stdout: '{"id":9}' }), [9]);
  assert.deepEqual(newTaskIds("tk task add --json", { stdout: "10\n" }), [10]);
  assert.deepEqual(newTaskIds("tasker task show 5 --json", { stdout: '{"id":5}' }), []);
  assert.deepEqual(newTaskIds("tasker task add --title x", { stdout: "" }), []);
  assert.deepEqual(newTaskIds(undefined, undefined), []);
});

test("threadsForNative a topicOfThreads: vlákno thread:project aj mcp", () => {
  const s = setup();
  assert.deepEqual(threadsForNative(NATIVE, s.dbPath), [T_PRAVIDLA]);
  assert.deepEqual(threadsForNative("nic", s.dbPath), []);
  assert.equal(topicOfThreads(s.topics(), [T_PRAVIDLA]), "pravidla");
  assert.equal(topicOfThreads(s.topics(), [T_MCP]), "projekt_c");
  assert.equal(topicOfThreads(s.topics(), ["thread:project:p:main"]), null);
});

test("handle zapíše novú úlohu do témy vlákna cez route.mjs", async () => {
  const s = setup();
  const r = await handle(add('{"id": 421, "title": "t"}'), { nativeId: NATIVE, dbPath: s.dbPath, topicsFile: s.topicsFile, mainFile: s.mainFile });
  assert.deepEqual(r, { topic: "pravidla", ids: [421], dryRun: false, created: false });
  assert.deepEqual(s.topics().pravidla.tasks, [390, 421]);
  assert.equal(s.topics().projekt_c.tasks, undefined);
});

test("handle: dry-run nezapíše, hlavné vlákno a neznáma relácia nerobia nič, už zapísaná úloha nie je nová", async () => {
  const s = setup();
  const before = readFileSync(s.topicsFile, "utf8");
  const o = { dbPath: s.dbPath, topicsFile: s.topicsFile, mainFile: s.mainFile };
  assert.deepEqual(await handle(add('{"id": 9, "title": "t"}'), { ...o, nativeId: NATIVE, dryRun: true }), { topic: "pravidla", ids: [9], dryRun: true, created: false });
  assert.equal(await handle(add('{"id": 9, "title": "t"}'), { ...o, nativeId: MAIN_NATIVE }), null);
  assert.equal(await handle(add('{"id": 9, "title": "t"}'), { ...o, nativeId: "nezname" }), null);
  assert.equal(await handle(add('{"id": 9, "title": "t"}'), { ...o, nativeId: null }), null);
  assert.deepEqual(await handle(add('{"id": 390, "title": "t"}'), { ...o, nativeId: NATIVE }), { topic: "pravidla", ids: [], dryRun: false, created: false });
  assert.equal(readFileSync(s.topicsFile, "utf8"), before);
});

test("hook ako proces: pri chybe kód 0 a prázdny výstup, na cudzí príkaz tiež", () => {
  const env = { ...process.env, TK_BIN: "/nonexistent/tk", AGENT_TOPICS_FILE: "/nonexistent/topics.json", AGENT_STATE: "/nonexistent" };
  for (const input of ["nie json", JSON.stringify(add('{"id": 3, "title": "t"}')), JSON.stringify({ tool_input: { command: "ls" } })]) {
    const r = spawnSync("node", ["--no-warnings", HOOK], { input, env, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  }
});

const addP = (id, project) => add(JSON.stringify({ id, title: "t", project }));

test("newTaskProject a topicNameFor: projekt z json aj z príkazu, snake_case, kolízia mena", () => {
  assert.equal(newTaskProject("tk task add --json", { stdout: '{"id":1,"project":"agenti"}' }), "agenti");
  assert.equal(newTaskProject("tk task add --project kubo-rancher --title x", { stdout: "5\n" }), "kubo-rancher");
  assert.equal(newTaskProject("tk task add --title x", { stdout: "5\n" }), null);
  assert.equal(topicNameFor("Kubo-Rancher", "thread:project:p:AbC12345"), "kubo_rancher_c12345");
  assert.equal(topicNameFor(null, "mcp:xyz789"), "uloha_xyz789");
  assert.equal(topicNameFor("agenti", "t:aaaaaa", { agenti_aaaaaa: { thread: "iné" } }), "agenti_aaaaaa2");
  assert.equal(topicNameFor("agenti", "t:aaaaaa", { agenti_aaaaaa: { thread: "t:aaaaaa" } }), "agenti_aaaaaa");
});

test("vlákno mimo hlavného bez témy dostane tému a úloha sa do nej zapíše (úloha 492, vlákno Tasker #7)", async () => {
  const s = setup();
  const r = await handle(addP(486, "agenti"), { nativeId: NOVY_NATIVE, dbPath: s.dbPath, topicsFile: s.topicsFile, mainFile: s.mainFile });
  assert.deepEqual(r, { topic: "agenti_vy1234", ids: [486], dryRun: false, created: true });
  const t = s.topics();
  assert.equal(t.agenti_vy1234.thread, "thread:project:p:novy1234");
  assert.deepEqual(t.agenti_vy1234.tasks, [486]);
  assert.deepEqual(t.pravidla.tasks, [390]);
  // topicFor mosta nájde tému podľa úlohy, správa pôjde do vlákna, nie do hlavného
  const { topicFor } = await import("../tasker_events.mjs");
  assert.equal(topicFor({ box: s.dir, topicsFile: s.topicsFile }, "agenti"), null);
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, parent_id INTEGER); INSERT INTO tasks VALUES (486, NULL), (487, 486)");
  assert.equal(topicFor({ box: s.dir, topicsFile: s.topicsFile }, "agenti", 486, db), "agenti_vy1234");
  assert.equal(topicFor({ box: s.dir, topicsFile: s.topicsFile }, "agenti", 487, db), "agenti_vy1234");
  // druhá úloha toho istého vlákna použije tú istú tému
  const r2 = await handle(addP(488, "agenti"), { nativeId: NOVY_NATIVE, dbPath: s.dbPath, topicsFile: s.topicsFile, mainFile: s.mainFile });
  assert.deepEqual(r2, { topic: "agenti_vy1234", ids: [488], dryRun: false, created: false });
});

test("téma sa nezaloží: hlavné vlákno, sub-agent, dry-run, chýbajúci zoznam sa vytvorí", async () => {
  const s = setup();
  const before = readFileSync(s.topicsFile, "utf8");
  const o = { dbPath: s.dbPath, topicsFile: s.topicsFile, mainFile: s.mainFile };
  assert.equal(await handle(addP(9, "agenti"), { ...o, nativeId: MAIN_NATIVE }), null);
  assert.equal(await handle(addP(9, "agenti"), { ...o, nativeId: SUB_NATIVE }), null);
  assert.deepEqual(await handle(addP(9, "agenti"), { ...o, nativeId: NOVY_NATIVE, dryRun: true }), { topic: "agenti_vy1234", ids: [9], dryRun: true, created: true });
  assert.equal(readFileSync(s.topicsFile, "utf8"), before);
  const fresh = join(s.dir, "nove.json");
  const r = await handle(addP(9, "agenti"), { ...o, topicsFile: fresh, nativeId: NOVY_NATIVE });
  assert.equal(r.created, true);
  assert.deepEqual(JSON.parse(readFileSync(fresh, "utf8")).agenti_vy1234.tasks, [9]);
});

// Falošný tk: tasks = [{ id, title, project, created_at, actor, at }]
const NOW = 1_800_000_000_000;
function fakeTk(tasks, calls = []) {
  return (args) => {
    calls.push(args.join(" "));
    if (args[0] === "task" && args[1] === "list") return JSON.stringify(tasks.map(({ id, title, project, created_at }) => ({ id, title, project, created_at })));
    if (args[0] === "task" && args[1] === "show") {
      const t = tasks.find((x) => x.id === Number(args[2]));
      return JSON.stringify({ id: t.id, events: [{ kind: "created", actor: t.actor, at: t.at ?? t.created_at }] });
    }
    throw new Error("neznamy prikaz");
  };
}
const T = (id, o = {}) => ({ id, title: `u${id}`, project: "agenti", created_at: NOW - 5000, actor: "human:adam", ...o });
const PIPE = "AGENT_NAME=adam /opt/agentic-workflow/bin/tk task add --title x --project p --json | grep -o '\"id\":[0-9]*'";

test("recentTasks: len čerstvé úlohy tohto agenta, názov z --title, bez mena nič", () => {
  const tasks = [T(1), T(2, { actor: "human:iny" }), T(3, { created_at: NOW - 600000 }), T(4, { title: "iny nazov" })];
  assert.deepEqual(recentTasks(PIPE, { agent: "adam", now: NOW, tk: fakeTk(tasks) }).map((t) => t.id), [1, 4]);
  assert.deepEqual(recentTasks("tk task add --title \"iny nazov\" --project p", { agent: "adam", now: NOW, tk: fakeTk(tasks) }), [{ id: 4, project: "agenti" }]);
  assert.deepEqual(recentTasks(PIPE, { agent: null, now: NOW, tk: fakeTk(tasks) }), []);
  assert.deepEqual(recentTasks(PIPE, { agent: "adam", now: NOW, tk: () => { throw new Error("tk padol"); } }), []);
  assert.deepEqual(recentTasks(PIPE, { agent: "adam", now: NOW, tk: () => "nie json" }), []);
});

test("recentTasks cez TK_BIN: skript dostane AGENT_NAME agenta a príkaz task list", () => {
  const dir = mkdtempSync(join(tmpdir(), "topic-task-tk-"));
  const bin = join(dir, "tk");
  writeFileSync(bin, `#!/bin/sh\necho "$AGENT_NAME $*" >> "${dir}/log"\nif [ "$2" = list ]; then echo '[{"id":7,"title":"t","project":"agenti","created_at":${NOW - 1000}}]'; else echo '{"events":[{"kind":"created","actor":"human:'"$AGENT_NAME"'","at":${NOW - 1000}}]}'; fi\n`, { mode: 0o755 });
  const old = process.env.TK_BIN;
  process.env.TK_BIN = bin;
  try {
    assert.deepEqual(recentTasks(PIPE, { agent: "adam", now: NOW }), [{ id: 7, project: "agenti" }]);
  } finally { process.env.TK_BIN = old; }
  assert.equal(readFileSync(join(dir, "log"), "utf8"), "adam task list --json\nadam task show 7 --json\n");
});

test("handle: výstup task add prefiltrovaný rúrou alebo zahodený, úloha sa zapíše podľa udalosti created (úloha 563)", async () => {
  for (const stdout of ['"id":529\n', "", "529 \n   \n", "x\n"]) {
    const s = setup();
    const calls = [];
    const o = { nativeId: NATIVE, dbPath: s.dbPath, topicsFile: s.topicsFile, mainFile: s.mainFile, agent: "adam", now: NOW, tk: fakeTk([T(529), T(530, { actor: "human:iny" })], calls) };
    const input = { tool_input: { command: PIPE }, tool_response: { stdout, stderr: "" } };
    const r = await handle(input, o);
    // "529 " bez --json sa číta zo samotného riadku a tk sa nevolá
    const direct = stdout.trim() === "529";
    assert.deepEqual(r, { topic: "pravidla", ids: [529], dryRun: false, created: false }, JSON.stringify(stdout));
    assert.deepEqual(s.topics().pravidla.tasks, [390, 529]);
    assert.equal(calls.length > 0, !direct);
  }
});

test("handle so zálohou: nová téma vlákna berie projekt úlohy, hlavné vlákno a sub-agent tk nevolajú, bez udalosti nič", async () => {
  const s = setup();
  const calls = [];
  const o = { dbPath: s.dbPath, topicsFile: s.topicsFile, mainFile: s.mainFile, agent: "adam", now: NOW, tk: fakeTk([T(486)], calls) };
  const input = { tool_input: { command: "tk task add --title u486 | tail -1" }, tool_response: { stdout: "" } };
  assert.equal(await handle(input, { ...o, nativeId: MAIN_NATIVE }), null);
  assert.equal(await handle(input, { ...o, nativeId: SUB_NATIVE }), null);
  assert.equal(calls.length, 0);
  assert.equal(await handle(input, { ...o, nativeId: NATIVE, tk: fakeTk([T(486, { actor: "human:iny" })]) }), null);
  const r = await handle(input, { ...o, nativeId: NOVY_NATIVE });
  assert.deepEqual(r, { topic: "agenti_vy1234", ids: [486], dryRun: false, created: true });
  assert.deepEqual(s.topics().agenti_vy1234.tasks, [486]);
});
