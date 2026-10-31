import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync as mkdtempRaw, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { promisify } from "node:util";
import { startFakeT3 } from "./fake_t3.mjs";
import { T3Client } from "../lib.mjs";
import { callerThread, routeKey, rememberRoute, routeFor, threadForSession, sessionIds, waitingFor, setTopic, removeTopic, readTopics, topicsPath, messageTopic } from "../route.mjs";
import { tick, classify, renderMessage } from "../driver.mjs";

// Dočasné priečinky testu sa na konci zmažú (úloha 701).
const tmpDirs = [];
const mkdtempSync = (prefix) => { const d = mkdtempRaw(prefix); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

// Telo odpovede nesie povinné riadky Výsledok, Dôkaz a Otvorené (reply.sh).
const TRI = "Výsledok: v\nDôkaz: d\nOtvorené: nič\n";

const RUNTIME = join(dirname(fileURLToPath(import.meta.url)), "..");
// ask_agent.sh je v bin/ tohto repa, route.mjs berie z jeho koreňa (ASK_WORKFLOW).
const ASK = join(RUNTIME, "bin/ask_agent.sh");
const SKIP_ASK = existsSync(ASK) ? false : "bin/ask_agent.sh chýba";
const target = (script, opts) => script === "ask_agent.sh"
  ? [ASK, { ...opts, env: { ...opts?.env, ASK_WORKFLOW: RUNTIME } }]
  : [join(RUNTIME, script), opts];
// Skript beží asynchrónne, synchrónne spustenie by zablokovalo falošný T3.
const run = async (script, args, opts) => {
  const [path, o] = target(script, opts);
  try { return { status: 0, ...(await promisify(execFile)(path, args, { encoding: "utf8", ...o })) }; }
  catch (e) { return { status: e.code, stdout: e.stdout, stderr: e.stderr }; }
};
const runIn = (script, args, opts, input) => new Promise((resolve) => {
  const [path, o] = target(script, opts);
  const child = execFile(path, args, { encoding: "utf8", ...o }, (e, stdout, stderr) => resolve({ status: e ? e.code : 0, stdout, stderr }));
  child.stdin.end(input);
});

function setup(t3) {
  const root = mkdtempSync(join(tmpdir(), "adam-route-"));
  const box = join(root, "box");
  for (const d of ["inbox", "outbox", "processed"]) mkdirSync(join(box, d), { recursive: true });
  const state = join(root, "state");
  mkdirSync(state);
  writeFileSync(join(state, "thread_id"), "thr-adam\n");
  const cfg = { name: "adam", box, state, t3Url: t3?.url, pollMs: 10, batchWaitMs: 0 };
  const client = t3 ? new T3Client({ url: t3.url, token: t3.token, timeoutMs: 3000 }) : null;
  const put = (name, text) => writeFileSync(join(box, "inbox", name), text);
  return { root, cfg, client, box, state, put };
}

test("routeKey: jadro bez predpôn oboch strán", () => {
  assert.equal(routeKey("adam-pravidla-20261018-195432-12.md", "adam"), "pravidla-20261018-195432-12.md");
  assert.equal(routeKey("boris-adam-pravidla-20261018-195432-12.md", "adam"), "pravidla-20261018-195432-12.md");
  assert.equal(routeKey("adam-boris-adam-boris-pravidla-20261018-195432.md", "boris"), "pravidla-20261018-195432.md");
  assert.equal(routeKey("cyril-pravidla-20261018-195432-5.md", "adam"), "pravidla-20261018-195432-5.md");
  assert.equal(routeKey("adam-20261018-195432-12.md", "adam"), "20261018-195432-12.md");
  assert.equal(routeKey("boris-20261018-195432.md", "boris"), "20261018-195432.md");
});

test("rememberRoute a routeFor: trasa len podľa k:, nová správa podľa témy, hlavné vlákno trasu ruší", () => {
  const { cfg } = setup();
  const A = "adam-pravidla-20261018-195432-12.md";
  const r = rememberRoute(cfg, { name: A, thread: "thr-tema", peer: "boris" });
  assert.equal(r.thread, "thr-tema");
  assert.equal(routeFor(cfg, "boris-adam-pravidla-20261018-195432-12.md", A).thread, "thr-tema", "odpoveď Borisa s k:");
  assert.equal(routeFor(cfg, "boris-adam-pravidla-20261018-195432-12.md"), null, "bez k: meno nepovie nič");
  assert.equal(routeFor(cfg, "boris-pravidla-20261019-080000.md"), null, "nová správa Borisa bez k: trasu nemá");
  assert.equal(routeFor(cfg, "boris-iny_nazov-20261019-080000.md", "adam-ina-20261018-000000-1.md"), null, "k: bez záznamu");
  // Novšia trasa tej istej témy vyhrá.
  const B = "adam-pravidla-20261019-090000-13.md";
  rememberRoute(cfg, { name: B, thread: "thr-tema2", peer: "boris" });
  assert.equal(routeFor(cfg, "x", B).thread, "thr-tema2");
  assert.equal(routeFor(cfg, "x", A), null, "staršia trasa tej istej témy zanikla");
  // Hlavné vlákno trasu nepíše a zruší staršiu.
  const C = "adam-pravidla-20261019-110000-14.md";
  const m = rememberRoute(cfg, { name: C, thread: "thr-adam", peer: "boris" });
  assert.equal(m.main, true);
  assert.equal(routeFor(cfg, "x", B), null);
  assert.equal(readFileSync(join(cfg.state, "routes.json"), "utf8").includes("thr-tema2"), false);
  // Starý záznam vypadne.
  rememberRoute(cfg, { name: "adam-stare-20260901-000000-1.md", thread: "thr-x", now: Date.parse("2026-09-01T00:00:00Z") });
  rememberRoute(cfg, { name: "adam-nove-20261019-000000-1.md", thread: "thr-y" });
  assert.equal(routeFor(cfg, "x", "adam-stare-20260901-000000-1.md"), null);
});

test("sent: zápis, zavretie a znovuotvorenie kľúča, starnutie", () => {
  const { cfg } = setup();
  const X = "adam-x-20261019-100000-1.md";
  const w = (k) => waitingFor(cfg, "boris-" + k, Date.now(), k);
  assert.equal(w(X), null, "bez záznamu");
  rememberRoute(cfg, { name: X, thread: "thr-adam", peer: "boris", mode: "čakám" });
  assert.equal(w(X), true);
  assert.equal(waitingFor(cfg, X), null, "bez k: meno nepovie nič");
  // Vlastná odpoveď na vedomie kľúč zavrie, --cakam ho znova otvorí.
  rememberRoute(cfg, { name: X, thread: null, mode: "vedomie" });
  assert.equal(w(X), false);
  rememberRoute(cfg, { name: X, thread: null, mode: "cakam" });
  assert.equal(w(X), true);
  const Y = "adam-y-20261019-100000-2.md";
  rememberRoute(cfg, { name: Y, thread: null, mode: "nečakám" });
  assert.equal(w(Y), false);
  // Bez mode sa sent nemení, neznámy mode sa nezapíše.
  rememberRoute(cfg, { name: X, thread: null });
  assert.equal(w(X), true);
  // Starý záznam vypadne pri ďalšom zápise.
  const Z = "adam-z-20260901-000000-3.md";
  rememberRoute(cfg, { name: Z, thread: null, mode: "čakám", now: Date.parse("2026-09-01T00:00:00Z") });
  rememberRoute(cfg, { name: "adam-w-20261019-000000-4.md", thread: null, mode: "čakám" });
  assert.equal(w(Z), null);
});

test("threadForSession: samostatné vlákno mcp: (t3_thread_launch) sa nájde, mcp: s rodičom nie", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("mcp:dieta", { parentThreadId: "mcp:rodic", _providerThreads: [{ nativeThreadRef: { nativeId: "sid-d" } }] });
  t3.addThread("mcp:tema", { _providerThreads: [{ nativeThreadRef: { nativeId: "sid-t" } }] });
  const { cfg, client } = setup(t3);
  assert.equal(await threadForSession(cfg, client, ["sid-t"]), "mcp:tema");
  assert.equal(await threadForSession(cfg, client, ["sid-d"]), null);
});

