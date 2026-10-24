// Test lib/public_check.mjs. Dočasné repo v tmp a vlastný zoznam vzorov, zoznam
// repa sa na nález mena nepoužíva (mená by sa dostali do testu). Spustenie:
// node --test lib/public_check.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadPatterns, scanCommits, scanRepo, scanText } from "./public_check.mjs";

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
