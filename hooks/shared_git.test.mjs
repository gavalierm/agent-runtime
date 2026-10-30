// shared_git.mjs: git príkazy, ktoré zahodia cudzie súbory (stash, reset --hard ...),
// obchádzanie hookov repa (core.hooksPath, --no-verify, commit -n) a plošné
// `git add` (-A, --all, .). Test púšťa
// hook foreign_git.mjs (server) len vstupom na stdin, git sa nespúšťa nikdy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const HOOK = join(DIR, "foreign_git.mjs");

// Vráti hookSpecificOutput z hooku foreign_git.mjs pre príkaz Bash, null keď mlčí.
function run(command, cwd) {
  const input = { tool_name: "Bash", tool_input: { command }, ...(cwd ? { cwd } : {}) };
  const out = execFileSync("node", [HOOK], { input: JSON.stringify(input) }).toString();
  return out ? JSON.parse(out).hookSpecificOutput : null;
}
const denied = (command) => run(command)?.permissionDecision === "deny";

test("stash, reset --hard a --autostash ostáva zamietnuté", () => {
  for (const c of ["git stash", "git reset --hard origin/main", "git rebase --autostash origin/main", "git checkout -- f", "git clean -fd"]) {
    const r = run(c);
    assert.equal(r?.permissionDecision, "deny", c);
    assert.match(r.permissionDecisionReason, /Správny postup:/, c);
  }
  for (const c of ["git stash list", "git status", 'git commit -m "stash"']) assert.ok(!denied(c), c);
});

test("git -c core.hooksPath zamietne s riadkom Správny postup", () => {
  const r = run("git -c core.hooksPath=.git/hooks commit -m x -- f");
  assert.equal(r?.permissionDecision, "deny");
  assert.match(r.permissionDecisionReason, /hooksPath/);
  assert.match(r.permissionDecisionReason, /Správny postup:.*hooky repa musia bežať/);
  for (const c of [
    "git -c core.hookspath=/dev/null commit -m x",
    "git -c CORE.HOOKSPATH=/dev/null commit -m x",
    "git -c 'core.hooksPath=/dev/null' commit -m x",
    'git -c "core.hooksPath=/dev/null" push',
    "git -C /root/x -c core.hooksPath=/tmp/h commit -m x",
    "git --config-env=core.hooksPath=H commit -m x",
    "git --config-env core.hooksPath=H commit -m x",
    "git clone --config core.hooksPath=/x u d",
    "git clone --config=core.hooksPath=/x u d",
    "cd /root/x && git -c core.hooksPath=/x commit -m x",
    "ls; git -c core.hooksPath=/x commit -m x",
    "sh -c 'git -c core.hooksPath=/x commit -m x'",
    "runuser -u tasker-svc -- git -c core.hooksPath=/x commit -m x",
    "sudo -u tasker-svc git -c core.hooksPath=/x commit -m x",
    "env X=1 git -c core.hooksPath=/x commit -m x",
  ]) assert.ok(denied(c), c);
});

test("git commit --no-verify a -n zamietne", () => {
  const r = run("git commit --no-verify -m x");
  assert.equal(r?.permissionDecision, "deny");
  assert.match(r.permissionDecisionReason, /--no-verify/);
  assert.match(r.permissionDecisionReason, /Správny postup:.*hooky repa musia bežať/);
  for (const c of [
    'git commit -n -m "x"',
    'git commit -m "x" -n',
    "git commit -nm x",
    "git commit -anm x",
    "git commit -m x --no-verify -- f",
    "git commit --amend --no-verify",
    "git -C /root/x commit --no-verify -m x",
    "git push --no-verify",
    "cd /root/x && git commit -n -m x",
    "sh -c 'git commit -n -m x'",
    "runuser -u tasker-svc -- git commit -n -m x",
    "sudo -u tasker-svc git commit --no-verify -m x",
    "X=1 git commit -n -m x",
  ]) assert.ok(denied(c), c);
});

test("bežný commit, text a iné voľby pustí", () => {
  for (const c of [
    'git commit -m "x" -- f',
    "git commit --amend --no-edit",
    "git commit -m x --author='A <a@b>'",
    "git commit -uno -m x",
    "git commit -m -n",
    "git commit -F msg.txt -- f",
    "git config core.hooksPath .githooks",
    "git config --global core.hooksPath /opt/agentic-workflow/git-hooks/global",
    "git -c user.name=x commit -m x",
    "git -c color.ui=never log",
    "git log -n 5",
    "git push -n origin main",
    "git merge -n dev",
    'git commit -m "zákaz --no-verify a git -c core.hooksPath=x"',
    'git commit -m "oprava -n"',
    "echo 'git commit --no-verify'",
    "echo git commit --no-verify",
    "grep -rn 'core.hooksPath' .",
    "cat <<'EOF'\ngit -c core.hooksPath=/x commit -n\nEOF",
    "# git commit --no-verify",
  ]) assert.ok(!denied(c), c);
});

