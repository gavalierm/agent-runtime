// tool_failure_log.mjs: zlyhaný Bash príkaz sa zapíše do registra (cesta
// z AR_STATE_TOOLS v /tmp), hook nikdy nezamieta a vždy skončí kódom 0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerLine } from "./tool_failure_log.mjs";
import { firstErrorLine, shapeOf, missingTool, envKey } from "../lib/tool_shape.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "tool_failure_log.mjs");
const ENV = "root@testhost";

function fail(command, error) {
  return { hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command, description: "x" }, error, is_interrupt: false };
}

function run(dir, input) {
  const file = join(dir, "state", "nastroje.tsv");
  const r = spawnSync("node", [HOOK], { input: JSON.stringify(input), env: { ...process.env, AR_STATE_TOOLS: file, AR_ENV_KEY: ENV }, encoding: "utf8" });
  return { r, file };
}

test("živý tvar vstupu: gh --version sa zapíše, riadok Exit code sa preskočí", () => {
  const dir = mkdtempSync(join(tmpdir(), "u615-log-"));
  try {
    const { r, file } = run(dir, fail("gh --version", "Exit code 127\n/bin/bash: line 1: gh: command not found"));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    const cols = readFileSync(file, "utf8").trimEnd().split("\t");
    assert.equal(cols.length, 7);
    assert.match(cols[0], /^\d{4}-\d\d-\d\dT/);
    assert.deepEqual(cols.slice(1), [ENV, "gh", "", "--version", "/bin/bash: line 1: gh: command not found", "gh --version"]);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git push s vypršaným spojením sa zapíše, ale nie je to chýbajúci nástroj", () => {
  const dir = mkdtempSync(join(tmpdir(), "u615-log-"));
  try {
    const { file } = run(dir, fail("cd /x && git push origin main", "Exit code 128\nssh: connect to host github.com port 22: Connection timed out"));
    const cols = readFileSync(file, "utf8").trimEnd().split("\t");
    assert.deepEqual(cols.slice(2, 5), ["git", "push", ""]);
    assert.equal(missingTool(cols[5], "git"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("curl s neznámym prepínačom sa zapíše s prepínačmi", () => {
  const dir = mkdtempSync(join(tmpdir(), "u615-log-"));
  try {
    const { file } = run(dir, fail("curl -sS --foo=1 http://x | head", "Exit code 2\ncurl: option --foo: is unknown\ncurl: try 'curl --help'"));
    const cols = readFileSync(file, "utf8").trimEnd().split("\t");
    assert.deepEqual(cols.slice(2, 6), ["curl", "", "--foo -sS", "curl: option --foo: is unknown"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("zreťazený príkaz: tvar vezme segment, ktorý chyba menuje", () => {
  const line = registerLine(fail("ls -la && gh pr list", "Exit code 127\nbash: gh: command not found"), { env: { AR_ENV_KEY: ENV } });
  assert.deepEqual(line.split("\t").slice(2, 5), ["gh", "", ""]);
  const none = registerLine(fail("cd /tmp && foo -x", "Exit code 1\nboom"), { env: { AR_ENV_KEY: ENV } });
  assert.deepEqual(none.split("\t").slice(2, 5), ["foo", "", "-x"]);
});

test("prerušenie, iný nástroj a pokazený vstup nič nezapíšu a skončia kódom 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "u615-log-"));
  try {
    const a = run(dir, { ...fail("sleep 9", "Exit code 130\n"), is_interrupt: true });
    assert.equal(a.r.status, 0);
    assert.equal(existsSync(a.file), false);
    const b = run(dir, { ...fail("x", "Exit code 1\ny"), tool_name: "Edit" });
    assert.equal(existsSync(b.file), false);
    const c = spawnSync("node", [HOOK], { input: "nie je json", env: { ...process.env, AR_STATE_TOOLS: a.file }, encoding: "utf8" });
    assert.equal(c.status, 0);
    assert.equal(existsSync(a.file), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tool_shape: tvar, rozdelenie príkazu, text v úvodzovkách a heredoc", () => {
  assert.deepEqual(shapeOf("FOO=1 curl -sS --x=2 u").flags, ["--x", "-sS"]);
  assert.equal(shapeOf("/usr/bin/gh pr list").program, "gh");
  assert.equal(shapeOf('git commit -m "a; gh x" --amend').shapes.length, 1);
  assert.equal(shapeOf('git commit -m "- gh"').flags.join(), "-m");
  assert.equal(shapeOf("cat <<'EOF'\ngh x\nEOF").shapes.length, 1);
  assert.equal(shapeOf("echo a; printf b; ls -l").program, "ls");
  assert.equal(shapeOf("ls 2>&1 | grep x").shapes.length, 2);
  assert.equal(shapeOf("").program, "");
  assert.match(envKey(), /^[^@]+@.+/);
  assert.equal(envKey({ user: "u", host: "h" }), "u@h");
  assert.equal(firstErrorLine("Exit code 1\n\n  boom  \nx"), "boom");
});

test("tool_shape: missingTool", () => {
  for (const t of ["bash: gh: command not found", "curl: option --foo: is unknown", "ls: unrecognized option '--x'", "git: 'foo' is not a git command. See 'git --help'.", "grep: invalid option -- 'Q'", "sudo: gh: command not found", "bash: ./x.sh: No such file or directory", "tar: option requires an argument -- 'f'"])
    assert.equal(missingTool(t), true, t);
  for (const t of ["sudo: must be run as root", "ssh: connect to host x port 22: Connection timed out", "cat: x: No such file or directory", "Usage: tool [x]", "ls: cannot access 'x': No such file or directory", "", "boom"])
    assert.equal(missingTool(t), false, t);
  assert.equal(missingTool("python3: can't open file 'x.py': [Errno 2] No such file or directory", "python3"), false);
  assert.equal(missingTool("bash: line 1: ./x.sh: No such file or directory", "x.sh"), true);
});

test("chyba iného programu sa nepripíše prvému segmentu (úloha 720, replay)", () => {
  const line = registerLine(fail("cat > /tmp/k.md <<'EOF'\nPosudok\nEOF\n/opt/agentic-workflow/bin/tk comment 714 --body-file /tmp/k.md", "Exit code 1\ntasker: unknown option --body-file"), { env: { AR_ENV_KEY: ENV } });
  assert.equal(line, null);
});
