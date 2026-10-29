// no_retest.mjs: testy po sub-agentovi hlavné vlákno neopakuje.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TEST_CMD } from "./no_retest.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "no_retest.mjs");
const dir = mkdtempSync(join(tmpdir(), "no_retest-"));
let n = 0;

const asst = (content) => ({ type: "assistant", isSidechain: false, message: { role: "assistant", content } });
const user = (content) => ({ type: "user", isSidechain: false, message: { role: "user", content } });
const agentCall = asst([{ type: "tool_use", id: "tu_A", name: "Agent", input: { model: "sonnet", prompt: "x" } }]);
const agentResult = (text) => user([{ type: "tool_result", tool_use_id: "tu_A", content: [{ type: "text", text }] }]);

function run(entries, input) {
  const p = join(dir, `t${n++}.jsonl`);
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const out = execFileSync("node", [HOOK], { input: JSON.stringify({ transcript_path: p, ...input }) }).toString();
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : "";
}
const bash = (command) => ({ tool_name: "Bash", tool_input: { command } });

test("zamietne po výsledku Agent s výstupom testov", () => {
  const e = [user("urob"), agentCall, agentResult("hotovo\nnpm test: # pass 7\n# fail 0")];
  assert.equal(run(e, bash("cd /root/tasker; timeout 300 npm test 2>&1 | grep pass")), "deny");
});

test("pustí, keď správa sub-agenta výstup testov nemá", () => {
  const e = [user("urob"), agentCall, agentResult("hotovo, zmenené súbory a.mjs")];
  assert.equal(run(e, bash("npm test")), "");
});

test("pustí po Edit za správou sub-agenta", () => {
  const e = [user("urob"), agentCall, agentResult("# pass 7"),
    asst([{ type: "tool_use", id: "tu_E", name: "Edit", input: { file_path: "/x", old_string: "a", new_string: "b" } }]),
    user([{ type: "tool_result", tool_use_id: "tu_E", content: "ok" }])];
  assert.equal(run(e, bash("npm test")), "");
});

test("pustí sub-agenta", () => {
  const e = [user("urob"), agentCall, agentResult("# pass 7")];
  assert.equal(run(e, { agent_id: "a1", ...bash("npm test") }), "");
});

test("pustí príkaz, ktorý nie je testovací", () => {
  const e = [user("urob"), agentCall, agentResult("# pass 7")];
  assert.equal(run(e, bash("ls")), "");
});

test("zamietne po task-notification s výstupom testov", () => {
  const e = [user("urob"),
    user("<task-notification>\n<status>completed</status>\n<result>npm test: # pass 369, # fail 0</result>\n</task-notification>")];
  assert.equal(run(e, bash("node --test hooks/x.test.mjs")), "deny");
});

test("pustí po skutočnom vstupe používateľa za správou", () => {
  const e = [agentCall, agentResult("# pass 7"), user("spusti testy")];
  assert.equal(run(e, bash("npm test")), "");
});

test("chyba čítania transkriptu pustí", () => {
  const out = execFileSync("node", [HOOK], { input: JSON.stringify({ transcript_path: "/nie/je", ...bash("npm test") }) }).toString();
  assert.equal(out, "");
});

test("regex testovacích príkazov", () => {
  for (const c of ["npm test", "npm run test", "node --test hooks/a.mjs", "node check.mjs", "pytest -q", "go test ./...", "cargo test"])
    assert.ok(TEST_CMD.test(c), c);
  for (const c of ["ls", "git status", "npm install", "node hook.mjs"]) assert.ok(!TEST_CMD.test(c), c);
});

// Úloha 601: príkaz testu sa hľadá v pozícii príkazu, text v úvodzovkách a heredoc sú dáta.
const afterAgent = [user("urob"), agentCall, agentResult("hotovo\n# pass 369\n# fail 0")];

test("pustí príkaz, ktorý test len spomína (úvodzovky, grep, heredoc)", () => {
  for (const c of [
    'tk done 600 --summary "... sada beží cez node --test test/*.test.mjs ..."',
    "tk done 600 --summary 'sada beží cez npm test a node check.mjs'",
    'grep -n "node --test" README.md',
    "grep -rn 'npm test' hooks",
    'tk task add --project agenti --body "... kontrola node check.mjs ..."',
    "cat <<'EOF' > x.md\nspusti npm test\nnode --test test/\nEOF",
    "tk comment 5 --body \"$(cat <<'EOF'\nnpm test prešiel, node check.mjs tiež\nEOF\n)\"",
    'echo "pytest -q" && ls',
    "git commit -m 'oprava: node --test a npm test' -- a.mjs",
  ]) assert.equal(run(afterAgent, bash(c)), "", c);
});

test("zamietne skutočné spustenie testu", () => {
  for (const c of [
    "node --test test/",
    "cd /opt/agentic-workflow && node --test test/*.test.mjs",
    "npm test",
    "node check.mjs",
    "FOO=1 CI=true npm test",
    "cd /root/x; timeout 300 npm test 2>&1 | grep pass",
    "git status && (cd tasker && pytest -q)",
    "echo hotovo ; node --test hooks/a.test.mjs | tail -5",
    "ls || npm run test",
    'bash -c "npm test"',
    "sh -c 'cd /root/x && node --test test/'",
    "x=$(npm test)",
    "time sudo -u tasker-svc go test ./...",
  ]) assert.equal(run(afterAgent, bash(c)), "deny", c);
});
