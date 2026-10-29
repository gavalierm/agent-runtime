// project_branch.mjs: commit na main v repe projektu mimo merge sa zamietne (úloha 616, D0182).
// Fixtúry sú dočasné repá v /tmp, cesta projektov ide cez opts.roots a AR_PROJECT_ROOTS,
// test nezávisí od /home/tasker-svc. Žiadny commit sa nerobí: vetva dostane ref súborom.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { branchViolation } from "./project_branch.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "project_branch.mjs");
const SHA = "0123456789abcdef0123456789abcdef01234567";
const base = realpathSync(mkdtempSync(join(tmpdir(), "pb-")));
const PROJECTS = join(base, "projekty");
const OUTSIDE = join(base, "mimo");

// Repo s vetvou `branch`, ktorá už má commit (ref súborom, bez commitu a hookov).
function mkRepo(dir, branch = "main", born = true) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", branch, dir], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } });
  if (born) {
    mkdirSync(join(dir, ".git", "refs", "heads"), { recursive: true });
    writeFileSync(join(dir, ".git", "refs", "heads", branch), SHA + "\n");
  }
  return dir;
}

const web = mkRepo(join(PROJECTS, "kubo", "kubo-web"));
const devRepo = mkRepo(join(PROJECTS, "kubo", "kubo-dev"), "dev");
const master = mkRepo(join(PROJECTS, "clientsite", "master"), "master");
const merging = mkRepo(join(PROJECTS, "kubo", "merging"));
writeFileSync(join(merging, ".git", "MERGE_HEAD"), SHA + "\n");
const fresh = mkRepo(join(PROJECTS, "kubo", "fresh"), "main", false);
const outside = mkRepo(join(OUTSIDE, "agentic-workflow"));
const opts = { roots: [PROJECTS] };
const v = (cmd, o = {}) => branchViolation(cmd, { ...opts, ...o });

test("commit na main v repe projektu sa zamietne: git -C, cwd, cd, za &&", () => {
  assert.deepEqual(v(`git -C ${web} commit -m 'x' -- a.txt`), { repo: web, branch: "main" });
  assert.deepEqual(v(`git commit -m x -- a.txt`, { cwd: web }), { repo: web, branch: "main" });
  assert.deepEqual(v(`cd ${web} && git add a.txt && git commit -m x -- a.txt`), { repo: web, branch: "main" });
  assert.deepEqual(v(`git add a && git -C ${web} commit -m x`), { repo: web, branch: "main" });
  assert.deepEqual(v(`git commit -m x`, { cwd: join(web, "src") }), { repo: web, branch: "main" });
});

test("pod runuser, sudo -u, sh -c, s -c user.name a s heredocom správy sa zamietne", () => {
  assert.ok(v(`runuser -u tasker-svc -- git -C ${web} commit -m x -- a.txt`));
  assert.ok(v(`sudo -u tasker-svc git -C ${web} commit -m x`));
  assert.ok(v(`sh -c 'git -C ${web} commit -m x'`));
  assert.ok(v(`git -c user.name='Dan (examplehost)' -C ${web} commit -m 'oprava'`));
  assert.ok(v(`git -C ${web} commit -F - <<'EOF'\nmerge dev\nEOF`));
});

test("master sa zamieta ako main", () => {
  assert.deepEqual(v(`git -C ${master} commit -m x`), { repo: master, branch: "master" });
});

test("commit na dev prejde", () => {
  assert.equal(v(`git -C ${devRepo} commit -m x -- a.txt`), null);
  assert.equal(v(`runuser -u tasker-svc -- git -C ${devRepo} commit -m x`), null);
});

test("commit na main s MERGE_HEAD (dokončenie merge) prejde", () => {
  assert.equal(v(`git -C ${merging} commit --no-edit`), null);
});

test("prvý commit nového repa (vetva ešte nemá commit) prejde", () => {
  assert.equal(v(`git -C ${fresh} commit -m init`), null);
});

test("repo mimo projektov (repo kódu, mozgu a agenta) prejde aj na main", () => {
  assert.equal(v(`git -C ${outside} commit -m x -- a`), null);
  assert.equal(v(`git commit -m x`, { cwd: outside }), null);
});

test("repo kódu a mozgu pod priečinkom projektov prejde aj na main", () => {
  const code = mkRepo(join(PROJECTS, "kod-klon"));
  const brain = mkRepo(join(PROJECTS, "mozog-klon"));
  assert.deepEqual(v(`git -C ${code} commit -m x`), { repo: code, branch: "main" });
  const old = { w: process.env.AGENT_WORKFLOW, b: process.env.AGENT_BRAIN_GLOBAL };
  process.env.AGENT_WORKFLOW = code;
  process.env.AGENT_BRAIN_GLOBAL = brain;
  try {
    assert.equal(v(`git -C ${code} commit -m x`), null);
    assert.equal(v(`git -C ${brain} commit -m x`), null);
    assert.deepEqual(v(`git -C ${web} commit -m x`), { repo: web, branch: "main" });
  } finally {
    for (const [k, val] of [["AGENT_WORKFLOW", old.w], ["AGENT_BRAIN_GLOBAL", old.b]]) {
      if (val === undefined) delete process.env[k];
      else process.env[k] = val;
    }
  }
});