test("hooksBypass je dostupný pre topic.mjs (Mac)", async () => {
  const { hooksBypass } = await import("./shared_git.mjs");
  assert.ok(hooksBypass("git commit -n -m x"));
  assert.ok(hooksBypass("git -c core.hooksPath=/x commit"));
  assert.equal(hooksBypass('git commit -m "x"'), null);
});

test("git add -A, --all a . zamietne s odkazom na commit so zoznamom súborov", () => {
  const r = run("git add -A");
  assert.equal(r?.permissionDecision, "deny");
  assert.match(r.permissionDecisionReason, /global §6/);
  assert.match(r.permissionDecisionReason, /git commit -m "<správa>" -- <zoznam vlastných súborov>/);
  assert.match(r.permissionDecisionReason, /Správny postup:/);
  for (const c of [
    "git add -A",
    "git add --all",
    "git add .",
    "git add ./",
    "git add -Av",
    "git add -vA",
    "git add -A .",
    "git add -A src/x.mjs",
    "git add -f .",
    "git add -- .",
    "git add 'f.txt' \".\"",
    "git -C /root/x add -A",
    "git -c user.name=x add .",
    "git -C /root/x -c core.quotepath=off add --all",
    "git --no-pager add -A",
    "cd /root/x && git add -A",
    "ls; git add .",
    "git status | git add -A",
    "sh -c 'git add -A'",
    "runuser -u tasker-svc -- git add -A",
    "sudo -u tasker-svc git add .",
    "env X=1 git add -A",
    "X=1 git add --all",
    "git add -A && git commit -m x",
    "echo x\ngit add -A",
  ]) assert.ok(denied(c), c);
});

test("git add konkrétneho súboru a text o git add -A pustí", () => {
  for (const c of [
    "git add f.txt",
    "git add hooks/shared_git.mjs hooks/topic.mjs",
    "git add -- f.txt",
    "git add -f f.txt",
    "git add -N f.txt",
    "git add -p f.txt",
    "git add .gitignore",
    "git add ./f.txt",
    "git add ../f.txt",
    "git add --chmod=+x bin/x.sh",
    "git add --pathspec-from-file list.txt",
    "git -C /root/x add f.txt",
    "git -C . add f.txt",
    "git -c user.name=x add f.txt",
    "git add -n f.txt",
    "git commit -m x -- f",
    "git status -A",
    "git log --all",
    "git log -A",
    "git diff .",
    "git status .",
    "git stash list",
    "git remote add origin .",
    "git worktree add -b u1 ../x origin/main",
    "git submodule add . x",
    'git commit -m "zákaz git add -A, git add --all a git add ."',
    "echo 'git add -A'",
    "echo git add -A",
    "grep -rn 'git add -A' .",
    "grep -rn 'git add .' hooks",
    "cat <<'EOF'\ngit add -A\ngit add .\nEOF",
    "# git add -A",
  ]) assert.ok(!denied(c), c);
});