test("threadForSession: vlákno projektu podľa nativeThreadRef, sub-agenti sa preskočia, výsledok sa zapamätá", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thread:provider:claudeAgent:sub", { _providerThreads: [{ nativeThreadRef: { nativeId: "sid-1" } }] });
  t3.addThread("thread:project:p1:tema", { _providerThreads: [{ nativeThreadRef: { nativeId: "sid-1" } }] });
  t3.addThread("thread:project:p1:arch", { archived: true, _providerThreads: [{ nativeThreadRef: { nativeId: "sid-2" } }] });
  const { cfg, client } = setup(t3);
  assert.equal(await threadForSession(cfg, client, ["sid-1"]), "thread:project:p1:tema");
  assert.equal(await threadForSession(cfg, client, ["sid-2"]), "thread:project:p1:arch");
  assert.equal(await threadForSession(cfg, client, ["sid-9"]), null);
  const calls = t3.state.httpCalls.length;
  assert.equal(await threadForSession(cfg, client, ["nic", "sid-1"]), "thread:project:p1:tema");
  assert.equal(t3.state.httpCalls.length, calls, "druhýkrát z pamäte bez volania T3");
  assert.deepEqual(sessionIds({ CLAUDE_CODE_SESSION_ID: "abc" }), ["abc"]);
  assert.deepEqual(sessionIds({}), []);
});

test("threadForSession: holé UUID vlákno sa nájde, sub-agent a potomok s rodičom nie (chyba route 25. 10. 2026)", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thread:provider:x", { _providerThreads: [{ nativeThreadRef: { nativeId: "a" } }] });
  t3.addThread("thread:project:y", { _providerThreads: [{ nativeThreadRef: { nativeId: "b" } }] });
  t3.addThread("f23ea517-5acc-4f48-8a1c-000000000000", { _providerThreads: [{ nativeThreadRef: { nativeId: "9d9daf59" } }] });
  t3.addThread("mcp:z", { parentThreadId: "mcp:rodic", _providerThreads: [{ nativeThreadRef: { nativeId: "c" } }] });
  // Každé hľadanie s čistým stavom, výsledok sa inak zapamätá v routes.json.
  const find = async (ids) => threadForSession(setup(t3).cfg, new T3Client({ url: t3.url, token: t3.token, timeoutMs: 3000 }), ids);
  assert.equal(await find(["9d9daf59"]), "f23ea517-5acc-4f48-8a1c-000000000000");
  assert.equal(await find(["a"]), null, "sub-agent patrí rodičovi");
  assert.equal(await find(["c"]), null, "potomok s parentThreadId");
  assert.equal(await find(["b"]), "thread:project:y");
});

// Proces claude, ktorého príkazový riadok nesie dané prepínače (T3 0.1.5 ide s --session-id).
async function claudeLike(t, ...flags) {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 20000)", "--", ...flags], { stdio: "ignore" });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((r) => child.once("spawn", r));
  return child;
}

test("sessionIds a threadForSession: po /clear nájde vlákno cez --session-id z príkazového riadku (chyba 31. 10. 2026)", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  const NATIVE = "7d391009-1ca8-464c-a5a3-b01230b8a2fe";
  const CLEARED = "555dc9f2-8713-4eed-93d0-bda23c94b623";
  t3.addThread("ae961f07-2ff5-4441-8556-bd2ba48b5968", { _providerThreads: [{ nativeThreadRef: { nativeId: NATIVE } }] });
  const find = async (env) => threadForSession(setup(t3).cfg, new T3Client({ url: t3.url, token: t3.token, timeoutMs: 3000 }), sessionIds(env));
  for (const flags of [[`--session-id=${NATIVE}`], ["--session-id", NATIVE]]) {
    const child = await claudeLike(t, ...flags);
    const env = { CLAUDE_CODE_SESSION_ID: CLEARED, CLAUDE_PID: String(child.pid) };
    assert.deepEqual(sessionIds(env), [CLEARED, NATIVE], flags.join(" "));
    assert.equal(await find(env), "ae961f07-2ff5-4441-8556-bd2ba48b5968", flags.join(" "));
  }
  // --resume ďalej funguje, obe tvary.
  for (const flags of [[`--resume=${NATIVE}`], ["--resume", NATIVE]]) {
    const child = await claudeLike(t, ...flags);
    const env = { CLAUDE_CODE_SESSION_ID: CLEARED, CLAUDE_PID: String(child.pid) };
    assert.deepEqual(sessionIds(env), [CLEARED, NATIVE], flags.join(" "));
    assert.equal(await find(env), "ae961f07-2ff5-4441-8556-bd2ba48b5968", flags.join(" "));
  }
  // Oba prepínače naraz, bez duplicít; id prostredia ostáva prvé.
  const OTHER = "11111111-2222-4333-8444-555555555555";
  const both = await claudeLike(t, `--resume=${OTHER}`, `--session-id=${NATIVE}`, `--resume=${OTHER}`);
  assert.deepEqual(sessionIds({ CLAUDE_CODE_SESSION_ID: NATIVE, CLAUDE_PID: String(both.pid) }), [NATIVE, OTHER]);
  assert.deepEqual(sessionIds({ CLAUDE_PID: "999999999" }), [], "neexistujúci proces");
});