test("git merge --no-ff dev na main prejde, iné podpríkazy tiež", () => {
  assert.equal(v(`git -C ${web} merge --no-ff dev`), null);
  assert.equal(v(`cd ${web} && git checkout main && git merge --no-ff dev && git push origin main dev`), null);
  assert.equal(v(`git -C ${web} status`), null);
  assert.equal(v(`git -C ${web} log --oneline`), null);
});

test("text commit v správe alebo echo nie je commit", () => {
  assert.equal(v(`echo 'git commit na main' && git -C ${web} status`), null);
  assert.equal(v(`tk comment 5 --body "spusti git -C ${web} commit -m x"`), null);
  assert.equal(v(`grep -n commit ${web}/README.md`), null);
});

test("worktree repa projektu na vetve u616 prejde, cieľ z premennej prejde", () => {
  const common = join(web, ".git");
  const wtGit = join(common, "worktrees", "u616");
  mkdirSync(wtGit, { recursive: true });
  writeFileSync(join(wtGit, "HEAD"), "ref: refs/heads/u616\n");
  writeFileSync(join(wtGit, "commondir"), "../..\n");
  writeFileSync(join(common, "refs", "heads", "u616"), SHA + "\n");
  const wt = join(PROJECTS, "kubo", "wt-u616");
  mkdirSync(wt, { recursive: true });
  writeFileSync(join(wt, ".git"), `gitdir: ${wtGit}\n`);
  assert.equal(v(`git -C ${wt} commit -m x`), null);
  assert.equal(v(`git -C $REPO commit -m x`, { cwd: null }), null);
});

test("predvolené cesty: bez roots je projekt len repo pod /home/<používateľ>/projekty/", () => {
  assert.equal(branchViolation(`git -C ${web} commit -m x`, { roots: null }), null);
});

// Hook ako proces: stdin JSON, cesty projektov z AR_PROJECT_ROOTS, sub-agent sa nespúšťa.
function run(command, cwd, env = { AR_PROJECT_ROOTS: PROJECTS }) {
  const out = execFileSync("node", [HOOK], { input: JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } }), env: { ...process.env, ...env } }).toString();
  return out ? JSON.parse(out).hookSpecificOutput : null;
}

test("hook: zamietnutie nesie dôvod D0182 a Správny postup s dev", () => {
  const r = run(`git commit -m x -- a.txt`, web);
  assert.equal(r.permissionDecision, "deny");
  assert.match(r.permissionDecisionReason, /Commit na main v repe projektu .*kubo-web mimo merge \(D0182\)/);
  assert.match(r.permissionDecisionReason, /Správny postup: git -C .*kubo-web checkout dev \(keď chýba: git checkout -b dev main\)/);
  assert.doesNotMatch(r.permissionDecisionReason, /checkout main/);
  assert.match(r.permissionDecisionReason, /dočasnom worktree/);
  assert.match(r.permissionDecisionReason, /dokonci\.sh koniec <úloha>/);
});

test("postup z hooku: merge v dočasnom worktree hook neblokuje (príkazy z textu postupu)", () => {
  const merge = "git -C /tmp/merge-1 merge --no-ff origin/dev && git -C /tmp/merge-1 push origin HEAD:main";
  assert.equal(v(merge), null);
  assert.equal(v(merge, { cwd: web }), null);
  assert.equal(v(`git worktree add /tmp/merge-1 origin/main && ${merge}`, { cwd: web }), null);
  assert.equal(run(merge, web), null);
  assert.equal(run(`git worktree add /tmp/merge-1 origin/main && ${merge}`, web), null);
});

test("hook: dev, merge, repo mimo projektov, iný nástroj a pokazený vstup prejdú", () => {
  assert.equal(run(`git commit -m x`, devRepo), null);
  assert.equal(run(`git merge --no-ff dev`, web), null);
  assert.equal(run(`git commit -m x`, outside), null);
  const other = execFileSync("node", [HOOK], { input: JSON.stringify({ tool_name: "Write", cwd: web, tool_input: { command: "git commit" } }), env: { ...process.env, AR_PROJECT_ROOTS: PROJECTS } }).toString();
  assert.equal(other, "");
  assert.equal(execFileSync("node", [HOOK], { input: "{nie json" }).toString(), "");
});
