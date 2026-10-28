// Test lib/agent_env.mjs a hodnôt z prostredia v hookoch: runtime.env agenta,
// meno operátora, adresa webu Taskera, DB Taskera. HOME v tmp, bez živého
// Taskera a bez súborov skutočných agentov.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hookEnv, operatorForms, parseEnvFile, rulesRepo, zapnute } from "../lib/agent_env.mjs";
import { defaultDb, fetchTasks } from "../lib/tasker_read.mjs";
import { decisionProblem } from "../hooks/reply_guard.mjs";

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), "../hooks");
const HOME = mkdtempSync(join(tmpdir(), "agent-env-"));
test.after(() => rmSync(HOME, { recursive: true, force: true }));
mkdirSync(join(HOME, ".config/adam"), { recursive: true });
writeFileSync(join(HOME, ".config/adam/runtime.env"), [
  "# komentár",
  "AGENT_OPERATOR_NAME=Oskar",
  "TASKER_WEB_URL=https://host.example.ts.net:8801",
  "AGENT_TASKER_USER='tasker-svc'",
  'AGENT_MODEL="model x"',
  "export AGENT_HOST=server # za riadkom",
  "zle riadky",
].join("\n"));

test("parseEnvFile: komentáre, úvodzovky, export, zlé riadky", () => {
  assert.deepEqual(parseEnvFile(`# a\nA=1\nB='x y'\nC="z"\nexport D=4 # c\nzle\n=5\n`), { A: "1", B: "x y", C: "z", D: "4" });
});

test("hookEnv: runtime.env agenta z AGENT_NAME, premenná procesu vyhrá, prázdna nie", () => {
  const e = hookEnv({}, { HOME, AGENT_NAME: "adam", TASKER_WEB_URL: "https://iny.example:1", AGENT_OPERATOR_NAME: "" });
  assert.equal(e.AGENT_OPERATOR_NAME, "Oskar");
  assert.equal(e.TASKER_WEB_URL, "https://iny.example:1");
  assert.equal(e.AGENT_TASKER_USER, "tasker-svc");
  assert.equal(e.AGENT_MODEL, "model x");
  assert.equal(e.AGENT_HOST, "server");
});

