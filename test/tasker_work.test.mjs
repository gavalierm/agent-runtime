// tasker_work.mjs: ohlásenie práce pri "úloha N", ticho bez čísla, stop po
// poslednom sub-agentovi, nie po prvom z dvoch. Falošný príkaz zapisuje
// argumenty, HOME je v mkdtemp, živý Tasker sa nedotkne.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync as mkdtempRaw, writeFileSync, readFileSync, existsSync, mkdirSync, chmodSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { taskNumber, taskNumbers, sameSession, foreignHolder } from "../hooks/tasker_work.mjs";
import { recordChain } from "../lib/session_id.mjs";

// Dočasné priečinky testu sa na konci zmažú (úloha 701).
const tmpDirs = [];
const mkdtempSync = (prefix) => { const d = mkdtempRaw(prefix); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "../hooks/tasker_work.mjs");

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "tasker_work-"));
  const log = join(dir, "calls.log");
  const fake = join(dir, "fake-tasker.sh");
  writeFileSync(fake, `#!/bin/sh\necho "$TASKER_USER $*" >> "${log}"\n[ "$1 $2" = "task show" ] && [ -f "${dir}/task-$3.json" ] && { cat "${dir}/task-$3.json"; exit 0; }\n[ "$1 $2" = "task show" ] && echo "{\\"status\\":\\"$FAKE_STATUS\\",\\"assignee\\":\\"adam\\"}"\nexit 0\n`);
  chmodSync(fake, 0o755);
  const env = { PATH: process.env.PATH, HOME: dir, XDG_CACHE_HOME: join(dir, "cache"), AGENT_NAME: "adam", TASKER_WORK_CMD: fake };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter((l) => l && !l.includes(" task show ")) : []);
  return { dir, env, calls };
}

