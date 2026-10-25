// Test bin/chyba.sh (úloha Taskera 426, D0142). Hook objection_fix.mjs má test
// v test/objection_fix_hook.test.mjs.
// Falošný tasker cez CHYBA_TASKER, register a HOME v tmp, repo s commitnutým
// súborom v tmp. Nevolá živý Tasker, nepíše do živého registra ani do
// /root/.claude. Replay 390 a 420: druhý výskyt triedy založí úlohu.
// Spustenie: node --test test/chyba.test.mjs
import "../lib/git_isolate.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SH = join(REPO, "bin", "chyba.sh");

const dir = mkdtempSync(join(tmpdir(), "chyba-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
// Cesty testu musia byť v tmp, nie v živom HOME ani v živom registri.
assert.ok(dir.startsWith(tmpdir()) && !dir.startsWith(join(homedir(), ".local")));

const reg = join(dir, "chyby.tsv");
const log = join(dir, "tasker.log");
const fake = join(dir, "tasker");
writeFileSync(fake, `#!/bin/bash\nprintf '%s\\n' "$*" >> "${log}"\nif [ -n "\${FAKE_FAIL:-}" ]; then exit 1; fi\necho '{"id":501,"title":"x"}'\n`);
chmodSync(fake, 0o755);

const repo = join(dir, "repo");
mkdirSync(repo);
const git = (...a) => spawnSync("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.org", ...a], { encoding: "utf8" });
git("init", "-q");
writeFileSync(join(repo, "hook.mjs"), "x\n");
git("add", "hook.mjs");
git("commit", "-qm", "init");
const head = git("log", "-1", "--format=%h").stdout.trim();

const run = (args, env = {}) => {
  return spawnSync("bash", [SH, ...args], {
    encoding: "utf8",
    cwd: dir,
    env: { PATH: process.env.PATH, HOME: dir, CHYBA_AGENT: "spravca-agentov", CHYBA_REGISTER: reg, CHYBA_TASKER: fake, ...env },
  });
};
const args = (trieda) => ["--trieda", trieda, "--subor", join(repo, "hook.mjs"), "--popis", "úloha ostala todo po komentári"];
const sentences = (out) => out.trim().split("\n");

test("prvý výskyt zapíše riadok a úlohu nezaloží, hlásenie má štyri vety", () => {
  const r = run(args("todo-po-komentari"));
  assert.equal(r.status, 0, r.stderr);
  const l = sentences(r.stdout);
  assert.equal(l.length, 4);
  assert.match(l[0], /úloha ostala todo po komentári/);
  assert.match(l[2], new RegExp(`hook\\.mjs, commit ${head}`));
  assert.match(l[3], /druhý výskyt/);
  assert.ok(!existsSync(log), "tasker sa nesmie volať");
  const cols = readFileSync(reg, "utf8").trim().split("\n")[0].split("\t");
  assert.deepEqual([cols[1], cols[2], cols[4]], ["spravca-agentov", "todo-po-komentari", head]);
});

test("replay 390 a 420: druhý výskyt tej istej triedy založí úlohu na kontrolu", () => {
  const r = run(args("todo-po-komentari"));
  assert.equal(r.status, 0, r.stderr);
  assert.match(sentences(r.stdout)[3], /úloha 501/);
  const call = readFileSync(log, "utf8");
  assert.match(call, /task add --project agenti --assign spravca-agentov --title Kontrola proti chybe triedy todo-po-komentari \(spravca-agentov\)/);
  assert.match(call, /--json/);
});

test("tretí výskyt úlohu nezaloží znova", () => {
  const before = readFileSync(log, "utf8");
  const r = run(args("todo-po-komentari"));
  assert.equal(readFileSync(log, "utf8"), before);
  assert.match(sentences(r.stdout)[3], /úloha 501/);
});

test("iná trieda alebo iný agent počíta od začiatku", () => {
  const before = readFileSync(log, "utf8");
  run(args("ina-trieda"));
  run(args("todo-po-komentari"), { CHYBA_AGENT: "spravca-servera" });
  assert.equal(readFileSync(log, "utf8"), before);
});

test("zlyhanie Taskera: chyba na stderr, riadok v registri bez úlohy, ďalší výskyt skúsi znova", () => {
  const r1 = run(args("trieda-b"));
  const r2 = run(args("trieda-b"), { FAKE_FAIL: "1" });
  assert.equal(r2.status, 0);
  assert.match(r2.stderr, /nepodarilo založiť/);
  assert.match(sentences(r2.stdout)[3], /druhý výskyt/);
  const r3 = run(args("trieda-b"));
  assert.match(sentences(r3.stdout)[3], /úloha 501/);
  assert.equal(r1.status, 0);
});

test("chýbajúca trieda, agent, necommitnutý súbor skončia chybou so Správnym postupom", () => {
  for (const [a, env] of [
    [["--subor", join(repo, "hook.mjs")], {}],
    [args("x"), { CHYBA_AGENT: "", AGENT_NAME: "", TASKER_USER: "" }],
    [["--trieda", "x", "--subor", join(dir, "nie-je")], {}],
  ]) {
    const r = run(a, env);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Správny postup:/);
  }
  writeFileSync(join(repo, "hook.mjs"), "zmena\n");
  const r = run(args("x"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /nie je commitnutý/);
  git("checkout", "--", "hook.mjs");
});

test("vlákno T3 bez mena v prostredí: agent z PERSONA.md v CLAUDE_PROJECT_DIR", () => {
  const proj = join(dir, "dizajner-proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "PERSONA.md"), "# dizajner\n\nRole: x\n");
  const r = run(args("persona-meno"), { CHYBA_AGENT: "", CLAUDE_PROJECT_DIR: proj });
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(reg, "utf8"), /\tdizajner\tpersona-meno\t/);
});
