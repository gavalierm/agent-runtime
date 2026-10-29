// Test obalu tk: --verify s vetou namiesto príkazu odmietne (chyba 25. 10. 2026).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";

const TK = process.env.TK_BIN || join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "tk");
const dir = mkdtempSync(join(tmpdir(), "tk-test-"));
// Podvrh tasker, živý Tasker sa nespustí.
writeFileSync(join(dir, "tasker"), "#!/bin/sh\necho FAKE \"$@\"\n");
chmodSync(join(dir, "tasker"), 0o755);
const run = (...args) => spawnSync("bash", [TK, ...args], {
  encoding: "utf8",
  env: { PATH: `${dir}:${process.env.PATH}`, AGENT_NAME: "test", TK_HOME: dir, TK_USER: userInfo().username },
});

test("replay 557: veta v --verify je odmietnutá", () => {
  const r = run("task", "add", "--title", "x", "--verify", "git -C /opt/tasker merge-base --is-ancestor 3ae58cb HEAD skončí kódom 0");
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.stdout, /FAKE/);
});

test("--verify=veta je odmietnutá", () => {
  assert.equal(run("task", "add", "--verify=overí, že služba beží").status, 2);
});

test("príkaz s diakritikou len v úvodzovkách prejde", () => {
  const r = run("task", "add", "--verify", "grep -q 'hotová úloha' /tmp/x && test -f \"/tmp/žltý\"");
  assert.equal(r.status, 0);
  assert.match(r.stdout, /FAKE task add/);
});

test("bez --verify prejde aj body s diakritikou", () => {
  assert.equal(run("task", "add", "--body", "Dôvod: úloha").status, 0);
});
