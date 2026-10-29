// shared_git.mjs: git príkazy, ktoré zahodia cudzie súbory (stash, reset --hard ...)
// a obchádzanie hookov repa (core.hooksPath, --no-verify, commit -n). Test púšťa
// hook foreign_git.mjs (server) len vstupom na stdin, git sa nespúšťa nikdy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const HOOK = join(DIR, "foreign_git.mjs");

// Vráti hookSpecificOutput z hooku foreign_git.mjs pre príkaz Bash, null keď mlčí.
function run(command) {
  const out = execFileSync("node", [HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }) }).toString();
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
    "git commit -am x",
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