test("hookEnv: meno agenta z PERSONA.md projektu, AGENT_RUNTIME_ENV, chýbajúci súbor", () => {
  const proj = join(HOME, "adam-proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "PERSONA.md"), "# Adam\n");
  assert.equal(hookEnv({ cwd: proj }, { HOME }).AGENT_OPERATOR_NAME, "Oskar");
  assert.equal(hookEnv({}, { HOME, AGENT_RUNTIME_ENV: join(HOME, ".config/adam/runtime.env") }).AGENT_OPERATOR_NAME, "Oskar");
  assert.equal(hookEnv({}, { HOME, AGENT_NAME: "nikto" }).AGENT_OPERATOR_NAME, undefined);
  assert.equal(hookEnv({}, { HOME, AGENT_NAME: "../adam" }).AGENT_OPERATOR_NAME, undefined);
  assert.equal(hookEnv({ cwd: HOME }, { HOME, CLAUDE_PROJECT_DIR: HOME }).AGENT_OPERATOR_NAME, undefined);
});

test("operatorForms: meno z AGENT_OPERATOR_NAME, inak slovo operátor", () => {
  const o = operatorForms({ AGENT_OPERATOR_NAME: "Oskar" });
  assert.deepEqual([o.nom, o.dat, o.gen], ["Oskar", "Oskarovi", "Oskara"]);
  const d = operatorForms({});
  assert.deepEqual([d.nom, d.dat, d.gen, d.cap(d.dat)], ["operátor", "operátorovi", "operátora", "Operátorovi"]);
});

test("rulesRepo a zapnute", () => {
  assert.equal(rulesRepo({ AR_CLONE: "/a", AGENT_RULES_REPO: "/b" }, "linux"), "/a");
  assert.equal(rulesRepo({ AGENT_RULES_REPO: "/b" }, "linux"), "/b");
  assert.equal(rulesRepo({}, "linux"), "/opt/agent-rules");
  assert.equal(rulesRepo({ HOME: "/Users/m" }, "darwin"), "/Users/m/Work/agent-rules");
  assert.equal(zapnute({ AR_ROZHODNUTIA: "1" }), true);
  assert.equal(zapnute({ AR_ROZHODNUTIA: "0" }), false);
  assert.equal(zapnute({}), false);
});

test("defaultDb: TASKER_DB, TASKER_HOME, používateľ behov, domovský priečinok", () => {
  assert.equal(defaultDb({ TASKER_DB: "/x/t.db", TASKER_HOME: "/y" }), "/x/t.db");
  assert.equal(defaultDb({ TASKER_HOME: "/y/.tasker" }), "/y/.tasker/tasker.db");
  assert.equal(defaultDb({ AGENT_TASKER_USER: "tasker-svc" }), "/home/tasker-svc/.tasker/tasker.db");
  assert.equal(defaultDb({ HOME: "/h" }), "/h/.tasker/tasker.db");
});

test("fetchTasks: bez DB ide cez web z TASKER_WEB_URL, výslovná DB bez súboru je chyba", async () => {
  let asked = null;
  const fetchImpl = async (url) => { asked = url; return { ok: true, json: async () => [{ id: 7, title: "x", status: "needs_human" }] }; };
  const env = { HOME, TASKER_WEB_URL: "https://host.example.ts.net:8801/" };
  assert.deepEqual(await fetchTasks({ ids: [7], env, fetchImpl }), [{ id: 7, title: "x", status: "needs_human", assignee: null, project: null }]);
  assert.equal(asked, "https://host.example.ts.net:8801/api/tasks");
  await fetchTasks({ env: { HOME }, fetchImpl });
  assert.equal(asked, "http://127.0.0.1:8801/api/tasks");
  await assert.rejects(fetchTasks({ env: { HOME, TASKER_DB: join(HOME, "nie.db") }, fetchImpl }), /neexistuje/);
});

test("decisionProblem: meno operátora z prostredia", () => {
  const text = "Oskar rozhodol, že ideme.";
  assert.match(decisionProblem(text, [], { AGENT_OPERATOR_NAME: "Oskar" }), /hlási nové rozhodnutie/);
  assert.equal(decisionProblem(text, [], {}), null);
  assert.match(decisionProblem("Operátor schválil plán.", [], {}), /hlási nové rozhodnutie/);
  assert.equal(decisionProblem(text, ["bin/rozhodni.sh --nazov x"], { AGENT_OPERATOR_NAME: "Oskar" }), null);
  assert.match(decisionProblem("Os.kar rozhodol.", [], { AGENT_OPERATOR_NAME: "Os.kar" }), /hlási/);
  assert.equal(decisionProblem("Osxkar rozhodol.", [], { AGENT_OPERATOR_NAME: "Os.kar" }), null);
});

const hook = (name, input, env = {}) =>
  spawnSync("node", [join(HOOKS, name)], { input: JSON.stringify(input), encoding: "utf8", env: { PATH: process.env.PATH, HOME, AGENT_NAME: "adam", REPLY_GUARD_NO_NET: "1", AGENT_THREADS: "", ...env } });

test("no_operator_commands: tvary mena operátora z runtime.env, bez mena slovo operátor", () => {
  const cmd = { last_assistant_message: "Spusti:\n```sh\nnpm test\n```" };
  const withName = JSON.parse(hook("no_operator_commands.mjs", cmd).stdout).reason;
  assert.match(withName, /Odpoveď dáva Oskarovi príkaz na spustenie: "npm test"\. Krok pre Oskara je klik/);
  assert.match(withName, /oň Oskar požiadal/);
  const none = JSON.parse(hook("no_operator_commands.mjs", cmd, { AGENT_NAME: "nikto" }).stdout).reason;
  assert.match(none, /Odpoveď dáva operátorovi príkaz na spustenie: "npm test"\. Krok pre operátora je klik/);
  const waiting = JSON.parse(hook("no_operator_commands.mjs", { last_assistant_message: "Čaká na teba:\n- niečo" }).stdout).reason;
  assert.match(waiting, /\. Oskarovi patrí len rozhodnutie/);
  assert.match(JSON.parse(hook("no_operator_commands.mjs", { last_assistant_message: "Čaká na teba:\n- niečo" }, { AGENT_NAME: "nikto" }).stdout).reason, /\. Operátorovi patrí len rozhodnutie/);
});

test("reply_guard: adresa webu Taskera a rozhodnutie operátora z runtime.env", () => {
  const link = JSON.parse(hook("reply_guard.mjs", { last_assistant_message: "Hotová je úloha 380." }).stdout);
  assert.match(link.reason, /\[úloha 380\]\(https:\/\/host\.example\.ts\.net:8801\/tasks\/380\)/);
  assert.match(link.reason, /\(tvar `\[úloha N\]\(https:\/\/host\.example\.ts\.net:8801\/tasks\/N\)`\)/);
  const local = JSON.parse(hook("reply_guard.mjs", { last_assistant_message: "Pozri http://127.0.0.1:8801/x." }).stdout);
  assert.match(local.reason, /napríklad https:\/\/host\.example\.ts\.net:8801\./);
  assert.match(local.reason, /: https:\/\/host\.example\.ts\.net:<port>$/);
  const tr = join(HOME, "t.jsonl");
  const ev = (type, content) => JSON.stringify({ type, message: { content } });
  writeFileSync(tr, [ev("user", "ahoj"), ev("assistant", [{ type: "text", text: "Oskar schválil plán." }])].join("\n"));
  const dec = hook("reply_guard.mjs", { transcript_path: tr }, { AR_ROZHODNUTIA: "1" });
  assert.match(JSON.parse(dec.stdout).reason, /hlási nové rozhodnutie/);
  assert.equal(hook("reply_guard.mjs", { transcript_path: tr }, { AR_ROZHODNUTIA: "1", AGENT_NAME: "nikto" }).stdout, "");
});
