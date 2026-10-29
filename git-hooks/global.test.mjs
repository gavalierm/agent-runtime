// Test globálnych git hookov (git-hooks/global, úloha Taskera 565): repo bez
// vlastných hookov s globálnym core.hooksPath odmietne trailer Co-Authored-By,
// pustí čistý commit a lokálny .git/hooks/pre-commit, ktorý zlyhá, commit zastaví.
// HOME a GIT_CONFIG_GLOBAL ukazujú do tmp, globálny config roota sa nečíta ani nemení.
// Spustenie: node --test git-hooks/global.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS = join(REPO, "git-hooks", "global");
const EMAIL = readFileSync(join(REPO, "lib", "git_email.txt"), "utf8").trim();
const dir = mkdtempSync(join(tmpdir(), "ghooks-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const gitconfig = join(dir, "gitconfig");
writeFileSync(gitconfig, "");
const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_SYSTEM: "/dev/null", GIT_AUTHOR_NAME: "Dan (examplehost)", GIT_COMMITTER_NAME: "Dan (examplehost)", GIT_AUTHOR_EMAIL: EMAIL, GIT_COMMITTER_EMAIL: EMAIL };

const git = (cwd, ...args) => spawnSync("git", args, { cwd, env, encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "pipe"] });

const r = join(dir, "repo");
mkdirSync(r);
git(r, "init", "-q");
git(dir, "config", "--global", "core.hooksPath", HOOKS);
const commit = (msg) => {
  writeFileSync(join(r, "f"), `${Math.random()}\n`);
  git(r, "add", "f");
  const x = git(r, "commit", "-q", "-m", msg); return x;
};

test("globálny hooksPath je nastavený len v izolovanom configu", () => {
  assert.equal(git(r, "config", "--global", "--get", "core.hooksPath").stdout.trim(), HOOKS);
  assert.equal(git(r, "config", "--get", "core.hooksPath").stdout.trim(), HOOKS);
});

test("commit s Co-Authored-By v repe bez hookov sa odmietne", () => {
  const c = commit("Oprava\n\nCo-Authored-By: Claude <noreply@example.com>");
  assert.notEqual(c.status, 0, c.stdout + c.stderr);
  assert.match(c.stderr, /Co-Authored-By/);
  assert.notEqual(git(r, "rev-parse", "-q", "--verify", "HEAD").status, 0, "commit nemal vzniknúť");
});

test("čistý commit so správnym menom prejde", () => {
  const c = commit("Oprava\n\nDosah lokálny.");
  assert.equal(c.status, 0, c.stdout + c.stderr);
});

test("cudzie meno autora sa odmietne", () => {
  writeFileSync(join(r, "f"), "x\n");
  git(r, "add", "f");
  const c = spawnSync("git", ["commit", "-q", "-m", "Oprava"], { cwd: r, env: { ...env, GIT_AUTHOR_NAME: "root" }, encoding: "utf8" });
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /meno autora/);
});

test("lokálny pre-commit, ktorý zlyhá, commit zastaví, ktorý prejde, ho nechá", () => {
  const hook = join(r, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho lokalny-pre-commit >&2\nexit 1\n");
  chmodSync(hook, 0o755);
  let c = commit("Oprava dva");
  assert.notEqual(c.status, 0);
  assert.match(c.stderr, /lokalny-pre-commit/);
  writeFileSync(hook, "#!/bin/sh\nexit 0\n");
  c = commit("Oprava tri");
  assert.equal(c.status, 0, c.stdout + c.stderr);
});

test("lokálny commit-msg sa spustí až po kontrole globálnej a dostane správu", () => {
  const hook = join(r, ".git", "hooks", "commit-msg");
  writeFileSync(hook, `#!/bin/sh\ncp "$1" ${join(dir, "msg")}\ngrep -q ZAKAZ "$1" && exit 1\nexit 0\n`);
  chmodSync(hook, 0o755);
  let c = commit("Oprava ZAKAZ");
  assert.notEqual(c.status, 0);
  c = commit("Oprava štyri");
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.match(readFileSync(join(dir, "msg"), "utf8"), /Oprava štyri/);
});

test("lokálny pre-push dostane argumenty a stdin", () => {
  const hook = join(r, ".git", "hooks", "pre-push");
  writeFileSync(hook, `#!/bin/sh\necho "$1" > ${join(dir, "push")}\ncat >> ${join(dir, "push")}\n`);
  chmodSync(hook, 0o755);
  const remote = join(dir, "remote.git");
  git(dir, "init", "-q", "--bare", remote);
  const p = git(r, "push", "-q", remote, "HEAD:refs/heads/x");
  assert.equal(p.status, 0, p.stderr);
  const out = readFileSync(join(dir, "push"), "utf8");
  assert.ok(out.includes(remote), out);
  assert.match(out, /refs\/heads\/x/);
});

// enable_repo_hooks.sh: výber klonov pod dočasným koreňom, nič živé.
test("enable_repo_hooks zapne hooky len v klone z repo_authors.txt bez vlastného hooksPath", () => {
  const root = join(dir, "home");
  const mk = (rel, url, extra = []) => {
    const p = join(root, rel);
    mkdirSync(p, { recursive: true });
    git(p, "init", "-q");
    if (url) git(p, "remote", "add", "origin", url);
    for (const [k, v] of extra) git(p, "config", "--local", k, v);
    return p;
  };
  const tasker = mk("projekty/tasker/tasker", "git@github.com:example-org/tasker.git");
  const vlastny = mk("projekty/tasker/iny", "git@github.com:example-org/tasker.git", [["core.hooksPath", "/moje"]]);
  const projekt = mk("projekty/vasdom/projekt", "git@github.com:example-org/vasdom.git", [["user.name", "Tasker tasker-svc"]]);
  const bezorigin = mk("projekty/x/y", null);
  const s = spawnSync("bash", [join(REPO, "git-hooks", "enable_repo_hooks.sh"), root, HOOKS], { env, encoding: "utf8" });
  assert.equal(s.status, 0, s.stderr);
  const hp = (p) => git(p, "config", "--local", "--get", "core.hooksPath").stdout.trim();
  assert.equal(hp(tasker), HOOKS);
  assert.equal(hp(vlastny), "/moje");
  assert.equal(hp(projekt), "");
  assert.equal(hp(bezorigin), "");
  // projekt s menom "Tasker tasker-svc" bez globálneho hooksPath (ako tasker-svc) nie je blokovaný
  writeFileSync(join(projekt, "f"), "x\n");
  git(projekt, "add", "f");
  const prazdny = join(dir, "bez-configu");
  writeFileSync(prazdny, "");
  const c = spawnSync("git", ["commit", "-q", "-m", "x"], { cwd: projekt, env: { ...env, GIT_CONFIG_GLOBAL: prazdny, GIT_AUTHOR_NAME: "Tasker tasker-svc" }, encoding: "utf8" });
  assert.equal(c.status, 0, c.stderr);
});