test("callerThread: T3CODE_THREAD_ID platí bez volania T3, prázdne ide cez reláciu", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  const { root, cfg } = setup(t3);
  cfg.t3TokenFile = join(root, "t3_token");
  writeFileSync(cfg.t3TokenFile, t3.token);
  const before = t3.state.httpCalls.length;
  assert.deepEqual(await callerThread(cfg, { T3CODE_THREAD_ID: "thread:project:p1:tema", CLAUDE_CODE_SESSION_ID: "nezname" }), { thread: "thread:project:p1:tema" });
  assert.deepEqual(await callerThread(cfg, { T3CODE_THREAD_ID: "mcp:tema" }), { thread: "mcp:tema" }, "aj bez relácie");
  assert.equal(t3.state.httpCalls.length, before, "bez volania T3");
  const r = await callerThread(cfg, { T3CODE_THREAD_ID: "", CLAUDE_CODE_SESSION_ID: "nezname" });
  assert.match(r.fail, /vlákno pre reláciu nezname som v T3 nenašiel/);
  assert.deepEqual(await callerThread(cfg, { T3CODE_THREAD_ID: "" }), { fail: "bez CLAUDE_CODE_SESSION_ID" });
});

test("route.mjs remember: T3CODE_THREAD_ID zapíše trasu, aj keď relácia v T3 nie je", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  const { root, cfg, box, state } = setup(t3);
  const tokenFile = join(root, "t3_token");
  writeFileSync(tokenFile, t3.token);
  const env = { PATH: process.env.PATH, HOME: root, AGENT_NAME: "adam", AGENT_BOX: box, AGENT_STATE: state, AGENT_ENV_FILE: "/nie/je",
    T3_URL: t3.url, T3_TOKEN_FILE: tokenFile, CLAUDE_PID: "", CLAUDE_CODE_SESSION_ID: "nie-je-v-t3", T3CODE_THREAD_ID: "thread:project:p1:tema" };
  const name = "adam-pravidla-20261031-010101-1.md";
  let r = await run("route.mjs", ["remember", name, "--peer", "boris"], { env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /-> thread:project:p1:tema/);
  assert.equal(routeFor(cfg, `boris-${name}`, name).thread, "thread:project:p1:tema");
  // Bez T3CODE_THREAD_ID a s reláciou mimo T3 trasa nevznikne.
  const name2 = "adam-pravidla-20261031-010102-2.md";
  r = await run("route.mjs", ["remember", name2, "--peer", "boris"], { env: { ...env, T3CODE_THREAD_ID: "" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /vlákno pre reláciu nie-je-v-t3 som v T3 nenašiel/);
  assert.equal(routeFor(cfg, `boris-${name2}`, name2), null);
});

test("budič: správa s trasou ide do vlákna témy, zaneprázdnené vlákno témy hlavné nezdrží", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thr-adam");
  t3.addThread("thr-tema", { status: "running", activeRunId: "run-t" });
  const { cfg, client, box, put } = setup(t3);
  rememberRoute(cfg, { name: "adam-pravidla-20261018-195432-12.md", thread: "thr-tema" });
  put("boris-adam-pravidla-20261018-195432-12.md", `odpoveď: nečakám\nk: adam-pravidla-20261018-195432-12.md\nOK`);
  put("cyril-ina-20261018-200000-1.md", "pre hlavné");
  let r = await tick(cfg, client);
  assert.deepEqual(r.files, ["cyril-ina-20261018-200000-1.md"]);
  assert.equal(t3.state.messages[0].threadId, "thr-adam");
  r = await tick(cfg, client);
  assert.equal(r.sent, 0);
  assert.match(r.reason, /thr-tema: beží run-t/);
  t3.finishRun("thr-tema");
  r = await tick(cfg, client);
  assert.deepEqual(r.files, ["boris-adam-pravidla-20261018-195432-12.md"]);
  assert.equal(r.threadId, "thr-tema");
  assert.equal(t3.state.messages[1].threadId, "thr-tema");
  assert.match(t3.state.messages[1].text, /<schranka od="boris" id="boris-adam-pravidla-20261018-195432-12.md"( odpoveď="nečakám")?>/);
  assert.doesNotMatch(t3.state.messages[1].text, /\[budič\]/);
  assert.equal(readdirSync(join(box, "processed")).length, 2);
});

test("budič: zaniknuté alebo archivované vlákno z trasy nahradí hlavné s poznámkou", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thr-adam");
  t3.addThread("thr-arch", { archived: true, title: "Stará téma" });
  const { cfg, client, state, put } = setup(t3);
  rememberRoute(cfg, { name: "adam-a-20261018-195432-1.md", thread: "thr-arch" });
  rememberRoute(cfg, { name: "adam-b-20261018-195432-2.md", thread: "thr-prec" });
  put("boris-adam-a-20261018-195432-1.md", `odpoveď: nečakám\nk: adam-a-20261018-195432-1.md\nA`);
  put("boris-adam-b-20261018-195432-2.md", `odpoveď: nečakám\nk: adam-b-20261018-195432-2.md\nB`);
  const r = await tick(cfg, client);
  assert.equal(r.sent, 2);
  const text = t3.state.messages[0].text;
  assert.equal(t3.state.messages[0].threadId, "thr-adam");
  assert.match(text, /\[budič\] Správa patrí vláknu thr-arch \(Stará téma\), to je archivované, preto je tu\.\n<schranka od="boris" id="boris-adam-a/);
  assert.match(text, /\[budič\] Správa patrí vláknu thr-prec, to neexistuje alebo je archivované \(T3 0\.1\.0 archivované vlákna nevracia\), preto je tu\.\n<schranka/);
  // Rozpracovaná dávka, ktorej vlákno medzitým zaniklo, ide do hlavného.
  t3.finishRun("thr-adam");
  writeFileSync(join(state, "inflight.json"), JSON.stringify({ files: ["boris-adam-c-20261018-195432-3.md"], attempt: 1, batch: "b", threadId: "thr-zmizlo" }));
  put("boris-adam-c-20261018-195432-3.md", "C");
  const r2 = await tick(cfg, client);
  assert.equal(r2.sent, 1);
  assert.equal(t3.state.messages[1].threadId, "thr-adam");
  assert.match(t3.state.messages[1].text, /patrí vláknu thr-zmizlo, to neexistuje alebo je archivované/);
  assert.equal(existsSync(join(state, "inflight.json")), false);
});

test("ask_agent.sh a reply.sh: správa do schránky adresáta a trasa z vlákna témy, hlavné vlákno bez trasy", { skip: SKIP_ASK }, async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thread:project:p1:main", { _providerThreads: [{ nativeThreadRef: { nativeId: "sid-main" } }] });
  t3.addThread("thread:project:p1:tema", { _providerThreads: [{ nativeThreadRef: { nativeId: "sid-tema" } }] });
  const { root, cfg, box, state } = setup(t3);
  writeFileSync(join(state, "thread_id"), "thread:project:p1:main\n");
  const borisInbox = join(root, "boris_inbox");
  mkdirSync(borisInbox);
  const tokenFile = join(root, "t3_token");
  writeFileSync(tokenFile, t3.token);
  const env = { PATH: process.env.PATH, HOME: root, AGENT_NAME: "adam", AGENT_INBOX_ONLY: "cyril", AGENT_BOX: box, AGENT_STATE: state, AGENT_ENV_FILE: "/nie/je",
    T3_URL: t3.url, T3_TOKEN_FILE: tokenFile, AGENT_SEND_boris: borisInbox, CLAUDE_PID: "", TASKER_DB: join(root, "nie.db"),
    ASK_VAR_LIB: join(root, "var"), AGENT_SEND_cyril: join(root, "var/cyril/inbox") };
  mkdirSync(join(root, "var/cyril/inbox"), { recursive: true });
  // Z vlákna témy.
  let r = await runIn("ask_agent.sh", ["boris", "pravidla"], { env: { ...env, CLAUDE_CODE_SESSION_ID: "sid-tema" } }, "Test\n");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /route: pravidla-\S+ -> thread:project:p1:tema/);
  const [name] = readdirSync(borisInbox);
  assert.match(name, /^adam-pravidla-\d{8}-\d{6}-\d+\.md$/);
  assert.equal(readFileSync(join(borisInbox, name), "utf8"), `odpoveď: čakám\nid: ${name}\nod: adam\nkomu: boris\ntéma: pravidla\nTest\n`);
  assert.equal(routeFor(cfg, `boris-${name}`, name).thread, "thread:project:p1:tema");
  assert.equal(waitingFor(cfg, `boris-${name}`, Date.now(), name), true, "ask_agent.sh predvolene čaká");
  assert.equal(routeFor(cfg, "boris-pravidla-20261019-120000.md"), null, "nová správa bez k: trasu nemá");
  // Odpoveď Borisovi z hlavného vlákna: trasu zruší. Odpovedať sa dá len na prijatú správu (úloha 709).
  writeFileSync(join(box, "processed", `boris-${name}`), `odpoveď: čakám\nid: boris-${name}\nod: boris\nkomu: adam\ntéma: pravidla\nPokyn\n`);
  r = await runIn("reply.sh", [`boris-${name}`], { env: { ...env, CLAUDE_CODE_SESSION_ID: "sid-main" } }, "Ďakujem.\n" + TRI);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /hlavné vlákno, bez trasy/);
  assert.equal(routeFor(cfg, `boris-${name}`, `boris-${name}`), null);
  assert.equal(waitingFor(cfg, `boris-${name}`, Date.now(), `boris-${name}`), false, "odpoveď na vedomie kľúč zavrie");
  // --necakam skript odmietne kódom 1 a nič nezapíše (chyba 20. 10. 2026 dvakrát).
  const before = readdirSync(borisInbox).length;
  r = await run("ask_agent.sh", ["--necakam", "boris", "pravidla", "Bez čakania"], { env: { ...env, CLAUDE_CODE_SESSION_ID: "sid-main" } });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /Prepínač --necakam neexistuje.*--vedomie/);
  assert.equal(readdirSync(borisInbox).length, before, "nič sa nezapísalo");
  let f;
  r = await run("ask_agent.sh", ["boris", "pravidla", "--vedomie", "--dopad", "Mení sa tvoj postup", "Hlásenie"], { env: { ...env, CLAUDE_CODE_SESSION_ID: "" } });
  assert.equal(r.status, 0, r.stderr);
  f = readdirSync(borisInbox).find((x) => readFileSync(join(borisInbox, x), "utf8").includes("Hlásenie"));
  assert.match(readFileSync(join(borisInbox, f), "utf8"), /^odpoveď: na vedomie\n/);
  assert.match(readFileSync(join(borisInbox, f), "utf8"), /téma: pravidla\ndopad: Mení sa tvoj postup\nHlásenie\n$/);
  // Nová správa --vedomie bez --dopad: kód 1, nič sa nezapíše. S --k prejde aj bez --dopad.
  const cnt = readdirSync(borisInbox).length;
  for (const extra of [[], ["--dopad", "  "]]) {
    r = await run("ask_agent.sh", ["boris", "pravidla", "--vedomie", ...extra, "Bez dopadu"], { env: { ...env, CLAUDE_CODE_SESSION_ID: "" } });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /^Správa na vedomie bez --dopad: .* Nič som neposlal\.\n$/);
  }
  assert.equal(readdirSync(borisInbox).length, cnt, "bez --dopad sa nič nezapísalo");
  writeFileSync(join(box, "processed", "boris-odpoved-20261019-100000-1.md"), "odpoveď: čakám\nid: boris-odpoved-20261019-100000-1.md\nod: boris\nkomu: adam\ntéma: pravidla\nPokyn\n");
  r = await run("ask_agent.sh", ["--vedomie", "--k", "boris-odpoved-20261019-100000-1.md", "boris", "pravidla", "Odpoveď bez dopadu"], { env: { ...env, CLAUDE_CODE_SESSION_ID: "" } });
  assert.equal(r.status, 0, r.stderr);
  const rf = readdirSync(borisInbox).find((x) => readFileSync(join(borisInbox, x), "utf8").includes("Odpoveď bez dopadu"));
  assert.ok(!/dopad:/.test(readFileSync(join(borisInbox, rf), "utf8")), "odpoveď s --k dopad nenesie");
  assert.equal(waitingFor(cfg, `boris-${f}`, Date.now(), f), false, "sent sa zapíše aj bez relácie");
  // Odpoveď Cyrilovi z vlákna témy: ďalšia správa Cyrila s tou témou ide do témy.
  writeFileSync(join(box, "processed", "cyril-kanon-20261019-100000-7.md"), "odpoveď: čakám\nid: cyril-kanon-20261019-100000-7.md\nod: cyril\nkomu: adam\ntéma: kanon\nPokyn\n");
  r = await runIn("reply.sh", ["cyril-kanon-20261019-100000-7.md"], { env: { ...env, CLAUDE_CODE_SESSION_ID: "sid-tema" } }, "Hotovo: x\n" + TRI);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(routeFor(cfg, "cyril-kanon-20261019-110000-8.md", "cyril-kanon-20261019-100000-7.md").thread, "thread:project:p1:tema");
  // Cyril má vlastnú schránku na serveri: odpoveď (reply.sh) aj nová správa idú tam, outbox je prázdny.
  assert.ok(readdirSync(join(root, "var/cyril/inbox")).some((f) => /^adam-cyril-kanon-/.test(f)), "odpoveď Cyrilovi");
  r = await run("ask_agent.sh", ["cyril", "kanon", "Pozri"], { env: { ...env, CLAUDE_CODE_SESSION_ID: "" } });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(readdirSync(join(root, "var/cyril/inbox")).some((f) => /^adam-kanon-\d{8}-/.test(f)));
  assert.equal(readdirSync(join(box, "outbox")).filter((f) => /^(cyril|adam)-/.test(f)).length, 0, "nič pre Cyrila v outboxe");
  // Bez T3 (zlá URL) správa odíde, trasa nie.
  r = await run("ask_agent.sh", ["boris", "pravidla", "Bez T3"], { env: { ...env, T3_URL: "http://127.0.0.1:1", CLAUDE_CODE_SESSION_ID: "sid-x" } });
  assert.equal(r.status, 0);
  assert.match(r.stderr, /route: .*hlavného vlákna/);
  assert.equal(readdirSync(borisInbox).length, 4);
  assert.equal((await run("ask_agent.sh", ["boris", "Zla tema", "x"], { env })).status, 1);
  // Adresát bez schránky na serveri ide cez ssh, falošné ssh zlyhá.
  const fbin = join(root, "fbin");
  mkdirSync(fbin);
  writeFileSync(join(fbin, "ssh"), "#!/bin/bash\nexit 255\n");
  chmodSync(join(fbin, "ssh"), 0o755);
  assert.equal((await run("ask_agent.sh", ["nikto", "tema", "x"], { env: { ...env, PATH: `${fbin}:${env.PATH}`, ASK_HOST: "x" } })).status, 1);
});

