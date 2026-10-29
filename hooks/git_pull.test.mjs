// git_pull.mjs: zamietne git pull v príkaze Bash, text o pulle pustí.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { gitPullIn } from "./git_pull.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "git_pull.mjs");

// Hook sa púšťa len vstupom na stdin, git sa nespúšťa nikdy.
function run(command, tool_name = "Bash") {
  const out = execFileSync("node", [HOOK], { input: JSON.stringify({ tool_name, tool_input: { command } }) }).toString();
  return out ? JSON.parse(out).hookSpecificOutput : null;
}

test("replay 24. 10. 2026: pull v /root/teo sa zamietne s náhradou fetch a rebase", () => {
  const cmd = 'cd /root/teo && GIT_SSH_COMMAND="ssh -i x" git pull --rebase=false -q 2>/dev/null';
  assert.ok(gitPullIn(cmd));
  const r = run(cmd);
  assert.equal(r.permissionDecision, "deny");
  assert.match(r.permissionDecisionReason, /Správny postup: `git fetch origin && git rebase origin\/main`/);
});

test("pull s voľbami, za oddeľovačmi a v obaloch zamietne", () => {
  for (const cmd of [
    "git pull",
    "git pull --rebase origin main",
    "git pull -q",
    "git -C /root/x pull",
    "git -C /root/x -c pull.rebase=true pull",
    "git --no-pager pull",
    "git -c core.sshCommand='ssh -i k' pull",
    "git fetch && git pull",
    "git status; git pull",
    "git status | cat; git pull",
    "ls\ngit pull",
    "(cd /root/x && git pull)",
    "x=$(git pull)",
    "if cd /root/x; then git pull; fi",
    "GIT_TERMINAL_PROMPT=0 git pull",
    "env GIT_TERMINAL_PROMPT=0 git pull",
    "time git pull",
    "timeout 30 git pull",
    "/usr/bin/git pull",
    "sh -c 'git pull'",
    'bash -lc "cd /root/x && git pull"',
    "runuser -u tasker-svc -- git pull",
    "sudo -u tasker-svc git -C /x pull",
    "su - tasker-svc -c 'git pull'",
    "echo x | xargs git pull",
    "echo x | xargs -n1 git -C /y pull",
    'git "pull"',
    "cat <<EOF\ntext\nEOF\ngit pull",
  ]) assert.ok(gitPullIn(cmd), cmd);
});

test("git pull v texte nezamietne", () => {
  for (const cmd of [
    "echo git pull",
    'echo "nepouzivaj git pull"',
    "echo 'git pull je zakazany'",
    'grep -rn "git pull" /root/agentic-workflow',
    "grep -n git\\ pull README.md",
    'git commit -m "zakaz git pull v hooku" -- a',
    "git commit -m 'git pull' -- a",
    'git commit -m x -m "Chyba: git pull v /root/teo" -- a',
    "git log --grep='git pull' --oneline",
    "tasker comment 5 --body 'agent spustil git pull'",
    "printf '%s\\n' \"git pull\" | ask_agent.sh boris x",
    "ask_agent.sh boris x <<'EOF'\nNespustaj git pull.\nEOF",
    "cat > a.md <<EOF\ngit pull\nEOF",
    "ssh examplehost 'cd /x && git pull'",
    "cat hooks/git_pull.mjs",
    "echo git pull | cat",
    "ls /root/pull",
    "git fetch origin && git rebase origin/main",
    "git push origin main",
    "git stash list",
    "git remote add pull url",
    "git log pull",
    "git status",
    "ls",
    "",
  ]) assert.equal(gitPullIn(cmd), false, cmd);
});

test("hook pustí iný nástroj než Bash a bežný príkaz", () => {
  assert.equal(run("git pull", "Write"), null);
  assert.equal(run("git fetch origin && git rebase origin/main"), null);
  assert.equal(run('echo "git pull"'), null);
  assert.equal(execFileSync("node", [HOOK], { input: "" }).toString(), "");
});
