// Test skills/error/scripts/error.sh (úloha Taskera 426, D0142, úloha 663 dávka 1b2).
// Falošný tasker cez AGENT_TK, register, HOME a globálny mozog v tmp, repo s commitnutým
// súborom v tmp. Nevolá živý Tasker, nepíše do živého registra ani do /root/.claude.
// Replay 390 a 420: druhý výskyt triedy založí úlohu.
// Spustenie: node --test test/error.test.mjs
import "../lib/git_isolate.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync, copyFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SH = join(REPO, "skills", "error", "scripts", "error.sh");
const TEMPLATE = join(REPO, "brain", "errors", "REGISTER.md");

const dir = mkdtempSync(join(tmpdir(), "error-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));
// Cesty testu musia byť v tmp, nie v živom HOME ani v živom registri.
assert.ok(dir.startsWith(tmpdir()) && !dir.startsWith(join(homedir(), ".local")));

const globalBrain = join(dir, "global-brain");
const log = join(dir, "tasker.log");
const fake = join(dir, "tasker");
writeFileSync(fake, `#!/bin/bash\nprintf '%s|%s\\n' "$AGENT_NAME" "$*" >> "${log}"\nif [ -n "\${FAKE_FAIL:-}" ]; then exit 1; fi\necho '{"id":501,"title":"x"}'\n`);
chmodSync(fake, 0o755);

const mkreg = (root, sub = "") => {
  const d = join(root, sub, "errors");
  mkdirSync(d, { recursive: true });
  copyFileSync(TEMPLATE, join(d, "REGISTER.md"));
  return join(d, "REGISTER.md");
};
const rows = (reg) => readFileSync(reg, "utf8").split("\n").filter((l) => /^\| \d{4}-\d{2}-\d{2} \|/.test(l));
const cells = (row) => row.split("|").slice(1, -1).map((c) => c.trim());

const brainA = join(dir, "brain-a");
const regA = mkreg(brainA);
mkreg(globalBrain);

const repo = join(dir, "repo");
mkdirSync(repo);
const git = (...a) => spawnSync("git", ["-C", repo, "-c", "user.name=T", "-c", "user.email=t@example.org", ...a], { encoding: "utf8" });
git("init", "-q");
writeFileSync(join(repo, "hook.mjs"), "x\n");
git("add", "hook.mjs");
git("commit", "-qm", "init");
const head = git("log", "-1", "--format=%h").stdout.trim();

const run = (args, env = {}, cwd = dir) =>
  spawnSync("bash", [SH, ...args], {
    encoding: "utf8",
    cwd,
    env: { PATH: process.env.PATH, HOME: dir, AGENT_BRAIN_GLOBAL: globalBrain, ERROR_AGENT: "spravca-agentov", AGENT_TK: fake, ...env },
  });
const MECH = ["--mechanism", "hook:hooks/own_rule_scope.mjs"];
const args = (cls, brain = brainA) => ["--class", cls, "--file", join(repo, "hook.mjs"), "--description", "úloha ostala todo po komentári", "--brain", brain, ...MECH];
const lines = (out) => out.trim().split("\n");

test("prvý výskyt zapíše riadok a úlohu nezaloží, hlásenie má štyri vety", () => {
  const r = run(args("todo-po-komentari"));
  assert.equal(r.status, 0, r.stderr);
  const l = lines(r.stdout);
  assert.equal(l.length, 4);
  assert.match(l[0], /úloha ostala todo po komentári/);
  assert.match(l[2], new RegExp(`hook\\.mjs, commit ${head}`));
  assert.match(l[3], /Nabudúce to zastaví: hook:hooks\/own_rule_scope\.mjs\.$/);
  assert.ok(!existsSync(log), "tasker sa nesmie volať");
  const r1 = rows(regA);
  assert.equal(r1.length, 1);
  const c = cells(r1[0]);
  assert.equal(c.length, 5, "dátum, trieda, opis, oprava, test");
  assert.deepEqual([c[1], c[2]], ["todo-po-komentari", "úloha ostala todo po komentári"]);
  assert.equal(c[3], `hook.mjs, commit ${head}, hook:hooks/own_rule_scope.mjs`);
  assert.equal(c[4], "hook:hooks/own_rule_scope.mjs");
});

test("replay 390 a 420: druhý výskyt tej istej triedy založí úlohu na kontrolu", () => {
  const r = run(args("todo-po-komentari"));
  assert.equal(r.status, 0, r.stderr);
  assert.match(lines(r.stdout)[3], /úloha 501/);
  const call = readFileSync(log, "utf8");
  assert.match(call, /^spravca-agentov\|task add --project agenti --assign spravca-agentov --title Kontrola proti chybe triedy todo-po-komentari \(spravca-agentov\)/);
  assert.match(call, /--json/);
  assert.match(cells(rows(regA)[1])[3], /, úloha 501$/);
});

test("tretí výskyt úlohu nezaloží znova", () => {
  const before = readFileSync(log, "utf8");
  const r = run(args("todo-po-komentari"));
  assert.equal(readFileSync(log, "utf8"), before);
  assert.match(lines(r.stdout)[3], /úloha 501/);
});

test("iná trieda alebo iný register počíta od začiatku", () => {
  const before = readFileSync(log, "utf8");
  run(args("ina-trieda"));
  const regB = mkreg(join(dir, "brain-b"));
  run(args("todo-po-komentari", join(dir, "brain-b")));
  assert.equal(readFileSync(log, "utf8"), before);
  assert.equal(rows(regB).length, 1);
});

test("zlyhanie Taskera: chyba na stderr, riadok v registri bez úlohy, ďalší výskyt skúsi znova", () => {
  const brain = join(dir, "brain-fail");
  const reg = mkreg(brain);
  run(args("trieda-b", brain));
  const r2 = run(args("trieda-b", brain), { FAKE_FAIL: "1" });
  assert.equal(r2.status, 0);
  assert.match(r2.stderr, /could not be created/);
  assert.doesNotMatch(lines(r2.stdout)[3], /úloha \d/);
  assert.doesNotMatch(rows(reg)[1], /, úloha \d/);
  const r3 = run(args("trieda-b", brain));
  assert.match(lines(r3.stdout)[3], /úloha 501/);
});

test("bez AGENT_TK sa úloha nezakladá a skript to povie", () => {
  const brain = join(dir, "brain-notk");
  const reg = mkreg(brain);
  const before = existsSync(log) ? readFileSync(log, "utf8") : "";
  run(args("bez-tk", brain), { AGENT_TK: "" });
  const r = run(args("bez-tk", brain), { AGENT_TK: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /AGENT_TK is not set, the review task is not created/);
  assert.equal(rows(reg).length, 2);
  assert.equal(existsSync(log) ? readFileSync(log, "utf8") : "", before);
});

test("chýbajúca trieda, necommitnutý súbor a neexistujúci register skončia chybou so Správnym postupom", () => {
  for (const a of [
    ["--file", join(repo, "hook.mjs"), "--brain", brainA, ...MECH],
    ["--class", "x", "--file", join(dir, "nie-je"), "--brain", brainA, ...MECH],
    ["--class", "x", "--file", join(repo, "hook.mjs"), "--brain", join(dir, "nie-je-mozog"), ...MECH],
  ]) {
    const r = run(a);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /Správny postup:/);
  }
  writeFileSync(join(repo, "hook.mjs"), "zmena\n");
  const before = readFileSync(regA, "utf8");
  const r = run(args("x"));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /is not committed/);
  assert.equal(readFileSync(regA, "utf8"), before);
  git("checkout", "--", "hook.mjs");
});

test("neznáma voľba skončí kódom 64", () => {
  assert.equal(run(["--trieda", "x"]).status, 64);
});

test("agent z PERSONA.md v CLAUDE_PROJECT_DIR sa dostane do názvu úlohy", () => {
  const proj = join(dir, "dizajner-proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(join(proj, "PERSONA.md"), "# dizajner\n\nRole: x\n");
  const brain = join(dir, "brain-persona");
  mkreg(brain);
  const env = { ERROR_AGENT: "", CLAUDE_PROJECT_DIR: proj };
  run(args("persona-meno", brain), env);
  const r = run(args("persona-meno", brain), env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(log, "utf8"), /^dizajner\|task add .*--title Kontrola proti chybe triedy persona-meno \(dizajner\)/m);
});

test("bez mechanizmu alebo so zlým tvarom skončí kódom 1 so Správnym postupom a nič nezapíše", () => {
  const brain = join(dir, "brain-bez-mechanizmu");
  const reg = mkreg(brain);
  const before = readFileSync(reg, "utf8");
  const base = ["--class", "t", "--file", join(repo, "hook.mjs"), "--brain", brain];
  for (const extra of [[], ["--mechanism", ""], ["--mechanism", "hook"], ["--mechanism", "hook:"], ["--mechanism", "pravidlo:x"], ["--mechanism", "decision:183"], ["--mechanism", "rozhodnutie:D0183"], ["--mechanism", "test: x y"]]) {
    const r = run([...base, ...extra]);
    assert.equal(r.status, 1, `${extra.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /^Správny postup: /m);
    assert.equal(readFileSync(reg, "utf8"), before);
  }
});

test("všetky štyri tvary mechanizmu sa zapíšu do stĺpca opravy", () => {
  const brain = join(dir, "brain-tvary");
  const reg = mkreg(brain);
  const values = ["hook:/x", "test:test/error.test.mjs", "deny:Bash(rm -rf /*)", "decision:D0183"];
  for (const h of values) {
    const r = run(["--class", "t", "--file", join(repo, "hook.mjs"), "--mechanism", h, "--brain", brain], { AGENT_TK: "" });
    assert.equal(r.status, 0, r.stderr);
  }
  assert.deepEqual(rows(reg).map((r) => cells(r)[3].split(", ")[2]), values);
});

test("--check ide do stĺpca testu a do štvrtej vety, --truth do druhej", () => {
  const brain = join(dir, "brain-check");
  const reg = mkreg(brain);
  const r = run([...args("kontrola", brain), "--check", "test/error.test.mjs zlyhá na chybe", "--truth", "súbor bol commitnutý"]);
  assert.equal(cells(rows(reg)[0])[4], "test/error.test.mjs zlyhá na chybe");
  assert.match(lines(r.stdout)[1], /^Pravda bola: súbor bol commitnutý\.$/);
  assert.match(lines(r.stdout)[3], /Nabudúce to zastaví: test\/error\.test\.mjs zlyhá na chybe\./);
});

test("--open vypíše riadky bez opravy a register nezmení", () => {
  const brain = join(dir, "brain-open");
  const reg = mkreg(brain);
  const added = "| 2026-10-01 | stara-trieda | popis | | |\n| 2026-10-02 | ina | popis | opravené, hook:x | hook:x |\n";
  writeFileSync(reg, readFileSync(reg, "utf8") + added);
  const before = readFileSync(reg, "utf8");
  const r = run(["--open", "--brain", brain], { ERROR_AGENT: "" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "2026-10-01\tstara-trieda\tpopis\n");
  assert.equal(readFileSync(reg, "utf8"), before);
  const none = run(["--open", "--brain", join(dir, "ziadny-mozog")]);
  assert.equal(none.status, 0);
  assert.equal(none.stdout, "");
  assert.ok(!existsSync(join(dir, "ziadny-mozog")));
});

test("register sa nájde z pracovného priečinka: agentic-brain/errors, errors v koreni, globálny mozog", () => {
  const withBrain = join(dir, "repo-s-mozgom");
  mkdirSync(withBrain);
  spawnSync("git", ["-C", withBrain, "init", "-q"]);
  const regNested = mkreg(withBrain, "agentic-brain");
  mkdirSync(join(withBrain, "sub"));
  const argsNo = ["--class", "c", "--file", join(repo, "hook.mjs"), ...MECH];
  assert.equal(run(argsNo, {}, join(withBrain, "sub")).status, 0);
  assert.equal(rows(regNested).length, 1);

  const rootBrain = join(dir, "repo-mozog-v-koreni");
  mkdirSync(rootBrain);
  spawnSync("git", ["-C", rootBrain, "init", "-q"]);
  const regRoot = mkreg(rootBrain);
  assert.equal(run(argsNo, {}, rootBrain).status, 0);
  assert.equal(rows(regRoot).length, 1);

  const plain = join(dir, "repo-bez-mozgu");
  mkdirSync(plain);
  spawnSync("git", ["-C", plain, "init", "-q"]);
  assert.equal(run(argsNo, {}, plain).status, 0);
  assert.equal(rows(join(globalBrain, "errors", "REGISTER.md")).length, 1);

  const byRoot = run([...argsNo, "--brain", withBrain]);
  assert.equal(byRoot.status, 0, byRoot.stderr);
  assert.equal(rows(regNested).length, 2, "--brain s koreňom repa nájde agentic-brain/errors");
});

test("zápis nikdy nejde mimo tmp: živý globálny mozog ostal nedotknutý", () => {
  for (const reg of [regA, join(globalBrain, "errors", "REGISTER.md")]) assert.ok(reg.startsWith(tmpdir()), reg);
});