test("zoznam tém: zápis, mazanie, práva 640, téma novej správy, remember tému nezapisuje (D0211)", () => {
  const { cfg, box } = setup();
  assert.equal(topicsPath(cfg), join(box, "topics.json"), "zoznam leží v schránke, nie v stave");
  assert.equal(setTopic(cfg, "pravidla", "thr-a"), true);
  assert.equal(readTopics(topicsPath(cfg)).pravidla.thread, "thr-a");
  assert.equal(statSync(topicsPath(cfg)).mode & 0o777, 0o640);
  assert.match(readFileSync(topicsPath(cfg), "utf8"), /^ "pravidla": \{$/m, "riadok, ktorý hľadá ask_agent.sh");
  assert.throws(() => setTopic(cfg, "Zla tema", "thr-a"));
  assert.equal(removeTopic(cfg, "pravidla"), true);
  assert.equal(removeTopic(cfg, "pravidla"), false);
  assert.equal(messageTopic("cyril-pravidla-20261019-100000-1.md", "adam"), "pravidla");
  assert.equal(messageTopic("boris-adam-pravidla-20261019-100000-1.md", "adam"), null, "odpoveď na správu agenta");
  assert.equal(messageTopic("boris-adam-20261019-100000-1.md", "adam"), null, "odpoveď na správu bez témy");
  assert.equal(messageTopic("boris-20261019-100000-1.md", "adam"), null);
  assert.equal(messageTopic("tasker-20261019-100000-1-abcd.md", "adam"), null);
  assert.equal(messageTopic("tasker-projekt_b-20261019-100000-1-abcd.md", "adam"), "projekt_b", "tasker správa k téme projektu");
  assert.equal(messageTopic("ranny-20261019-100000-1.md", "adam"), null);
  // Zmena správania D0211 (28. 10. 2026): remember tému správy do zoznamu nezapíše ani
  // z vlákna témy, zapíše len trasu a pri téme mimo zoznamu vráti `unlisted`.
  // Starý test tu čakal zápis témy kanon.
  setTopic(cfg, "pravidla", "thr-a");
  assert.equal(rememberRoute(cfg, { name: "adam-kanon-20261019-100000-1.md", thread: "thr-adam", peer: "boris" }).unlisted, null, "hlavné vlákno");
  const r = rememberRoute(cfg, { name: "adam-kanon-20261019-100000-2.md", thread: "thr-tema", peer: "boris" });
  assert.equal(r.unlisted, "kanon");
  assert.equal(r.thread, "thr-tema", "trasa sa zapíše");
  assert.equal(readTopics(topicsPath(cfg)).kanon, undefined);
  assert.equal(rememberRoute(cfg, { name: "cyril-pravidla-20261019-100000-3.md", thread: "thr-ina" }).unlisted, null, "téma v zozname");
  assert.equal(readTopics(topicsPath(cfg)).pravidla.thread, "thr-a");
});

test("budič: správa tasker-<téma> ide do vlákna témy", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thr-adam");
  t3.addThread("thr-pravidla", { title: "Pravidlá" });
  const { cfg, client, put } = setup(t3);
  setTopic(cfg, "pravidla", "thr-pravidla");
  put("tasker-pravidla-20261019-100000-1-abcd.md", "odpoveď: čakám\nÚloha projektu");
  const r = await tick(cfg, client);
  assert.equal(r.threadId, "thr-pravidla");
});

