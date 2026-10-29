import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { startFakeT3 } from "./fake_t3.mjs";
import { T3Client } from "../lib.mjs";
import { routeKey, rememberRoute, routeFor, threadForSession, sessionIds, waitingFor, setTopic, removeTopic, readTopics, topicsPath, messageTopic } from "../route.mjs";
import { tick, classify, renderMessage } from "../driver.mjs";

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
    T3_URL: t3.url, T3_TOKEN_FILE: tokenFile, AGENT_SEND_boris: borisInbox, CLAUDE_PID: "",
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
  // Odpoveď Borisovi z hlavného vlákna: trasu zruší.
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
  r = await run("ask_agent.sh", ["--vedomie", "--k", "boris-odpoved-20261019-100000-1.md", "boris", "pravidla", "Odpoveď bez dopadu"], { env: { ...env, CLAUDE_CODE_SESSION_ID: "" } });
  assert.equal(r.status, 0, r.stderr);
  const rf = readdirSync(borisInbox).find((x) => readFileSync(join(borisInbox, x), "utf8").includes("Odpoveď bez dopadu"));
  assert.ok(!/dopad:/.test(readFileSync(join(borisInbox, rf), "utf8")), "odpoveď s --k dopad nenesie");
  assert.equal(waitingFor(cfg, `boris-${f}`, Date.now(), f), false, "sent sa zapíše aj bez relácie");
  // Odpoveď Cyrilovi z vlákna témy: ďalšia správa Cyrila s tou témou ide do témy.
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

test("zoznam tém: zápis, onlyIfAbsent, mazanie, práva 640, téma novej správy", () => {
  const { cfg, box } = setup();
  assert.equal(topicsPath(cfg), join(box, "topics.json"), "zoznam leží v schránke, nie v stave");
  assert.equal(setTopic(cfg, "pravidla", "thr-a"), true);
  assert.equal(setTopic(cfg, "pravidla", "thr-b", { onlyIfAbsent: true }), false, "tému vedie iné vlákno");
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
  // remember z vlákna témy zapíše tému, z hlavného nie, cudziu tému neprepíše.
  rememberRoute(cfg, { name: "adam-kanon-20261019-100000-1.md", thread: "thr-adam", peer: "boris" });
  assert.equal(readTopics(topicsPath(cfg)).kanon, undefined);
  const r = rememberRoute(cfg, { name: "adam-kanon-20261019-100000-2.md", thread: "thr-tema", peer: "boris" });
  assert.equal(r.topic, "kanon");
  rememberRoute(cfg, { name: "cyril-kanon-20261019-100000-3.md", thread: "thr-ina" });
  assert.equal(readTopics(topicsPath(cfg)).kanon.thread, "thr-tema");
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
    T3_URL: t3.url, T3_TOKEN_FILE: tokenFile, CLAUDE_PID: "" };
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
