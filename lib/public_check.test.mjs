// Test lib/public_check.mjs. Dočasné repo v tmp a vlastný zoznam vzorov, zoznam
// repa sa na nález mena nepoužíva (mená by sa dostali do testu). Spustenie:
// node --test lib/public_check.test.mjs
import "./git_isolate.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllowed, loadPatterns, scanCommits, scanRepo, scanText } from "./public_check.mjs";

const LIB = dirname(fileURLToPath(import.meta.url));
const list = (dir, ...pats) => {
  const f = join(dir, "vzory.txt");
  writeFileSync(f, ["# komentár", ...pats.map((p) => Buffer.from(p).toString("base64"))].join("\n") + "\n");
  return f;
};
const git = (dir, ...a) => execFileSync("git", ["-C", dir, "-c", "user.name=Autor", "-c", "user.email=a@example.org", ...a], { encoding: "utf8" });

test("scanText nájde riadok a nevypíše nájdené slovo", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-"));
  try {
    const p = loadPatterns(list(dir, "zakazane\\b"));
    assert.deepEqual(scanText("f", "čisté\nmá Zakazane slovo\nčisté", p), ["f:2"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scanRepo zlyhá na súbore v gite, aj na názve súboru, čistý repo prejde", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-"));
  try {
    const p = loadPatterns(list(dir, "zakazane"));
    git(dir, "init", "-q");
    writeFileSync(join(dir, "a.md"), "čistý text\n");
    git(dir, "add", "a.md");
    assert.deepEqual(scanRepo(dir, p), []);
    writeFileSync(join(dir, "b.md"), "riadok 1\nriadok so zakazane slovom\n");
    git(dir, "add", "b.md");
    assert.deepEqual(scanRepo(dir, p), ["b.md:2"]);
    writeFileSync(join(dir, "zakazane.txt"), "x\n");
    git(dir, "add", "zakazane.txt");
    assert.ok(scanRepo(dir, p).includes("zakazane.txt: názov súboru"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("scanCommits zachytí meno autora a správu commitu", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-"));
  try {
    const p = loadPatterns(list(dir, "zakazane"));
    git(dir, "init", "-q");
    writeFileSync(join(dir, "a.md"), "x\n");
    git(dir, "add", "a.md");
    git(dir, "commit", "-qm", "čistá správa");
    git(dir, "-c", "user.name=Zakazane", "commit", "-q", "--allow-empty", "-m", "druhý zakazane");
    const hits = scanCommits("HEAD~1..HEAD", dir, p);
    assert.equal(hits.length, 3, hits.join("\n"));
    assert.deepEqual(scanCommits("HEAD~1", dir, p), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("zoznam repa: vzory sa načítajú, e-mail zachytí, git@ a ukážkový e-mail nie", () => {
  const p = loadPatterns();
  assert.ok(p.length >= 15);
  const hit = (s) => p.some((re) => re.test(s));
  assert.ok(hit(`napíš na adresa${"@"}domena.sk`));
  assert.ok(!hit("git clone git@github.com:ucet/repo.git"));
  assert.ok(!hit("user.email=t@example.org"));
  assert.ok(!hit("obyčajný text o agentoch, pravidlách a hookoch"));
});

test("skript: kód 1 s výpisom miesta na nálezu, kód 0 na čistom repe", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-"));
  try {
    const env = { ...process.env, PUBLIC_CHECK_ROOT: dir, PUBLIC_CHECK_LIST: list(dir, "zakazane") };
    const run = () => spawnSync("node", [join(LIB, "public_check.mjs")], { env, encoding: "utf8" });
    git(dir, "init", "-q");
    writeFileSync(join(dir, "a.md"), "čisté\n");
    git(dir, "add", "a.md");
    assert.equal(run().status, 0);
    writeFileSync(join(dir, "b.md"), "tu je zakazane slovo\n");
    git(dir, "add", "b.md");
    const r = run();
    assert.equal(r.status, 1);
    assert.match(r.stderr, /b\.md:1/);
    assert.doesNotMatch(r.stderr, /zakazane/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skript --commit-msg: zakázané meno autora chystaného commitu kód 1 bez výpisu mena, čisté kód 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-"));
  try {
    const env = { ...process.env, PUBLIC_CHECK_ROOT: dir, PUBLIC_CHECK_LIST: list(dir, "zakazane") };
    git(dir, "init", "-q");
    const msg = join(dir, "MSG");
    writeFileSync(msg, "čistá správa\n");
    const run = (name) => spawnSync("node", [join(LIB, "public_check.mjs"), "--commit-msg", msg], { env: { ...env, GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name, GIT_AUTHOR_EMAIL: "a@b.c", GIT_COMMITTER_EMAIL: "a@b.c" }, encoding: "utf8" });
    assert.equal(run("rola (server)").status, 0);
    const r = run("Zakazane (stroj)");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /chystaný commit: meno autora/);
    assert.match(r.stderr, /chystaný commit: meno committera/);
    assert.doesNotMatch(r.stderr, /Zakazane/);
    writeFileSync(msg, "správa so slovom zakazane\n");
    assert.match(run("rola (server)").stderr, /správa commitu:1/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("povolený odkaz prejde, to isté slovo inde nie", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-"));
  try {
    const f = join(dir, "vzory.txt");
    const b64 = (s) => Buffer.from(s).toString("base64");
    writeFileSync(f, [b64("zakazane"), "+" + b64("https://example\\.org/zakazane/repo\\b")].join("\n") + "\n");
    const p = loadPatterns(f);
    const a = loadAllowed(f);
    assert.equal(p.length, 1);
    assert.deepEqual(scanText("f", "viď https://example.org/zakazane/repo tu", p, a), []);
    assert.deepEqual(scanText("f", "viď https://example.org/zakazane/repo a zakazane", p, a), ["f:1"]);
    assert.deepEqual(scanText("f", "zakazane", p, a), ["f:1"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("pre-push: zakázaný text v commitnutom súbore sa odmietne, aj keď je pracovný strom opravený", () => {
  const dir = mkdtempSync(join(tmpdir(), "pc-"));
  try {
    const bare = join(dir, "remote.git");
    const w = join(dir, "work");
    execFileSync("git", ["init", "-q", "--bare", bare]);
    execFileSync("git", ["init", "-q", "-b", "main", w]);
    mkdirSync(join(w, "lib"));
    mkdirSync(join(w, ".githooks"));
    copyFileSync(join(LIB, "public_check.mjs"), join(w, "lib", "public_check.mjs"));
    copyFileSync(join(LIB, "..", ".githooks", "pre-push"), join(w, ".githooks", "pre-push"));
    chmodSync(join(w, ".githooks", "pre-push"), 0o755);
    // lib/ je neverzovaná, aby ju kontrola nečítala ako súbor repa
    writeFileSync(join(w, ".gitignore"), "lib/\n");
    const env = { ...process.env, PUBLIC_CHECK_LIST: list(dir, "zakazane") };
    // vzdialený repo je lokálny holý repo v tmp, nikdy origin
    const push = (ref) => spawnSync("git", ["-C", w, "-c", "core.hooksPath=.githooks", "push", bare, ref], { env, encoding: "utf8" });
    writeFileSync(join(w, "a.md"), "čisté\n");
    git(w, "add", ".gitignore", "a.md");
    git(w, "commit", "-qm", "základ");
    assert.equal(push("main:main").status, 0);
    // commit s nálezom, potom oprava len v pracovnom strome
    writeFileSync(join(w, "a.md"), "čisté\nriadok so zakazane slovom\n");
    git(w, "commit", "-qam", "zmena");
    const bad = git(w, "rev-parse", "--short=7", "HEAD").trim();
    writeFileSync(join(w, "a.md"), "čisté\nopravené\n");
    const r = push("main:main");
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`${bad}:a\\.md:2`));
    assert.doesNotMatch(r.stderr, /zakazane slovom/);
    // nová vetva: cesta `--not --remotes`
    const n = push("main:nova");
    assert.notEqual(n.status, 0);
    assert.match(n.stderr, new RegExp(`${bad}:a\\.md:2`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