test("budič: nová správa k téme ide do vlákna zo zoznamu, neznáma téma a zaniknuté vlákno do hlavného s riadkom [budič]", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thr-adam");
  t3.addThread("thr-pravidla", { title: "Pravidlá" });
  t3.addThread("thr-arch", { archived: true, title: "Stará" });
  const { cfg, client, put } = setup(t3);
  setTopic(cfg, "pravidla", "thr-pravidla");
  setTopic(cfg, "stara", "thr-arch");
  setTopic(cfg, "prec", "thr-prec");
  put("cyril-pravidla-20261019-100000-1.md", "odpoveď: čakám\nK pravidlám");
  let r = await tick(cfg, client);
  assert.equal(r.threadId, "thr-pravidla");
  assert.doesNotMatch(t3.state.messages[0].text, /\[budič\]/);
  put("cyril-nezname-20261019-100000-2.md", "odpoveď: čakám\nA");
  put("cyril-stara-20261019-100000-3.md", "odpoveď: čakám\nB");
  put("cyril-prec-20261019-100000-4.md", "odpoveď: čakám\nC");
  put("boris-adam-20261019-100000-5.md", "odpoveď: čakám\nOdpoveď bez témy");
  put("tasker-20261019-100000-6-abcd.md", "odpoveď: čakám\nÚloha");
  r = await tick(cfg, client);
  assert.equal(r.sent, 5);
  assert.equal(r.threadId, undefined, "hlavné vlákno");
  const text = t3.state.messages[1].text;
  assert.match(text, /^\[budič\] Vlákno témy nezname som nenašiel \(téma nie je v zozname tém\), posielam do hlavného vlákna\.\nVec nerob, kým nezistíš, či tému nevedie iné vlákno[^\n]*\n<schranka od="cyril" tema="nezname"/m);
  assert.match(text, /\[budič\] Vlákno témy stara som nenašiel \(vlákno thr-arch \(Stará\) je archivované\), posielam do hlavného vlákna\./);
  assert.match(text, /\[budič\] Vlákno témy prec som nenašiel \(vlákno thr-prec neexistuje alebo je archivované \(T3 0\.1\.0 archivované vlákna nevracia\)\), posielam do hlavného vlákna\./);
  assert.equal(text.match(/\[budič\]/g).length, 3, "odpoveď a správa Taskera riadok nemajú");
});