test("replay 30. 10. 2026: git add -A v klone agenta, hook v tmp cwd", () => {
  const cwd = mkdtempSync(join(tmpdir(), "u694-"));
  try {
    const r = run("cd /root/agent/.scratch/sablona/repo && git add -A", cwd);
    assert.equal(r?.permissionDecision, "deny");
    assert.match(r.permissionDecisionReason, /git add -A/);
    assert.match(r.permissionDecisionReason, /git commit -m/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("addAll je dostupný pre topic.mjs (Mac)", async () => {
  const { addAll } = await import("./shared_git.mjs");
  assert.equal(addAll("git add -A"), "-A");
  assert.equal(addAll("git add --all"), "--all");
  assert.equal(addAll("git add ."), ".");
  assert.equal(addAll("git add f.txt"), null);
  assert.equal(addAll('git commit -m "git add -A"'), null);
});

test("addAll: git commit -a, -am, --all (úloha 694, kolo 2)", async () => {
  const { addAll } = await import("./shared_git.mjs");
  for (const c of ["git commit -a -m x", "git commit -am x", "git commit --all -m x", "git commit -vam x", "git -C /x commit -a", "cd x && git commit -a -m x"])
    assert.equal(addAll(c), "commit -a", c);
  for (const c of ["git commit -m x -- súbor", "git commit --amend", "git commit --amend --no-edit", "git commit -S -m x",
    'git commit -m "git commit -a"', "git commit -m x -- -a", "git commit -m a", "git commit -F a -m x", "git commit -S -m x -- f"])
    assert.equal(addAll(c), null, c);
  assert.equal(addAll("git commit -S -a"), "commit -a");
});

test("addAll: git add -u, --update (úloha 694, kolo 2)", async () => {
  const { addAll } = await import("./shared_git.mjs");
  for (const c of ["git add -u", "git add --update", "git add -fu", "git add -vu", "git -C /x add -u"]) assert.equal(addAll(c), "-u", c);
  assert.equal(addAll("git add -uA"), "-A");
});

test("addAll: pathspec :/, :(top), *, .., ../ (úloha 694, kolo 2)", async () => {
  const { addAll } = await import("./shared_git.mjs");
  assert.equal(addAll("git add :/"), ":/");
  assert.equal(addAll('git add ":/"'), ":/");
  assert.equal(addAll('git add ":(top)"'), ":(top)");
  assert.equal(addAll("git add ':(top)'"), ":(top)");
  assert.equal(addAll("git add *"), "*");
  assert.equal(addAll('git add "*"'), "*");
  assert.equal(addAll("git add .."), "..");
  assert.equal(addAll("git add ../"), "../");
  assert.equal(addAll("git add ../.."), "../..");
  assert.equal(addAll("git add ../../"), "../../");
  assert.equal(addAll("git add ./"), ".");
});

test("addAll: git stage je alias git add (úloha 694, kolo 2)", async () => {
  const { addAll } = await import("./shared_git.mjs");
  assert.equal(addAll("git stage ."), ".");
  assert.equal(addAll("git stage -A"), "-A");
  assert.equal(addAll("git stage -u"), "-u");
  assert.equal(addAll("git stage f.txt"), null);
});

test("addAll: ./*, :/*, :(top)* a magic pathspec so slovom top sú plošné (úloha 694, kolo 3)", async () => {
  const { addAll } = await import("./shared_git.mjs");
  for (const [c, r] of [
    ["git add ./*", "./*"], ["git add './*'", "./*"], ['git add "./*"', "./*"], ["git add .//*", ".//*"], ["git add ./**", "./**"],
    ["git add ':/*'", ":/*"], ["git add :/*", ":/*"], ["git add ':/**'", ":/**"], ["git add ':(top)*'", ":(top)*"],
    ["git add ':(top)/'", ":(top)/"], ["git add ':(top,glob)**'", ":(top,glob)**"], ["git add ':(glob,top)'", ":(glob,top)"],
    ["git add '../*'", "../*"], ["git add ./..", "./.."], ["git stage ./*", "./*"], ["git -C /x add ':(top)*'", ":(top)*"],
  ]) assert.equal(addAll(c), r, c);
});

test("addAll: konkrétny súbor a úzky vzor prejdú (úloha 694, kolo 3)", async () => {
  const { addAll } = await import("./shared_git.mjs");
  for (const c of ["git add ':(top)memory/a.md'", "git add :/memory/a.md", "git add ./memory/*.md", "git add ../x.txt", "git add ':(glob)*.md'",
    "git add ':(top)memory/*'", "git add ':(top)*.md'", "git add ./a.md", "git add ../memory/*.md"])
    assert.equal(addAll(c), null, c);
});

test("addAll: dovolené tvary prejdú (úloha 694, kolo 2)", async () => {
  const { addAll } = await import("./shared_git.mjs");
  for (const c of ["git add memory/a.md", 'git add "a b.txt"', "git add .gitignore", "git add .claude/x", "git add ./memory/a.md",
    "git add -p", "git add -p a", "git add -N a", "git add --chmod=+x a.sh", "git add --chmod +x a.sh", "git add *.md", "git add ../x.txt",
    "git add :/memory/a.md", "git add ':(top)memory/a.md'", "git add ':(glob)*.md'", "git add a b && git commit -m x",
    "echo 'git add -A'", "echo 'git commit -a -m x'", "grep -n 'git add -A' README.md", "cat <<E\ngit add -A\ngit commit -a\nE",
    'git commit -m "git add -u" -- f', "git status --short", "git ls-files -mo | xargs git add"])
    assert.equal(addAll(c), null, c);
});
