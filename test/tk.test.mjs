// Test obalu tk: --verify s vetou namiesto príkazu odmietne (chyba 25. 10. 2026).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync as mkdtempRaw, writeFileSync, chmodSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir, userInfo } from "node:os";
import { fileURLToPath } from "node:url";

// Dočasné priečinky testu sa na konci zmažú (úloha 701).
const tmpDirs = [];
const mkdtempSync = (prefix) => { const d = mkdtempRaw(prefix); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

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

// Nasadenie 29. 10. 2026 (úloha 665): vlákno T3 nemá AGENT_TASKER_USER v
// prostredí, tk ho číta z runtime.env agenta ako hooky.
test("používateľ správcu úloh z runtime.env, keď ho prostredie nemá", () => {
  const rt = join(dir, "runtime.env");
  writeFileSync(rt, `# komentár\nAGENT_NAME=test\nexport AGENT_TASKER_USER="${userInfo().username}"\n`);
  const r = spawnSync("bash", [TK, "task", "show", "1"], {
    encoding: "utf8",
    env: { PATH: `${dir}:${process.env.PATH}`, AGENT_NAME: "test", TK_HOME: dir, AGENT_RUNTIME_ENV: rt },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /FAKE task show 1/);
});

test("prostredie má prednosť pred runtime.env", () => {
  const rt = join(dir, "runtime2.env");
  writeFileSync(rt, "AGENT_TASKER_USER=niekto-iny\n");
  const r = spawnSync("bash", [TK, "task", "show", "1"], {
    encoding: "utf8",
    env: { PATH: `${dir}:${process.env.PATH}`, AGENT_NAME: "test", TK_HOME: dir, AGENT_RUNTIME_ENV: rt, AGENT_TASKER_USER: userInfo().username },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /FAKE task show 1/);
});

// Úloha 665: vlákno T3 agenta nemá AGENT_NAME ani TASKER_USER, meno nesie
// PERSONA.md (lib/agent_name.sh). Podvrh tasker vypíše TASKER_USER, ktorý dostal.
test("bez AGENT_NAME a TASKER_USER odvodí meno z PERSONA.md v cwd", () => {
  const d = mkdtempSync(join(tmpdir(), "tk-persona-"));
  writeFileSync(join(d, "tasker"), "#!/bin/sh\necho USER=$TASKER_USER\n");
  chmodSync(join(d, "tasker"), 0o755);
  writeFileSync(join(d, "PERSONA.md"), "# Delta\n\nText.\n");
  const env = { PATH: `${d}:${process.env.PATH}`, TK_HOME: d, TK_USER: userInfo().username };
  const r = spawnSync("bash", [TK, "task", "show", "1"], { encoding: "utf8", env, cwd: d });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /USER=delta/);
  const prazdny = mkdtempSync(join(tmpdir(), "tk-bez-"));
  const bez = spawnSync("bash", [TK, "task", "show", "1"], { encoding: "utf8", env, cwd: prazdny });
  assert.equal(bez.status, 64);
  assert.doesNotMatch(bez.stdout, /USER=/);
});