test("budič: agent bez zoznamu tém dostane správu k téme do hlavného vlákna bez riadku [budič]", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thr-adam");
  const { cfg, client, put } = setup(t3);
  assert.equal(existsSync(topicsPath(cfg)), false);
  put("adam-kontrola-20261019-100000-1.md", "odpoveď: čakám\nPokyn");
  const r = await tick(cfg, client);
  assert.equal(r.threadId, undefined, "hlavné vlákno");
  assert.doesNotMatch(t3.state.messages[0].text, /\[budič\]/);
});

test("route.mjs topic a ask_agent.sh: téma zo zoznamu adresáta, neznáma odmietnutá, --hlavne bez témy", { skip: SKIP_ASK }, async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thread:project:p1:main", { _providerThreads: [{ nativeThreadRef: { nativeId: "sid-main" } }] });
  t3.addThread("thread:project:p1:tema", { _providerThreads: [{ nativeThreadRef: { nativeId: "sid-tema" } }] });
  const { root, cfg, box, state } = setup(t3);
  writeFileSync(join(state, "thread_id"), "thread:project:p1:main\n");
  const tokenFile = join(root, "t3_token");
  writeFileSync(tokenFile, t3.token);
  const env = { PATH: process.env.PATH, HOME: root, AGENT_BOX: box, AGENT_STATE: state, AGENT_ENV_FILE: "/nie/je",
    T3_URL: t3.url, T3_TOKEN_FILE: tokenFile, CLAUDE_PID: "", TASKER_DB: join(root, "nie.db") };
  // topic set z vlákna témy áno, z hlavného nie.
  let r = await run("route.mjs", ["topic", "set", "pravidla"], { env: { ...env, CLAUDE_CODE_SESSION_ID: "sid-tema" } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /téma pravidla -> thread:project:p1:tema/);
  r = await run("route.mjs", ["topic", "set", "guard"], { env: { ...env, CLAUDE_CODE_SESSION_ID: "sid-main" } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /hlavné vlákno tému nevedie/);
  r = await run("route.mjs", ["topic", "list"], { env });
  assert.equal(r.stdout, "pravidla thread:project:p1:tema\n");
  // Boris píše Adamovi: AGENT_SEND_adam je schránka Adama, zoznam leží vedľa nej.
  const borisEnv = { ...env, AGENT_NAME: "boris", AGENT_BOX: join(root, "borisbox"), AGENT_STATE: join(root, "borisstate"), AGENT_SEND_adam: join(box, "inbox"), CLAUDE_CODE_SESSION_ID: "" };
  mkdirSync(join(root, "borisbox", "outbox"), { recursive: true });
  r = await run("ask_agent.sh", ["adam", "nezname", "x"], { env: borisEnv });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Téma 'nezname' nie je v zozname tém adresáta .*Platné témy: pravidla\./);
  assert.match(r.stderr, /--hlavne/);
  assert.equal(readdirSync(join(box, "inbox")).length, 0, "nič neodišlo");
  r = await run("ask_agent.sh", ["adam", "pravidla", "K pravidlám"], { env: borisEnv });
  assert.equal(r.status, 0, r.stderr);
  r = await run("ask_agent.sh", ["--hlavne", "--vedomie", "--dopad", "Mení sa X", "adam", "Do hlavného"], { env: borisEnv });
  assert.equal(r.status, 0, r.stderr);
  const names = readdirSync(join(box, "inbox")).sort();
  assert.equal(names.length, 2);
  assert.ok(names.some((n) => /^boris-pravidla-\d{8}-\d{6}-\d+\.md$/.test(n)));
  const plain = names.find((n) => /^boris-\d{8}-\d{6}-\d+\.md$/.test(n));
  assert.ok(plain, "--hlavne bez témy v mene");
  assert.equal(readFileSync(join(box, "inbox", plain), "utf8"), `odpoveď: na vedomie\nid: ${plain}\nod: boris\nkomu: adam\ntéma: \ndopad: Mení sa X\nDo hlavného\n`);
  // Budič Adama: téma zo zoznamu do vlákna témy, správa bez témy do hlavného bez riadku.
  t3.addThread("thr-adam");
  const tr = await tick({ ...cfg, batchWaitMs: 0 }, new T3Client({ url: t3.url, token: t3.token, timeoutMs: 3000 }));
  assert.equal(tr.sent, 1);
  r = await run("route.mjs", ["topic", "rm", "pravidla"], { env });
  assert.equal(r.status, 0);
  r = await run("route.mjs", ["topic", "check", "pravidla", "--file", join(root, "nie", "topics.json")], { env });
  assert.equal(r.status, 0, "adresát bez zoznamu prijme každú tému");
});

test("k: odpoveď z Macu s novým menom sa páruje podľa id pôvodnej správy, stará správa bez k: sa drží", async () => {
  const { cfg, box, put } = setup();
  // Adam poslal Cyrilovi správu z vlákna témy a čaká.
  const sent = "adam-cloudflare-20261020-220040-1183814.md";
  rememberRoute(cfg, { name: sent, thread: "thr-tema", peer: "cyril", mode: "čakám" });
  // Odpoveď Cyrila s novým menom (v mene nie je kľúč pôvodnej správy), len k: v hlavičke.
  const reply = "cyril-iny_nazov-20261021-090000-5.md";
  assert.equal(routeFor(cfg, reply), null, "bez k: meno nepovie nič");
  assert.equal(routeFor(cfg, reply, sent).thread, "thr-tema");
  assert.equal(waitingFor(cfg, reply, Date.now(), sent), true);
  assert.equal(waitingFor(cfg, reply, Date.now(), "adam-neznama-20261020-000000-1.md"), null, "k: bez záznamu");
  assert.equal(routeFor(cfg, "cyril-cloudflare-20261021-090000-5.md", "adam-neznama-20261020-000000-1.md"), null, "s k: sa téma nepoužije");
  // Budič: odpoveď na vedomie s k: zobudí, bez k: a s neznámym menom drží.
  put(reply, `odpoveď: na vedomie\nid: ${reply}\nod: cyril\nkomu: adam\ntéma: \nk: ${sent}\nToken: x\n`);
  assert.equal(classify(cfg, reply).wake, true);
  const other = "cyril-druha-20261021-090100-6.md";
  put(other, `odpoveď: na vedomie\nid: ${other}\nod: cyril\nkomu: adam\ntéma: \nk: adam-neznama-20261020-000000-1.md\nIné\n`);
  assert.equal(classify(cfg, other).wake, false, "k: bez záznamu a bez `k správe: čakám` sa drží");
  // Správa bez k: sa podľa mena a témy nepáruje, drží sa.
  const old = "cyril-cloudflare-20261021-091500-7.md";
  put(old, "odpoveď: na vedomie\nStaré\n");
  assert.equal(classify(cfg, old).wake, false);
  // Vlákno v T3: render nezobrazí hlavičku modelu.
  assert.doesNotMatch(renderMessage(box, reply), /^id:|^k: /m);
  assert.match(renderMessage(box, reply), /Token: x/);
});

