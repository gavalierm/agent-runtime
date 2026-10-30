// task_concurrency.mjs: zamietne `task add --assign X` bez --blocked-by, keď X v projekte
// už beží (úloha 594). Živý Tasker sa nevolá: `run list` podstrčí falošný príkaz.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync as mkdtempRaw, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { concurrencyReason } from "./task_concurrency.mjs";

// Dočasné priečinky testu sa na konci zmažú (úloha 701).
const tmpDirs = [];
const mkdtempSync = (prefix) => { const d = mkdtempRaw(prefix); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "task_concurrency.mjs");
const dir = mkdtempSync(join(tmpdir(), "tc-"));
// Falošné `tasker run list`: behy 113 a 114 dan/tasker bežia, 90 skončil, 120 beží u eva/web.
const RUNS = [
  { id: 113, task_id: 580, project: "tasker", agent: "dan", status: "running" },
  { id: 114, task_id: 581, project: "tasker", agent: "dan", status: "running" },
  { id: 90, task_id: 500, project: "tasker", agent: "dan", status: "finished" },
  { id: 120, task_id: 590, project: "web", agent: "eva", status: "running" },
];
const FAKE = join(dir, "fake-run-list");
writeFileSync(FAKE, `#!/bin/bash\ncat <<'EOF2'\n${JSON.stringify(RUNS)}\nEOF2\n`);
chmodSync(FAKE, 0o755);
const BROKEN = join(dir, "broken");
writeFileSync(BROKEN, "#!/bin/bash\nexit 3\n");
chmodSync(BROKEN, 0o755);

const ENV = { ...process.env, TASK_CONCURRENCY_RUN_LIST: FAKE };
delete ENV.TK_PARALLEL;
const TK = "AGENT_NAME=adam /opt/agentic-workflow/bin/tk";
const cmd = (extra = "", project = "tasker", agent = "dan") =>
  `${TK} task add --project ${project} --assign ${agent} --title "Beží bez X" --body "x" ${extra}`;
const run = (command, env = ENV) => {
  const out = execFileSync("node", [HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }), env }).toString();
  return out ? JSON.parse(out).hookSpecificOutput : null;
};

test("replay 25. 10.: task add --project tasker --assign dan bez --blocked-by pri behoch 113 a 114 sa zamietne", () => {
  const out = run(cmd());
  assert.equal(out.permissionDecision, "deny");
  const r = out.permissionDecisionReason;
  assert.match(r, /úloha 580 \(beh 113\)/);
  assert.match(r, /úloha 581 \(beh 114\)/);
  assert.doesNotMatch(r, /beh 90/);
  assert.match(r, /--blocked-by 580 --reason/);
  assert.match(r, /úloha 594/);
  assert.ok(r.includes("Správny postup:"));
});

test("--blocked-by prejde (aj --blocked-by=)", () => {
  assert.equal(run(cmd("--blocked-by 580 --reason x")), null);
  assert.equal(run(cmd("--blocked-by=580 --reason x")), null);
});

test("TK_PARALLEL=1 prejde, príkazom aj prostredím", () => {
  assert.equal(run(`TK_PARALLEL=1 ${cmd()}`), null);
  assert.equal(run(cmd(), { ...ENV, TK_PARALLEL: "1" }), null);
});

test("iný projekt, iný agent, beh nie je running prejdú", () => {
  assert.equal(run(cmd("", "agenti")), null);
  assert.equal(run(cmd("", "tasker", "boris")), null);
  assert.equal(run(cmd("", "web", "dan")), null);
});

test("bez --assign alebo --project, iné príkazy a zlyhaný run list prejdú", () => {
  assert.equal(run(`${TK} task add --project tasker --title "x"`), null);
  assert.equal(run(`${TK} task add --assign dan --title "x"`), null);
  assert.equal(run(`${TK} task show 5`), null);
  assert.equal(run(`${TK} comment 5 --body "task add --project tasker --assign dan"`), null);
  assert.equal(run(cmd(), { ...ENV, TASK_CONCURRENCY_RUN_LIST: BROKEN }), null);
});

test("concurrencyReason: tvary príkazu (tasker, sh -c) a podstrčená funkcia", () => {
  const runs = (a, p) => (a === "dan" && p === "tasker" ? [{ id: 1, task_id: 7 }] : []);
  assert.ok(concurrencyReason(`tasker task add --project tasker --assign dan --title x`, undefined, {}, runs));
  assert.ok(concurrencyReason(`sh -c 'tk task add --project=tasker --assign=dan --title x'`, undefined, {}, runs));
  assert.equal(concurrencyReason(`tk task add --project tasker --assign "$A" --title x`, undefined, {}, runs), null);
});