function run(sb, input, envOver = {}) {
  const r = spawnSync("node", [HOOK], { input: JSON.stringify(input), env: { ...sb.env, ...envOver }, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  return r;
}

const pre = (prompt, id, extra = {}) => ({
  hook_event_name: "PreToolUse", tool_name: "Agent", session_id: "S1", tool_use_id: id,
  tool_input: { description: "x", prompt, run_in_background: true }, ...extra,
});

// Sub-agent: záznam ako v Claude Code 2.1.309 (jsonl + meta.json vedľa).
function subagent(sb, id, toolUseId, prompt) {
  const t = join(sb.dir, "sub");
  mkdirSync(t, { recursive: true });
  const path = join(t, `agent-${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ type: "user", message: { role: "user", content: prompt } }) + "\n{}\n");
  writeFileSync(join(t, `agent-${id}.meta.json`), JSON.stringify({ toolUseId, description: "x" }));
  return { hook_event_name: "SubagentStop", session_id: "S1", agent_id: id, agent_transcript_path: path };
}

test("taskNumber: tvary zápisu a prvé číslo", () => {
  assert.equal(taskNumber("pracuj na úloha 414"), 414);
  assert.equal(taskNumber("Úloha 7 v Taskeri"), 7);
  assert.equal(taskNumber("k úlohy 12"), 12);
  assert.equal(taskNumber("v úlohe 99"), 99);
  assert.equal(taskNumber("https://x.ts.net:8801/tasks/380 hotovo"), 380);
  assert.equal(taskNumber("oprava #55"), 55);
  assert.equal(taskNumber("úloha 8 a úloha 9"), 8);
  assert.equal(taskNumber("bez čísla, rok 2026, port 8801"), null);
  assert.equal(taskNumber("&#39; a color #fff"), null);
  assert.equal(taskNumber(""), null);
});

test("PreToolUse: úloha 414 ohlási prácu s vláknom a menom agenta", () => {
  const sb = sandbox();
  run(sb, pre("Pracuj na úloha 414, časť 2", "tu1"));
  assert.deepEqual(sb.calls(), ["adam work 414 --thread S1"]);
});

test("PreToolUse: starý názov Task, číslo z popisu", () => {
  const sb = sandbox();
  run(sb, { ...pre("bez čísla", "tu1"), tool_name: "Task", tool_input: { description: "Úloha 5 oprava", prompt: "bez čísla" } });
  assert.deepEqual(sb.calls(), ["adam work 5 --thread S1"]);
});

test("bez čísla úlohy žiadne volanie, ani iný nástroj", () => {
  const sb = sandbox();
  run(sb, pre("urob niečo", "tu1"));
  run(sb, { ...pre("úloha 414", "tu2"), tool_name: "Bash" });
  assert.deepEqual(sb.calls(), []);
});

test("bez mena agenta hook nerobí nič, meno z PERSONA.md cwd", () => {
  const sb = sandbox();
  const env = { AGENT_NAME: "" };
  const proj = join(sb.dir, "proj");
  mkdirSync(proj);
  run(sb, pre("úloha 414", "tu1", { cwd: proj }), env);
  assert.deepEqual(sb.calls(), []);
  writeFileSync(join(proj, "PERSONA.md"), "# Boris\n\nRole: x\n");
  run(sb, pre("úloha 414", "tu2", { cwd: proj }), env);
  assert.deepEqual(sb.calls(), ["boris work 414 --thread S1"]);
});

test("taskNumbers: výčet a viac výskytov, bez opakovania", () => {
  assert.deepEqual(taskNumbers("úloha 485 a 486"), [485, 486]);
  assert.deepEqual(taskNumbers("úlohy 485, 486 a 487"), [485, 486, 487]);
  assert.deepEqual(taskNumbers("úloha 485 aj #486"), [485, 486]);
  assert.deepEqual(taskNumbers("úloha 8 a potom úloha 9, znova úloha 8 a /tasks/10"), [8, 9, 10]);
  assert.deepEqual(taskNumbers("úloha 7 a 2026 krokov"), [7, 2026]);
  assert.deepEqual(taskNumbers("bez čísla, rok 2026"), []);
});

test("viac rôznych čísel: ohlási každé, replay zadania \"úloha 485 a 486\" (úloha 492)", () => {
  const sb = sandbox();
  run(sb, pre("úloha 20 a potom úloha 21", "tu1"));
  assert.deepEqual(sb.calls(), ["adam work 20 --thread S1", "adam work 21 --thread S1"]);
  const sb2 = sandbox();
  run(sb2, pre("Oprav toto, úloha 485 a 486.", "tu2"));
  assert.deepEqual(sb2.calls(), ["adam work 485 --thread S1", "adam work 486 --thread S1"]);
  run(sb2, subagent(sb2, "a1", "tu2", "Oprav toto, úloha 485 a 486."));
  assert.deepEqual(sb2.calls().filter((c) => c.includes("--stop")), ["adam work 485 --stop", "adam work 486 --stop"]);
});

test("stop: číslo, ktoré drží iný sub-agent, sa neukončí", () => {
  const sb = sandbox();
  run(sb, pre("úloha 485 a 486", "tuA"));
  run(sb, pre("úloha 486", "tuB"));
  run(sb, subagent(sb, "a1", "tuA", "úloha 485 a 486"));
  assert.deepEqual(sb.calls().filter((c) => c.includes("--stop")), ["adam work 485 --stop"]);
  run(sb, subagent(sb, "b1", "tuB", "úloha 486"));
  assert.deepEqual(sb.calls().filter((c) => c.includes("--stop")), ["adam work 485 --stop", "adam work 486 --stop"]);
});

test("stop po poslednom sub-agentovi, nie po prvom z dvoch", () => {
  const sb = sandbox();
  run(sb, pre("úloha 414 A", "tuA"));
  run(sb, pre("úloha 414 B", "tuB"));
  run(sb, subagent(sb, "a1", "tuA", "úloha 414 A"));
  assert.deepEqual(sb.calls().filter((c) => c.includes("--stop")), []);
  run(sb, subagent(sb, "b1", "tuB", "úloha 414 B"));
  assert.deepEqual(sb.calls().filter((c) => c.includes("--stop")), ["adam work 414 --stop"]);
});

test("stop jediného sub-agenta, iná úloha nedrží prácu", () => {
  const sb = sandbox();
  run(sb, pre("úloha 414", "tuA"));
  run(sb, pre("úloha 415", "tuB"));
  run(sb, subagent(sb, "a1", "tuA", "úloha 414"));
  assert.deepEqual(sb.calls().filter((c) => c.includes("--stop")), ["adam work 414 --stop"]);
});

test("stop bez meta.json: číslo z prvej správy záznamu", () => {
  const sb = sandbox();
  run(sb, pre("úloha 414", "tuA"));
  const ev = subagent(sb, "a1", "iné", "úloha 414");
  run(sb, ev);
  assert.deepEqual(sb.calls().filter((c) => c.includes("--stop")), ["adam work 414 --stop"]);
});

test("stop sub-agenta bez ohlásenej práce nevolá nič, aj bez záznamu relácie", () => {
  const sb = sandbox();
  run(sb, subagent(sb, "a1", "tuX", "bez čísla"));
  run(sb, subagent(sb, "a2", "tuY", "úloha 414"));
  assert.deepEqual(sb.calls(), []);
});

test("bez príkazu a runuser (Mac): ticho, kód 0", () => {
  const sb = sandbox();
  const env = { TASKER_WORK_CMD: "", PATH: "/nonexistent" };
  const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(pre("úloha 414", "tu1")), env: { ...sb.env, ...env }, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout + r.stderr, "");
  const ev = subagent(sb, "a1", "tu1", "úloha 414");
  const r2 = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(ev), env: { ...sb.env, ...env }, encoding: "utf8" });
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout + r2.stderr, "");
  assert.deepEqual(sb.calls(), []);
});

// Obal `tk`: AGENT_TK, inak bin/tk v klone repa pravidiel (AGENT_WORKFLOW). Falošný
// obal zapíše meno agenta a argumenty, živý Tasker ani skutočný tk sa nevolá.
function fakeTk(path, log) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\necho "tk[$TASKER_USER] $*" >> "${log}"\n`);
  chmodSync(path, 0o755);
}

test("obal tk: cesta z AGENT_TK", () => {
  const sb = sandbox();
  const log = join(sb.dir, "tk.log");
  fakeTk(join(sb.dir, "obal", "tk"), log);
  run(sb, pre("úloha 414", "tu1"), { TASKER_WORK_CMD: "", AGENT_TK: join(sb.dir, "obal", "tk") });
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").filter((l) => !l.includes(" task show ")), ["tk[adam] work 414 --thread S1"]);
});

test("obal tk: bin/tk v klone repa pravidiel z AGENT_WORKFLOW, AGENT_TK z runtime.env", () => {
  const sb = sandbox();
  const log = join(sb.dir, "tk.log");
  fakeTk(join(sb.dir, "pravidla", "bin", "tk"), log);
  run(sb, pre("úloha 414", "tu1"), { TASKER_WORK_CMD: "", AGENT_WORKFLOW: join(sb.dir, "pravidla") });
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").filter((l) => !l.includes(" task show ")), ["tk[adam] work 414 --thread S1"]);
  fakeTk(join(sb.dir, "iny", "tk"), log);
  mkdirSync(join(sb.dir, ".config/adam"), { recursive: true });
  writeFileSync(join(sb.dir, ".config/adam/runtime.env"), `AGENT_TK=${join(sb.dir, "iny", "tk")}\n`);
  run(sb, pre("úloha 415", "tu2"), { TASKER_WORK_CMD: "", AGENT_WORKFLOW: join(sb.dir, "neexistuje") });
  assert.deepEqual(readFileSync(log, "utf8").trim().split("\n").filter((l) => !l.includes(" task show ")), ["tk[adam] work 414 --thread S1", "tk[adam] work 415 --thread S1"]);
});

test("nesprávny vstup: ticho, kód 0", () => {
  const sb = sandbox();
  const r = spawnSync("node", [HOOK], { input: "nie json", env: sb.env, encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});

const prompt = (text, extra = {}) => ({ hook_event_name: "UserPromptSubmit", session_id: "S2", prompt: text, ...extra });
const bash = (extra = {}) => ({ hook_event_name: "PreToolUse", tool_name: "Bash", session_id: "S2", tool_input: { command: "ls" }, ...extra });

test("výzva s číslom a prvý Bash: práve jedno work, druhý Bash nič", () => {
  const sb = sandbox();
  run(sb, prompt("Úloha 466 sa týka budenia"));
  assert.deepEqual(sb.calls(), []);
  run(sb, bash());
  assert.deepEqual(sb.calls(), ["adam work 466 --thread S2"]);
  run(sb, bash());
  run(sb, { ...bash(), tool_name: "Edit" });
  assert.deepEqual(sb.calls(), ["adam work 466 --thread S2"]);
});

test("výzva bez čísla nič, ani nástroj; nová výzva bez čísla číslo nemení", () => {
  const sb = sandbox();
  run(sb, prompt("urob niečo"));
  run(sb, bash());
  assert.deepEqual(sb.calls(), []);
  run(sb, prompt("Úloha 466"));
  run(sb, prompt("a ešte toto"));
  run(sb, bash());
  assert.deepEqual(sb.calls(), ["adam work 466 --thread S2"]);
});

test("ohlásenie staršie ako 60 minút sa zopakuje", () => {
  const sb = sandbox();
  run(sb, prompt("Úloha 466"));
  run(sb, bash());
  const f = join(sb.dir, "cache", "agentic-workflow", "tasker_work_current", "S2");
  writeFileSync(f, JSON.stringify({ n: 466, reportedAt: Date.now() - 61 * 60_000 }));
  run(sb, bash());
  assert.equal(sb.calls().length, 2);
});

test("needs_human s riešiteľom agentom: najprv komentár, potom work", () => {
  const sb = sandbox();
  run(sb, prompt("Úloha 466"));
  run(sb, bash(), { FAKE_STATUS: "needs_human" });
  const c = sb.calls();
  assert.equal(c.length, 2);
  assert.match(c[0], /^adam comment 466 --body /);
  assert.equal(c[1], "adam work 466 --thread S2");
});

const inboxMsg = (text) => `<schranka od="tasker" id="x1" odpoveď="nečakám">\nTasker: ${text}\n</schranka>`;

test("správa schránky s číslom a needs_human: ani komentár, ani work (chyba 24. 10. 2026, úloha 482)", () => {
  const sb = sandbox();
  run(sb, prompt(inboxMsg("úloha #482 pre teba, čaká na operátora")));
  run(sb, bash(), { FAKE_STATUS: "needs_human" });
  run(sb, bash(), { FAKE_STATUS: "needs_human" });
  assert.deepEqual(sb.calls(), []);
});

test("správa schránky: úloha handoff sa prevezme príkazom start, potom work", () => {
  const sb = sandbox();
  run(sb, prompt(inboxMsg("úloha #482 pre teba")));
  run(sb, bash(), { FAKE_STATUS: "handoff" });
  assert.deepEqual(sb.calls(), ["adam start 482", "adam work 482 --thread S2"]);
});

test("úloha v inom stave než v poradí sa neprevezme, work ako doteraz", () => {
  const sb = sandbox();
  run(sb, prompt(inboxMsg("úloha #482 pre teba")));
  run(sb, bash(), { FAKE_STATUS: "waiting" });
  assert.deepEqual(sb.calls(), ["adam work 482 --thread S2"]);
});

test("po správe schránky odpoveď operátora (s číslom aj bez) úlohu z needs_human vráti", () => {
  for (const reply of ["Úloha 482: schvaľujem", "schvaľujem"]) {
    const sb = sandbox();
    run(sb, prompt(inboxMsg("úloha #482 pre teba")));
    run(sb, prompt(reply));
    run(sb, bash(), { FAKE_STATUS: "needs_human" });
    const c = sb.calls();
    assert.equal(c.length, 2, reply);
    assert.match(c[0], /^adam comment 482 --body /);
    assert.equal(c[1], "adam work 482 --thread S2");
  }
});

test("Mac bez tk: výzva aj nástroj ticho, kód 0", () => {
  const sb = sandbox();
  const env = { TASKER_WORK_CMD: "", PATH: "/nonexistent" };
  for (const ev of [prompt("Úloha 466"), bash()]) {
    const r = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(ev), env: { ...sb.env, ...env }, encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, "");
  }
  assert.deepEqual(sb.calls(), []);
});

// Zámok úlohy (úloha 510): replay 24. 10. 2026, hlavné vlákno 77a21789 drží úlohu 503,
// vlákno témy de9b0663 ju zadá sub-agentovi.
const FAR = "2999-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";
const ev = (id, kind, detail, actor = "human:adam", to_status = null) => ({ id, kind, detail, actor, to_status });
function taskJson(sb, n, events) {
  writeFileSync(join(sb.dir, `task-${n}.json`), JSON.stringify({ id: n, status: "handoff", assignee: "adam", events }));
}
function runRaw(sb, input) {
  const r = spawnSync("node", [HOOK], { input: JSON.stringify(input), env: sb.env, encoding: "utf8" });
  assert.equal(r.status, 0);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
}
const HELD = [ev(1, "created", null), ev(2, "work", `start until ${FAR} thread 77a21789`)];

test("zámok: Agent z inej relácie na úlohe, ktorú drží iné vlákno, sa zamietne (replay úlohy 503)", () => {
  const sb = sandbox();
  taskJson(sb, 503, HELD);
  const out = runRaw(sb, { ...pre("Pracuj na úloha 503", "tu1"), session_id: "de9b0663" });
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /Úlohu 503 drží relácia 77a21789 do 2999-01-01T00:00:00\.000Z/);
  assert.match(out.permissionDecisionReason, /Správny postup:/);
  assert.deepEqual(sb.calls(), []);
});

test("zámok: Agent v relácii, ktorá úlohu drží, prejde a ohlási prácu", () => {
  const sb = sandbox();
  taskJson(sb, 503, HELD);
  assert.equal(runRaw(sb, { ...pre("úloha 503", "tu1"), session_id: "77a21789" }), null);
  assert.deepEqual(sb.calls(), ["adam work 503 --thread 77a21789"]);
});

test("zámok: úloha bez živej práce prejde (bez work, uplynulé until, work_stop, zmena stavu, extend bez threadu vlastnej)", () => {
  const cases = {
    bez: [ev(1, "created", null)],
    uplynule: [ev(2, "work", `start until ${PAST} thread 77a21789`)],
    stop: [...HELD, ev(3, "work_stop", null)],
    stav: [...HELD, ev(3, "status", "x", "human:adam", "needs_human")],
    bezThreadu: [ev(2, "work", `start until ${FAR}`)],
  };
  for (const [name, events] of Object.entries(cases)) {
    const sb = sandbox();
    taskJson(sb, 7, events);
    assert.equal(runRaw(sb, { ...pre("úloha 7", "tu1"), session_id: "B" }), null, name);
    assert.deepEqual(sb.calls(), ["adam work 7 --thread B"], name);
  }
});

test("zámok: stop iného aktéra prácu nekončí, extend zachová vlákno držiteľa", () => {
  const sb = sandbox();
  taskJson(sb, 7, [...HELD, ev(3, "work_stop", null, "human:boris"), ev(4, "work", `extend until ${FAR}`)]);
  assert.equal(runRaw(sb, { ...pre("úloha 7", "tu1"), session_id: "B" }).permissionDecision, "deny");
});

test("zámok: výčet úloh, zamietne ju jedna držaná, a Tasker bez odpovede hook nezablokuje (fail open)", () => {
  const sb = sandbox();
  taskJson(sb, 9, HELD);
  assert.equal(runRaw(sb, { ...pre("úloha 8 a 9", "tu1"), session_id: "B" }).permissionDecision, "deny");
  assert.deepEqual(sb.calls(), []);
  const sb2 = sandbox();
  writeFileSync(join(sb2.dir, "task-7.json"), "nie json");
  assert.equal(runRaw(sb2, { ...pre("úloha 7", "tu1"), session_id: "B" }), null);
  assert.deepEqual(sb2.calls(), ["adam work 7 --thread B"]);
  const sb3 = sandbox();
  assert.equal(runRaw({ ...sb3, env: { ...sb3.env, TASKER_WORK_CMD: "/nonexistent/tk" } }, { ...pre("úloha 7", "tu1"), session_id: "B" }), null);
});

test("zámok pri prevzatí: work relácie A živý, schránka s úlohou N v B, prvý zápis v B: ani start, ani work (replay úlohy 505)", () => {
  const sb = sandbox();
  writeFileSync(join(sb.dir, "task-505.json"), JSON.stringify({ id: 505, status: "handoff", assignee: "adam", events: [ev(1, "work", `start until ${FAR} thread de9b0663`)] }));
  const b = (x) => ({ ...x, session_id: "77a21789" });
  run(sb, b(prompt(inboxMsg("úloha #505 pre teba"))));
  const out = runRaw(sb, b(bash()));
  assert.match(out.additionalContext, /Úlohu 505 drží relácia de9b0663 do 2999-01-01T00:00:00\.000Z/);
  assert.deepEqual(sb.calls(), []);
  // Druhý zápis do hodiny hlásenie neopakuje.
  assert.equal(runRaw(sb, b(bash())), null);
  // Relácia, ktorá úlohu drží, ju prevezme.
  const sb2 = sandbox();
  writeFileSync(join(sb2.dir, "task-505.json"), JSON.stringify({ id: 505, status: "handoff", assignee: "adam", events: [ev(1, "work", `start until ${FAR} thread de9b0663`)] }));
  const a = (x) => ({ ...x, session_id: "de9b0663" });
  run(sb2, a(prompt(inboxMsg("úloha #505 pre teba"))));
  assert.equal(runRaw(sb2, a(bash())), null);
  assert.deepEqual(sb2.calls(), ["adam start 505", "adam work 505 --thread de9b0663"]);
});

// Replay úlohy 595 (25. 10. 2026): po /clear dostala relácia nové session_id a transcript
// jedného id je symlink na druhý. Relácia toho istého vlákna nie je cudzí držiteľ.
function symlinkTask595(sb, holder) {
  writeFileSync(join(sb.dir, "task-595.json"), JSON.stringify({ id: 595, status: "in_progress", assignee: "adam", events: [ev(1, "work", `start until ${FAR} thread ${holder}`, "adam")] }));
  const proj = join(sb.dir, "proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "c7ab4d1f.jsonl"), "");
  symlinkSync("c7ab4d1f.jsonl", join(proj, "d278bc54.jsonl"));
  return { ...pre("úloha 595", "tu1"), session_id: "c7ab4d1f", transcript_path: join(proj, "c7ab4d1f.jsonl") };
}

test("zámok: relácia toho istého vlákna po /clear (symlink transcriptu) úlohu neblokuje (replay úlohy 595)", () => {
  const sb = sandbox();
  const input = symlinkTask595(sb, "d278bc54");
  assert.equal(runRaw(sb, input), null);
  assert.deepEqual(sb.calls(), ["adam work 595 --thread c7ab4d1f"]);
});

test("zámok: držiteľ bez symlinku na transcript tejto relácie ostáva cudzí", () => {
  const sb = sandbox();
  const input = symlinkTask595(sb, "zzzz");
  assert.equal(runRaw(sb, input).permissionDecision, "deny");
  assert.deepEqual(sb.calls(), []);
});

test("zámok pri prevzatí: držiteľ s transcriptom prepojeným symlinkom nie je cudzí", () => {
  const sb = sandbox();
  const input = symlinkTask595(sb, "d278bc54");
  const b = (x) => ({ ...x, session_id: "c7ab4d1f", transcript_path: input.transcript_path });
  run(sb, b(prompt("úloha 595")));
  assert.equal(runRaw(sb, b(bash())), null);
  assert.deepEqual(sb.calls(), ["adam work 595 --thread c7ab4d1f"]);
});

test("sameSession: rovnaké id, symlink v oboch smeroch, chýbajúci súbor", () => {
  const dir = mkdtempSync(join(tmpdir(), "same-"));
  writeFileSync(join(dir, "c7ab4d1f.jsonl"), "");
  symlinkSync("c7ab4d1f.jsonl", join(dir, "d278bc54.jsonl"));
  writeFileSync(join(dir, "0241cda7.jsonl"), "");
  symlinkSync("0241cda7.jsonl", join(dir, "9d9daf59.jsonl"));
  assert.equal(sameSession("x", "x", dir), true);
  assert.equal(sameSession("d278bc54", "c7ab4d1f", dir), true);
  assert.equal(sameSession("c7ab4d1f", "d278bc54", dir), true);
  assert.equal(sameSession("9d9daf59", "0241cda7", dir), true);
  assert.equal(sameSession("0241cda7", "9d9daf59", dir), true);
  assert.equal(sameSession("c7ab4d1f", "0241cda7", dir), false);
  assert.equal(sameSession("c7ab4d1f", "zzzz", dir), false);
  assert.equal(sameSession("zzzz", "yyyy", dir), false);
});

// Replay úlohy 656 (28. 10. 2026): po druhom /clear sú prepisy 2c36d09d a 54f8935d obyčajné
// súbory, 3724bef6 je symlink na 54f8935d. Spája ich len `3724bef6.sessions`.
function chainDir() {
  const dir = mkdtempSync(join(tmpdir(), "chain-"));
  writeFileSync(join(dir, "2c36d09d.jsonl"), "");
  writeFileSync(join(dir, "54f8935d.jsonl"), "");
  symlinkSync("54f8935d.jsonl", join(dir, "3724bef6.jsonl"));
  return dir;
}
const ev656 = (holder) => [ev(1, "work", `start until ${FAR} thread ${holder}`, "adam")];

test("zámok: po druhom /clear bez .sessions drží úlohu cudzí (stav pred opravou 656)", () => {
  const dir = chainDir();
  assert.equal(sameSession("2c36d09d", "54f8935d", dir), false);
  assert.equal(sameSession("2c36d09d", "3724bef6", dir), false);
});

test("zámok: po druhom /clear s .sessions držiteľ nie je cudzí (replay úlohy 656)", () => {
  const dir = chainDir();
  recordChain(dir, "3724bef6", ["2c36d09d", "54f8935d"]);
  assert.equal(sameSession("2c36d09d", "54f8935d", dir), true);
  assert.equal(sameSession("54f8935d", "2c36d09d", dir), true);
  assert.equal(sameSession("2c36d09d", "3724bef6", dir), true);
  assert.equal(sameSession("2c36d09d", "cudzia", dir), false);
  const own = (t) => sameSession(t, "54f8935d", dir);
  assert.equal(foreignHolder(ev656("2c36d09d"), "54f8935d", Date.now(), own), null);
  assert.notEqual(foreignHolder(ev656("cudzia"), "54f8935d", Date.now(), own), null);
});

test("zámok: hook po druhom /clear nehlási vlastnú starú reláciu s .sessions, bez nich hlási", () => {
  for (const withChain of [true, false]) {
    const sb = sandbox();
    writeFileSync(join(sb.dir, "task-656.json"), JSON.stringify({ id: 656, status: "in_progress", assignee: "adam", events: [ev(1, "work", `start until ${FAR} thread 2c36d09d`, "adam")] }));
    const proj = chainDir();
    if (withChain) recordChain(proj, "3724bef6", ["2c36d09d", "54f8935d"]);
    const input = { ...pre("úloha 656", "tu1"), session_id: "54f8935d", transcript_path: join(proj, "54f8935d.jsonl") };
    if (withChain) {
      assert.equal(runRaw(sb, input), null);
      assert.deepEqual(sb.calls(), ["adam work 656 --thread 54f8935d"]);
    } else {
      assert.equal(runRaw(sb, input).permissionDecision, "deny");
      assert.deepEqual(sb.calls(), []);
    }
  }
});

test("výzva s novým číslom úlohy zapíše čas `at`, rovnaké číslo ho ponechá (úloha 690)", () => {
  const sb = sandbox();
  const file = join(sb.dir, "cache", "agentic-workflow", "tasker_work_current", "S2");
  const before = Date.now();
  run(sb, prompt("Úloha 689"));
  const first = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(first.n, 689);
  assert.ok(first.at >= before && first.at <= Date.now());
  // Rovnaké číslo vo výzve zo schránky ponechá `at`, výzva bez čísla zruší príznak a `at` zachová.
  writeFileSync(file, JSON.stringify({ ...first, at: 1000 }));
  run(sb, prompt(inboxMsg("Úloha 689 má komentár")));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).at, 1000);
  run(sb, prompt("a ešte toto"));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).at, 1000);
  // Iné číslo má nový čas.
  run(sb, prompt("Úloha 690"));
  assert.ok(JSON.parse(readFileSync(file, "utf8")).at >= before);
  // Zapisujúci nástroj `at` zachová.
  const at = JSON.parse(readFileSync(file, "utf8")).at;
  run(sb, bash());
  assert.equal(JSON.parse(readFileSync(file, "utf8")).at, at);
});