// Tasker s úlohami projektov (fixtúra v tmp, nie živý Tasker).
function taskerFixture(root, projects) {
  const db = join(root, "tasker.db");
  const d = new DatabaseSync(db);
  d.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', assignee TEXT, project TEXT)");
  projects.forEach((p, i) => d.prepare("INSERT INTO tasks (id, title, project) VALUES (?,?,?)").run(i + 1, "u", p));
  d.close();
  return db;
}

test("chyba 28. 10. 2026: remember správy s novou témou bežiacemu vláknu tému nezapíše, trasu áno, vypíše nové vlákno", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thr-A", { _providerThreads: [{ nativeThreadRef: { nativeId: "sid-A" } }] });
  const { root, cfg, box, state } = setup(t3);
  const tokenFile = join(root, "t3_token");
  writeFileSync(tokenFile, t3.token);
  const env = { PATH: process.env.PATH, HOME: root, AGENT_NAME: "adam", AGENT_BOX: box, AGENT_STATE: state, AGENT_ENV_FILE: "/nie/je",
    T3_URL: t3.url, T3_TOKEN_FILE: tokenFile, CLAUDE_PID: "", TASKER_DB: join(root, "nie.db"), CLAUDE_CODE_SESSION_ID: "sid-A" };
  setTopic(cfg, "agenti_9e4abe", "thr-A");
  const before = readFileSync(topicsPath(cfg), "utf8");
  const name = "boris-agentic_brain-20261028-231412.md";
  const r = await run("route.mjs", ["remember", name, "--peer", "boris"], { env });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(topicsPath(cfg), "utf8"), before, "zoznam tém sa nezmenil");
  assert.match(r.stderr, /route: téma agentic_brain v zozname tém nie je, založ pre ňu nové vlákno T3 a z neho spusti route\.mjs topic set agentic_brain \(D0211\)/);
  assert.equal(routeFor(cfg, name, name).thread, "thr-A", "trasa správy je zapísaná");
});

test("route.mjs topic set: holý projekt Taskera, druhá téma vlákna a téma iného vlákna bez --force a s --force (D0211)", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thr-A", { _providerThreads: [{ nativeThreadRef: { nativeId: "sid-A" } }] });
  t3.addThread("thr-B", { _providerThreads: [{ nativeThreadRef: { nativeId: "sid-B" } }] });
  const { root, cfg, box, state } = setup(t3);
  const tokenFile = join(root, "t3_token");
  writeFileSync(tokenFile, t3.token);
  const db = taskerFixture(root, ["agenti", "agenti", "iny_projekt"]);
  const env = { PATH: process.env.PATH, HOME: root, AGENT_NAME: "adam", AGENT_BOX: box, AGENT_STATE: state, AGENT_ENV_FILE: "/nie/je",
    T3_URL: t3.url, T3_TOKEN_FILE: tokenFile, CLAUDE_PID: "", TASKER_DB: db, CLAUDE_CODE_SESSION_ID: "sid-A" };
  const noTasker = { ...env, TASKER_DB: join(root, "nie.db") };
  // (b) holý názov projektu.
  let r = await run("route.mjs", ["topic", "set", "agenti"], { env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /holý názov projektu Taskera.*Správny postup:/);
  assert.equal(existsSync(topicsPath(cfg)), false, "nič sa nezapísalo");
  // Bez čitateľného Taskera kontrola mlčí a tému pustí.
  r = await run("route.mjs", ["topic", "set", "agenti"], { env: noTasker });
  assert.equal(r.status, 0, r.stderr);
  r = await run("route.mjs", ["topic", "rm", "agenti"], { env });
  assert.equal(r.status, 0);
  // Pomenovaná téma prejde.
  r = await run("route.mjs", ["topic", "set", "agenti_9e4abe"], { env });
  assert.equal(r.status, 0, r.stderr);
  // (c) druhá téma toho istého vlákna.
  r = await run("route.mjs", ["topic", "set", "agentic_brain"], { env });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /vlákno thr-A už vedie tému agenti_9e4abe.*Správny postup: založ pre tému agentic_brain nové vlákno T3/);
  assert.equal(readTopics(topicsPath(cfg)).agentic_brain, undefined);
  r = await run("route.mjs", ["topic", "set", "agentic_brain", "--force"], { env });
  assert.equal(r.status, 2, "--force bez dôvodu");
  r = await run("route.mjs", ["topic", "set", "agentic_brain", "--force", "dve témy jednej práce"], { env });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /vlákno thr-A teraz vedie témy agenti_9e4abe, agentic_brain/);
  assert.equal(readTopics(topicsPath(cfg)).agentic_brain.thread, "thr-A");
  // Tá istá téma tomu istému vláknu znova je v poriadku, tretia téma bez --force nie.
  r = await run("route.mjs", ["topic", "set", "agentic_brain"], { env: noTasker });
  assert.equal(r.status, 1, "vlákno vedie už aj agenti_9e4abe");
  r = await run("route.mjs", ["topic", "set", "tretia_tema"], { env: noTasker });
  assert.equal(r.status, 1);
  // Téma, ktorú vedie iné vlákno: odmietnutie bez --force, prevzatie s --force vypíše staré aj nové vlákno.
  const envB = { ...noTasker, CLAUDE_CODE_SESSION_ID: "sid-B" };
  r = await run("route.mjs", ["topic", "set", "agenti_9e4abe"], { env: envB });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Správny postup: tému agenti_9e4abe vedie vlákno thr-A, píš o nej tam; prevzatie s dôvodom dovolí --force/);
  assert.equal(readTopics(topicsPath(cfg)).agenti_9e4abe.thread, "thr-A", "téma ostala vláknu A");
  r = await run("route.mjs", ["topic", "set", "agenti_9e4abe", "--force", "vlákno A skončilo"], { env: envB });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tému agenti_9e4abe som prevzal od vlákna thr-A \(staré vlákno thr-A, nové vlákno thr-B/);
  assert.equal(readTopics(topicsPath(cfg)).agenti_9e4abe.thread, "thr-B");
});

