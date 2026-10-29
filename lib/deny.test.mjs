// Test D0141 (úloha 424): zamietnutie hooku nesie "Správny postup:". Helper
// lib/deny.mjs, shellový lib/deny.sh, strážca lib/deny_check.mjs a hooky s testami
// žijú v repe agentic-workflow (úlohy 528 a 529), tu sú obaly a hooky, ktoré ostali.
// Nevolá živý Tasker, schránky ani T3.
// Spustenie: node --test lib/deny.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { denyTool } from "./deny.mjs";
import { denyProblems } from "./deny_check.mjs";
import { verdict as topicVerdict } from "../hooks/topic.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const hook = (name, input, env = {}) =>
  spawnSync("node", [join(REPO, "hooks", name)], { input: JSON.stringify(input), encoding: "utf8", env: { ...process.env, REPLY_GUARD_NO_NET: "1", AR_ROZHODNUTIA: "", ...env } });
const postupOf = (text) => (text.match(/Správny postup: (.+)/) || [])[1] || "";
const denyReason = (r) => JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason;

test("re-export helpera zamietne s postupom a bez postupu hodí chybu", () => {
  let out = "";
  denyTool("d", "p", { write: (s) => (out += s) });
  assert.match(JSON.parse(out).hookSpecificOutput.permissionDecisionReason, /\nSprávny postup: p$/);
  assert.throws(() => denyTool("d", "", { write() {} }));
});

test("každý PreToolUse hook zamietne s postupom", () => {
  const bash = (command) => ({ tool_name: "Bash", tool_input: { command }, cwd: "/tmp" });
  const cases = [
    ["no_model_wait.mjs", bash("sleep 60"), /tasker wait/],
    ["foreign_git.mjs", bash("git stash"), /git commit/],
    ["foreign_git.mjs", bash("git -c safe.directory=* status"), /runuser -u/],
    ["git_pull.mjs", bash("git pull --rebase=false"), /git fetch origin && git rebase origin\/main/],
    ["rozhodnutia_guard.mjs", { tool_name: "Write", tool_input: { file_path: join(REPO, "rozhodnutia", "D0001.md") }, cwd: REPO }, /rozhodni\.sh/],
    ["web_review.mjs", bash("tasker task add --title x --assign webclient-web --project p"), /uloha-webu\.sh/],
    ["own_mechanism.mjs", bash("tasker task add --project p --body 'spusti systemd-run'"), /Nástroj overený:/],
    ["task_title.mjs", bash("tasker task add --project p --title 'Nasadiť Tasker 276db3a'"), /beží bez 276db3a/],
  ];
  if (process.getuid() === 0) cases.push(["tasker_root.mjs", bash("tasker task list"), /bin\/tk/]);
  for (const [h, input, want] of cases) {
    const r = hook(h, input);
    assert.equal(r.status, 0, `${h}: ${r.stderr}`);
    assert.ok(r.stdout, `${h}: bez zamietnutia`);
    const p = postupOf(denyReason(r));
    assert.match(p, want, `${h}: postup`);
  }
});

test("hooky s exit 2 nesú postup", () => {
  const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });
  for (const [h, input, want] of [
    ["project_data.mjs", bash("git clone https://x/y.git .scratch/y"), /ask_agent\.sh/],
    ["server_work.mjs", bash("ssh srv systemctl restart nginx"), /ask_agent\.sh adam/],
    ["compact_block.mjs", { hook_event_name: "PreCompact", trigger: "auto" }, /kontext\.sh spanok/],
  ]) {
    const r = hook(h, input);
    assert.equal(r.status, 2, h);
    assert.match(postupOf(r.stderr), want, h);
  }
});

test("topic: každý dôvod má postup", () => {
  const v = topicVerdict({ session_id: "../zle", tool_name: "Write", tool_input: {} });
  assert.ok(v && v[1].length > 10);
});

test("shell: deny_postup s prázdnym postupom vráti 2, s postupom vypíše riadok", () => {
  const run = (call) => spawnSync("bash", ["-c", `source ${join(REPO, "lib", "deny.sh")}; ${call}`], { encoding: "utf8" });
  const bad = run('deny_postup "dôvod" ""');
  assert.equal(bad.status, 2);
  const good = run('deny_postup "dôvod" "git rebase origin/main"');
  assert.equal(good.status, 0);
  assert.match(good.stderr, /^dôvod\nSprávny postup: git rebase origin\/main\n$/);
});

test("strážca: repo je čisté", () => {
  assert.deepEqual(denyProblems(REPO), []);
});
