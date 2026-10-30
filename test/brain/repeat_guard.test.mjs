// Test of the hook bin/repeat_guard.mjs: replays inputs and checks the exit code and stderr.
// The hook state goes to a temporary folder (TMPDIR), not to the real one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GUARD = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "brain", "bin", "repeat_guard.mjs");
const SANDBOX = mkdtempSync(join(tmpdir(), "repeat-guard-test-"));
let counter = 0;

function newSession() {
  return `test-${process.pid}-${++counter}`;
}

function run(session, command, args = []) {
  const input = JSON.stringify({ session_id: session, tool_input: { command } });
  return runRaw(input, args);
}

function runRaw(input, args = []) {
  const r = spawnSync("node", [GUARD, ...args], { input, encoding: "utf8", env: { ...process.env, TMPDIR: SANDBOX } });
  return { code: r.status, stderr: r.stderr };
}

test.after(() => rmSync(SANDBOX, { recursive: true, force: true }));

test("two curl runs with different arguments pass, the third exits with 2", () => {
  const s = newSession();
  assert.equal(run(s, "curl -s https://example.org/a").code, 0);
  assert.equal(run(s, "curl -s https://example.org/b").code, 0);
  const third = run(s, "curl -s https://example.org/c");
  assert.equal(third.code, 2);
  assert.match(third.stderr, /The third manual run of `curl` in this session is a mechanical step/);
  assert.match(third.stderr, /agentic-brain\/skills\/<name>\/scripts\//);
});

test("a rejected command that is repeated is rejected again", () => {
  const s = newSession();
  run(s, "curl a");
  run(s, "curl b");
  assert.equal(run(s, "curl c").code, 2);
  assert.equal(run(s, "curl c").code, 2);
});

test("the same command repeated does not count as new", () => {
  const s = newSession();
  for (let i = 0; i < 5; i++) assert.equal(run(s, "curl -s https://example.org/a").code, 0);
});

test("a program from the allow list passes a third time too", () => {
  const s = newSession();
  for (const a of ["status", "log", "diff", "branch", "fetch"]) assert.equal(run(s, `git ${a}`).code, 0);
});

test("a command from skills/*/scripts/ and from agentic-brain/bin/ does not count", () => {
  const s = newSession();
  for (const a of ["1", "2", "3", "4"]) {
    assert.equal(run(s, `./agentic-brain/skills/web/scripts/download.sh ${a}`).code, 0);
    assert.equal(run(s, `"$CLAUDE_PROJECT_DIR/agentic-brain/bin/search" ${a}`).code, 0);
  }
  assert.equal(run(s, "curl a").code, 0);
  assert.equal(run(s, "curl b").code, 0);
});

test("a pipe and && split a command into segments, each program counts", () => {
  const s = newSession();
  assert.equal(run(s, "cd x && curl -s a | head -n 1").code, 0);
  assert.equal(run(s, "curl -s b | grep x").code, 0);
  assert.equal(run(s, "cd y && curl -s c").code, 2);
});

test("variables and sudo before a program are stripped", () => {
  const s = newSession();
  assert.equal(run(s, "A=1 curl a").code, 0);
  assert.equal(run(s, "sudo curl b").code, 0);
  assert.equal(run(s, "A=2 sudo -u nobody curl c").code, 2);
});

test("a pipe inside quotes does not split the command", () => {
  const s = newSession();
  assert.equal(run(s, 'curl "a|b"').code, 0);
  assert.equal(run(s, 'curl "c && d"').code, 0);
  assert.equal(run(s, "curl 'e;f'").code, 2);
});

test("the redirect 2>&1 does not create a phantom program", () => {
  const s = newSession();
  for (let i = 0; i < 4; i++) assert.equal(run(s, `echo ${i} 2>&1`).code, 0);
});

test("sessions are separate", () => {
  const a = newSession();
  const b = newSession();
  run(a, "curl 1");
  run(a, "curl 2");
  assert.equal(run(b, "curl 3").code, 0);
  assert.equal(run(a, "curl 4").code, 2);
});

test("invalid JSON passes with exit code 0", () => {
  assert.equal(runRaw("this is not json").code, 0);
  assert.equal(runRaw("").code, 0);
  assert.equal(runRaw("[1,2").code, 0);
});

test("JSON without a command passes with exit code 0", () => {
  assert.equal(runRaw(JSON.stringify({ session_id: "x" })).code, 0);
  assert.equal(runRaw(JSON.stringify({ session_id: "x", tool_input: { command: 5 } })).code, 0);
  assert.equal(runRaw(JSON.stringify({ tool_input: { command: "" } })).code, 0);
});

test("the body of a heredoc is data: lines starting with #, a number or a word count as nothing", () => {
  const s = newSession();
  const note = (n) => `cat >> note.md <<'EOF'\n# heading ${n}\n30. 10. 16:00: step ${n}\nrepa other ${n}\npersona ${n}\nEOF`;
  for (const n of [1, 2, 3, 4]) assert.equal(run(s, note(n)).code, 0);
  const state = JSON.parse(readFileSync(join(SANDBOX, `agentic-brain-repeat-${s}.json`), "utf8"));
  assert.deepEqual(Object.keys(state), []);
  assert.equal(run(s, "curl a").code, 0);
  assert.equal(run(s, "curl b").code, 0);
  assert.equal(run(s, "curl c").code, 2);
});

test("a program before a heredoc still counts", () => {
  const s = newSession();
  assert.equal(run(s, "curl a <<EOF\nx\nEOF").code, 0);
  assert.equal(run(s, "curl b <<EOF\nx\nEOF").code, 0);
  assert.equal(run(s, "curl c <<EOF\nx\nEOF").code, 2);
});

test("--allow file lets three different runs of its program pass, the built-in list still works", () => {
  const dir = mkdtempSync(join(SANDBOX, "allow-"));
  const file = join(dir, "extra.allow");
  writeFileSync(file, "# extra\ntk\n");
  const s = newSession();
  for (const a of ["task list", "run list", "show 5", "done 6"]) assert.equal(run(s, `tk ${a}`, ["--allow", file]).code, 0);
  assert.equal(run(s, "git status", ["--allow", file]).code, 0);
  assert.equal(run(s, "curl a", ["--allow", file]).code, 0);
  assert.equal(run(s, "curl b", ["--allow", file]).code, 0);
  assert.equal(run(s, "curl c", ["--allow", file]).code, 2);
});

test("without --allow the program tk is counted", () => {
  const s = newSession();
  run(s, "tk a");
  run(s, "tk b");
  assert.equal(run(s, "tk c").code, 2);
});

test("a missing --allow file changes nothing and does not block", () => {
  const missing = join(SANDBOX, "does-not-exist.allow");
  const s = newSession();
  assert.equal(run(s, "curl a", ["--allow", missing]).code, 0);
  assert.equal(run(s, "curl b", ["--allow", missing]).code, 0);
  assert.equal(run(s, "curl c", ["--allow", missing]).code, 2);
  assert.equal(run(s, "git log", ["--allow", missing, "--allow"]).code, 0);
});

test("the state is in tmpdir under the session name", () => {
  const s = newSession();
  run(s, "curl a");
  assert.ok(readdirSync(SANDBOX).includes(`agentic-brain-repeat-${s}.json`));
});