test("ask_agent.sh: nová správa s témou mimo zoznamu odosielateľa alebo z cudzieho vlákna sa neodošle (chyba 28. 10. 2026, D0211)", { skip: SKIP_ASK }, async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thr-main", { _providerThreads: [{ nativeThreadRef: { nativeId: "sid-main" } }] });
  t3.addThread("thr-A", { _providerThreads: [{ nativeThreadRef: { nativeId: "sid-A" } }] });
  t3.addThread("thr-B", { _providerThreads: [{ nativeThreadRef: { nativeId: "sid-B" } }] });
  const { root, cfg, box, state } = setup(t3);
  writeFileSync(join(state, "thread_id"), "thr-main\n");
  const tokenFile = join(root, "t3_token");
  writeFileSync(tokenFile, t3.token);
  // Odosielateľ adam: tému agenti_9e4abe vedie vlákno A. Adresát boris má v zozname obe témy.
  setTopic(cfg, "agenti_9e4abe", "thr-A");
  const recvInbox = join(root, "boris", "inbox");
  mkdirSync(recvInbox, { recursive: true });
  const recvList = {};
  for (const x of ["agentic_brain", "agenti_9e4abe"]) recvList[x] = { thread: "thr-r", at: "2026-10-28T00:00:00Z" };
  writeFileSync(join(root, "boris", "topics.json"), JSON.stringify(recvList, null, 1) + "\n");
  const env = { PATH: process.env.PATH, HOME: root, AGENT_NAME: "adam", AGENT_BOX: box, AGENT_STATE: state, AGENT_ENV_FILE: "/nie/je",
    T3_URL: t3.url, T3_TOKEN_FILE: tokenFile, AGENT_SEND_boris: recvInbox, CLAUDE_PID: "", TASKER_DB: join(root, "nie.db") };
  // Prehratie chyby: nová téma agentic_brain z vlákna témy agenti_9e4abe.
  let r = await runIn("ask_agent.sh", ["boris", "agentic_brain"], { env: { ...env, CLAUDE_CODE_SESSION_ID: "sid-A" } }, "Test\n");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /Platné témy: agenti_9e4abe\./);
  assert.match(r.stderr, /Správny postup: tému agentic_brain nemá žiadne vlákno, založ pre ňu nové vlákno T3 a z neho spusti route\.mjs topic set agentic_brain \(D0211\)/);
  assert.equal(readdirSync(recvInbox).length, 0, "nič v inboxe adresáta");
  assert.equal(existsSync(join(state, "routes.json")), false, "trasa sa nezapísala");
  // Téma zo zoznamu, ale z cudzieho vlákna: odmietnutá.
  r = await runIn("ask_agent.sh", ["boris", "agenti_9e4abe"], { env: { ...env, CLAUDE_CODE_SESSION_ID: "sid-B" } }, "Test\n");
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /Vlákno thr-B nevedie žiadnu tému, tému 'agenti_9e4abe' vedie vlákno thr-A\. Správny postup:/);
  assert.equal(readdirSync(recvInbox).length, 0);
  // Vlákno, ktoré tému vedie, ju pošle. Hlavné vlákno tiež (téma je v zozname).
  r = await runIn("ask_agent.sh", ["boris", "agenti_9e4abe"], { env: { ...env, CLAUDE_CODE_SESSION_ID: "sid-A" } }, "Test\n");
  assert.equal(r.status, 0, r.stderr);
  r = await runIn("ask_agent.sh", ["boris", "agenti_9e4abe"], { env: { ...env, CLAUDE_CODE_SESSION_ID: "sid-main" } }, "Test\n");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readdirSync(recvInbox).length, 2);
  // Odpoveď s --k patrí len na prijatú správu (úloha 709, nález 1 úlohy 710). Vymyslené id
  // s témou mimo oboch zoznamov: kód 1, nič v inboxe adresáta.
  const pred = readdirSync(recvInbox).length;
  const kEnv = { ...env, CLAUDE_CODE_SESSION_ID: "sid-A" };
  r = await run("ask_agent.sh", ["--vedomie", "--k", "boris-adam-20261028-100000-1.md", "boris", "agentic_brain", "Odpoveď"], { env: kEnv });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /Správa boris-adam-20261028-100000-1\.md nie je v \S+\/processed ani inbox, odpoveď s --k patrí len na prijatú správu\. Nič som neposlal\./);
  assert.equal(readdirSync(recvInbox).length, pred, "nič v inboxe adresáta");
  // Téma agentic_brain je mimo zoznamu odosielateľa (má len agenti_9e4abe) aj adresáta (len siet); prijatá správa ju nesie.
  writeFileSync(join(root, "boris", "topics.json"), JSON.stringify({ siet: { thread: "thr-r", at: "2026-10-28T00:00:00Z" } }, null, 1) + "\n");
  const prijata = (n, tema) => writeFileSync(join(box, "processed", n), `odpoveď: čakám\nid: ${n}\nod: boris\nkomu: adam\ntéma: ${tema}\nPokyn\n`);
  prijata("boris-adam-20261031-000000-1.md", "agentic_brain");
  r = await run("ask_agent.sh", ["--vedomie", "--k", "boris-adam-20261031-000000-1.md", "boris", "agentic_brain", "Odpoveď"], { env: kEnv });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readdirSync(recvInbox).length, pred + 1, "odpoveď na prijatú správu odišla");
  // Zadaná téma sa líši od témy prijatej správy: kód 1.
  r = await run("ask_agent.sh", ["--vedomie", "--k", "boris-adam-20261031-000000-1.md", "boris", "agenti_9e4abe", "Odpoveď"], { env: kEnv });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /Správa boris-adam-20261031-000000-1\.md má tému agentic_brain, zadaná téma agenti_9e4abe, odpoveď nesie tému pôvodnej správy\. Nič som neposlal\./);
  assert.equal(readdirSync(recvInbox).length, pred + 1);
  // Správa z --replies leží v processed ako <id>.HHMMSS.pid.reply, aj taká stačí.
  writeFileSync(join(box, "processed", "boris-adam-20261031-000001-2.md.000102.77.reply"), "odpoveď: na vedomie\nid: x\ntéma: agentic_brain\nOdpoveď\n");
  r = await run("ask_agent.sh", ["--vedomie", "--k", "boris-adam-20261031-000001-2.md", "boris", "agentic_brain", "Odpoveď na odpoveď"], { env: kEnv });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readdirSync(recvInbox).length, pred + 2);
  // Prijatá správa bez témy v hlavičke: zadaná téma platí a prejde kontrolou zoznamu ako nová správa.
  writeFileSync(join(box, "processed", "boris-adam-20261031-000002-3.md"), "odpoveď: čakám\nid: boris-adam-20261031-000002-3.md\nod: boris\nkomu: adam\ntéma: \nPokyn\n");
  r = await run("ask_agent.sh", ["--vedomie", "--k", "boris-adam-20261031-000002-3.md", "boris", "agentic_brain", "Odpoveď"], { env: kEnv });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /Téma 'agentic_brain' nie je v zozname tém odosielateľa/);
  assert.equal(readdirSync(recvInbox).length, pred + 2);
  // Správa --hlavne tému nemá.
  r = await run("ask_agent.sh", ["--hlavne", "--vedomie", "--dopad", "Mení sa X", "boris", "Do hlavného"], { env: { ...env, CLAUDE_CODE_SESSION_ID: "sid-A" } });
  assert.equal(r.status, 0, r.stderr);
});
