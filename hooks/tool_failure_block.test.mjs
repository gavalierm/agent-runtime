// tool_failure_block.mjs: druhý pokus o ten istý tvar po chybe o chýbajúcom
// nástroji sa zamietne, zoznam nefunkčných nástrojov zamietne hneď. Register
// (AR_STATE_TOOLS) a zoznam (AR_TOOLS_KNOWN) sú v /tmp, prostredie dáva AR_ENV_KEY.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { blockReason } from "./tool_failure_block.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const BLOCK = join(DIR, "tool_failure_block.mjs");
const LOG = join(DIR, "tool_failure_log.mjs");
// Vzorový zoznam nefunkčných nástrojov (program, prepínače, používateľ, náhrada); živý zoznam je
// dáta prostredia a test ho nečíta.
const KNOWN_LIST = [
  "gh\t*\t*\tgit s tokenom z ~/.config/<meno>/ (skill github-repo); PR sa nerobí, projekt ide dev -> main",
  "sudo\t*\troot\tpod rootom bez sudo: spusti príkaz priamo",
  "doas\t*\troot\tpod rootom bez doas: spusti príkaz priamo",
  "",
].join("\n");

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "u615-block-"));
  const known = join(dir, "known.tsv");
  writeFileSync(known, "# prázdny zoznam\n");
  return { dir, known, register: join(dir, "state", "nastroje.tsv") };
}

const envOf = (sb, user = "root") => ({ ...process.env, AR_STATE_TOOLS: sb.register, AR_TOOLS_KNOWN: sb.known, AR_ENV_KEY: `${user}@testhost` });

function pre(sb, command, user) {
  const r = spawnSync("node", [BLOCK], { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } }), env: envOf(sb, user), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
}

function logFailure(sb, command, error, user) {
  const r = spawnSync("node", [LOG], { input: JSON.stringify({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command }, error, is_interrupt: false }), env: envOf(sb, user), encoding: "utf8" });
  assert.equal(r.status, 0);
}

test("gh --version: prvý pokus prejde, log zapíše, druhý zamietne s postupom", () => {
  const sb = sandbox();
  try {
    assert.equal(pre(sb, "gh --version"), null);
    logFailure(sb, "gh --version", "Exit code 127\n/bin/bash: line 1: gh: command not found");
    const d = pre(sb, "gh --version");
    assert.equal(d.permissionDecision, "deny");
    assert.match(d.permissionDecisionReason, /`gh --version` v prostredí root@testhost už zlyhal \(\/bin\/bash: line 1: gh: command not found\)/);
    assert.match(d.permissionDecisionReason, /\nSprávny postup: použi iný nástroj alebo tvar; keď nový tvar prejde, pridaj do env\/server\/nastroje\.tsv riadok s náhradou/);
    // iné prostredie a iné prepínače register nezasiahne
    assert.equal(pre(sb, "gh --version", "tasker-svc"), null);
    assert.equal(pre(sb, "gh pr list"), null);
    // zreťazený príkaz sa posudzuje po jednoduchých príkazoch
    assert.equal(pre(sb, "cd /tmp && gh --version | head").permissionDecision, "deny");
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("sudo ls pod rootom zo zoznamu zamietne hneď, pod iným používateľom prejde", () => {
  const sb = sandbox();
  try {
    writeFileSync(sb.known, KNOWN_LIST);
    const d = pre(sb, "sudo ls", "root");
    assert.equal(d.permissionDecision, "deny");
    assert.match(d.permissionDecisionReason, /zozname nefunkčných nástrojov servera/);
    assert.match(d.permissionDecisionReason, /Správny postup: pod rootom bez sudo/);
    assert.equal(pre(sb, "sudo ls", "tasker-svc"), null);
    assert.equal(pre(sb, "doas ls", "root").permissionDecision, "deny");
    const gh = pre(sb, "gh pr create --title x", "tasker-svc");
    assert.match(gh.permissionDecisionReason, /Správny postup: git s tokenom z ~\/\.config\/<meno>\/ \(skill github-repo\); PR sa nerobí/);
    assert.equal(pre(sb, "git status && ls -la", "root"), null);
    assert.equal(pre(sb, "echo sudo gh", "root"), null);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("zoznam: prepínače musia byť podmnožinou prepínačov príkazu", () => {
  const sb = sandbox();
  try {
    writeFileSync(sb.known, "curl\t--foo --bar\t*\tpouži --baz\n");
    const known = { env: "root@h", knownFile: sb.known };
    assert.equal(blockReason("curl -s --foo x", known), null);
    assert.equal(blockReason("curl --bar --foo x -s", known).postup, "použi --baz");
    assert.equal(blockReason("", known), null);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("git push s vypršaným spojením: zapíše sa, druhý pokus prejde", () => {
  const sb = sandbox();
  try {
    logFailure(sb, "git push origin main", "Exit code 128\nssh: connect to host github.com port 22: Connection timed out");
    assert.equal(pre(sb, "git push origin main"), null);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("curl: neznámy prepínač zamietne druhý pokus, iné prepínače prejdú", () => {
  const sb = sandbox();
  try {
    logFailure(sb, "curl -sS x", "Exit code 2\ncurl: option --foo: is unknown\ncurl: try 'curl --help'");
    assert.equal(pre(sb, "curl -sS x").permissionDecision, "deny");
    assert.equal(pre(sb, "curl -s x"), null);
    assert.equal(pre(sb, "curl x"), null);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("git s neznámym podpríkazom nezamietne ostatné podpríkazy gitu", () => {
  const sb = sandbox();
  try {
    logFailure(sb, "git foo", "Exit code 1\ngit: 'foo' is not a git command. See 'git --help'.");
    assert.equal(pre(sb, "git foo").permissionDecision, "deny");
    assert.equal(pre(sb, "git status"), null);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("chyba o práve alebo sieti tvar neblokuje, čistý ls prejde", () => {
  const sb = sandbox();
  try {
    logFailure(sb, "tool-x --y", "Exit code 1\ntool-x: must be run as root");
    assert.equal(pre(sb, "tool-x --y"), null);
    logFailure(sb, "python3 run.py", "Exit code 2\npython3: can't open file '/x/run.py': [Errno 2] No such file or directory");
    assert.equal(pre(sb, "python3 run.py"), null);
    assert.equal(pre(sb, "ls"), null);
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});

test("pokazený vstup a iný nástroj než Bash prejdú", () => {
  const sb = sandbox();
  try {
    const a = spawnSync("node", [BLOCK], { input: "nie je json", env: envOf(sb), encoding: "utf8" });
    assert.equal(a.status, 0);
    assert.equal(a.stdout, "");
    const b = spawnSync("node", [BLOCK], { input: JSON.stringify({ tool_name: "Read", tool_input: { command: "sudo ls" } }), env: envOf(sb), encoding: "utf8" });
    assert.equal(b.stdout, "");
  } finally {
    rmSync(sb.dir, { recursive: true, force: true });
  }
});
