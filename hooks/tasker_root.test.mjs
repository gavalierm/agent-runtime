// tasker_root.mjs: zamietne priamy tasker pod rootom, pustí runuser
// pod tasker-svc, čítanie slova tasker a text v úvodzovkách.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { taskerRootReason } from "./tasker_root.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "tasker_root.mjs");
const TK = join(dirname(HOOK), "..", "bin", "tk");
const chk = (cmd) => taskerRootReason(cmd, { uid: 0 });

function run(command) {
  const out = execFileSync("node", [HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }) }).toString();
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : "";
}

test("priamy tasker pod rootom zamietne", () => {
  assert.ok(chk("tasker task show 354 --json"));
  assert.ok(chk("cd /root/adam && tasker task list"));
  assert.ok(chk("TASKER_USER=adam tasker done 5"));
  assert.ok(chk("ls | tasker comment 5"));
  assert.ok(chk("x=$(tasker task show 5 --json)"));
  assert.ok(chk("false || tasker task list"));
  assert.ok(chk("ls; /usr/local/bin/tasker agent list"));
  assert.ok(chk("env TASKER_HOME=/x tasker task list"));
  assert.ok(chk("sh -c 'tasker task list'"));
  assert.ok(chk("cat <<EOF\ntext\nEOF\ntasker task list"));
});

test("dôvod nesie presný príkaz", () => {
  const out = execFileSync("node", [HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command: "tasker task show 354 --json" } }) }).toString();
  if (process.getuid() === 0) assert.ok(JSON.parse(out).hookSpecificOutput.permissionDecisionReason.includes("/opt/agentic-workflow/bin/tk ..."));
});

test("správne volanie a text so slovom tasker pustí", () => {
  assert.equal(chk("runuser -u tasker-svc -- env TASKER_HOME=/home/tasker-svc/.tasker TASKER_USER=adam tasker task show 354 --json"), null);
  assert.equal(chk("sudo -u tasker-svc tasker task list"), null);
  assert.equal(chk("su - tasker-svc -c 'tasker task list'"), null);
  assert.equal(chk("grep -n tasker x"), null);
  assert.equal(chk("cat /root/tasker/README.md"), null);
  assert.equal(chk("which tasker"), null);
  assert.equal(chk("cd /home/tasker-svc && ls"), null);
  assert.equal(chk("cd /root/tasker && git status"), null);
  assert.equal(chk('echo "spusti tasker task list"'), null);
  assert.equal(chk("echo 'tasker'"), null);
  assert.equal(chk("ask_agent.sh boris x <<'EOF'\ntasker task list\nEOF"), null);
  assert.equal(chk("ls | grep tasker"), null);
});

test("proces bez uid 0 pustí", () => {
  assert.equal(taskerRootReason("tasker task list", { uid: 1001 }), null);
});

test("hook ako proces: deny a prázdny výstup", (t) => {
  if (process.getuid() !== 0) return t.skip("hook zamieta len pod rootom");
  assert.equal(run("tasker task show 354 --json"), "deny");
  assert.equal(run("grep -n tasker x"), "");
});

test("obal tk prejde hookom, rovnako s cestou a s AGENT_NAME", () => {
  assert.equal(chk("/opt/agentic-workflow/bin/tk task show 462 --json"), null);
  assert.equal(chk("AGENT_NAME=adam tk task list"), null);
  assert.equal(chk("tk task list | grep x"), null);
  assert.equal(chk('AGENT_NAME=adam /opt/agentic-workflow/bin/tk comment 462 --body "x"'), null);
});

// Falošný runuser zapíše argumenty do súboru, živý Tasker sa nevolá.
function tk(args, env, cwd) {
  const dir = mkdtempSync(join(tmpdir(), "tk-"));
  try {
    const log = join(dir, "log");
    writeFileSync(join(dir, "runuser"), `#!/bin/sh\nprintf '%s\\n' "$*" > ${log}\n`);
    chmodSync(join(dir, "runuser"), 0o755);
    const r = spawnSync(TK, args, {
      cwd: cwd ?? dir,
      env: { PATH: `${dir}:${process.env.PATH}`, TK_USER: "nikto-taký", ...env },
      encoding: "utf8",
    });
    let called = "";
    try { called = readFileSync(log, "utf8").trim(); } catch {}
    return { code: r.status, err: r.stderr, called };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("tk s AGENT_NAME spustí tasker pod TK_USER s TASKER_HOME v jeho domove a TASKER_USER", () => {
  const r = tk(["task", "show", "462", "--json"], { AGENT_NAME: "adam" });
  assert.equal(r.code, 0);
  assert.equal(r.called, "-u nikto-taký -- env TASKER_HOME=/home/nikto-taký/.tasker TASKER_USER=adam tasker task show 462 --json");
});

test("tk bez TK_USER vezme používateľa z AGENT_TASKER_USER, inak tasker", () => {
  const a = tk(["task", "list"], { AGENT_NAME: "adam", TK_USER: "", AGENT_TASKER_USER: "tasker-svc" });
  assert.equal(a.called, "-u tasker-svc -- env TASKER_HOME=/home/tasker-svc/.tasker TASKER_USER=adam tasker task list");
  const b = tk(["task", "list"], { AGENT_NAME: "adam", TK_USER: "" });
  assert.match(b.called, /^-u tasker -- env TASKER_HOME=\/home\/tasker\/\.tasker /);
});

test("tk bez AGENT_NAME a bez persony skončí chybou a tasker nespustí", () => {
  const r = tk(["task", "list"], {});
  assert.equal(r.code, 64);
  assert.match(r.err, /Správny postup: AGENT_NAME=<meno> tk/);
  assert.equal(r.called, "");
});

test("tk bez AGENT_NAME vezme meno z PERSONA.md projektu", () => {
  const proj = mkdtempSync(join(tmpdir(), "tk-persona-"));
  try {
    writeFileSync(join(proj, "PERSONA.md"), "# Xaver\n");
    const r = tk(["task", "list"], {}, proj);
    assert.equal(r.code, 0);
    assert.match(r.called, /TASKER_USER=xaver tasker task list$/);
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

test("tk odmietne meno s nebezpečnými znakmi", () => {
  const r = tk(["task", "list"], { AGENT_NAME: "x; rm -rf /" });
  assert.equal(r.code, 64);
  assert.equal(r.called, "");
});
