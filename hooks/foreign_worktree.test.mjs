// foreign_worktree.mjs: cudzí worktree nemení HEAD, vlastný a text pustí, po worktree add sa zapíše agent-owner.
// Všetko v dočasnom priečinku (repo, .worktrees, domovy agentov), nič na živých cestách.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "foreign_worktree.mjs");
let tmp, repo, wt, homes, base;

const git = (cwd, ...a) => execFileSync("git", ["-C", cwd, ...a], { env: { ...process.env, HOME: tmp }, stdio: ["ignore", "pipe", "pipe"] }).toString();
const commitAs = (cwd, author) => git(cwd, "-c", `user.name=${author}`, "-c", "user.email=a@b.c", "commit", "--allow-empty", "-q", "-m", "x");

function env(agent) {
  const e = { PATH: process.env.PATH, HOME: tmp, FOREIGN_WORKTREE_BASE: base, AGENT_HOMES_DIR: homes };
  if (agent) e.AGENT_NAME = agent;
  return e;
}
function run(agent, command, event = "PreToolUse", cwd = tmp) {
  const out = execFileSync("node", [HOOK], { env: env(agent), input: JSON.stringify({ tool_name: "Bash", hook_event_name: event, cwd, tool_input: { command } }) }).toString();
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : "";
}

before(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "fwt-")));
  repo = join(tmp, "repo");
  base = join(tmp, ".worktrees");
  homes = join(tmp, "homes");
  for (const a of ["alfa", "beta", "gama"]) {
    mkdirSync(join(homes, a), { recursive: true });
    writeFileSync(join(homes, a, "PERSONA.md"), `# ${a[0].toUpperCase()}${a.slice(1)}\n`);
  }
  mkdirSync(repo);
  git(repo, "init", "-q", "-b", "main");
  commitAs(repo, "Beta (stroj)");
  mkdirSync(base);
  wt = join(base, "agentic-workflow-u720");
  git(repo, "worktree", "add", "-q", "-b", "u720", wt);
  git(repo, "worktree", "add", "-q", "-b", "r720", join(base, "alfa-review-u720"));
  git(repo, "worktree", "add", "-q", "-b", "s720", join(base, "spravca-u720"));
  commitAs(join(base, "spravca-u720"), "spravca-agentov (server)");
});
after(() => rmSync(tmp, { recursive: true, force: true }));

test("replay: alfa robí checkout v cudzom worktree -> zamietnuté, beta -> pustené", () => {
  assert.equal(run("alfa", `cd ${wt} && git checkout cfb8af4`), "deny");
  assert.equal(run("beta", `cd ${wt} && git checkout cfb8af4`), "");
});

test("git -C, switch, reset (aj --hard, --soft) a runuser sa posudzujú rovnako", () => {
  assert.equal(run("alfa", `git -C ${wt} switch u720`), "deny");
  assert.equal(run("alfa", `git -C ${wt} reset --soft HEAD~1`), "deny");
  assert.equal(run("alfa", `cd ${wt} && git reset`), "deny");
  assert.equal(run("alfa", `runuser -u tasker-x -- git -C ${wt} checkout x`), "deny");
  assert.equal(run("alfa", `sudo -u tasker-x git -C ${wt} checkout x`), "deny");
  assert.equal(run("alfa", `sh -c 'cd ${wt} && git checkout x'`), "deny");
});

test("cwd z hooku sa použije, keď príkaz cieľ neurčí; cd mimo worktree ho zruší", () => {
  assert.equal(run("alfa", "git checkout x", "PreToolUse", wt), "deny");
  assert.equal(run("alfa", `cd ${tmp} && git checkout x`, "PreToolUse", wt), "");
  assert.equal(run("alfa", `git -C ${tmp} checkout x`, "PreToolUse", wt), "");
});

test("vlastný worktree alfa-review-u720 pustí, cudzia predpona zamietne", () => {
  assert.equal(run("alfa", `git -C ${join(base, "alfa-review-u720")} checkout r720`), "");
  assert.equal(run("beta", `git -C ${join(base, "alfa-review-u720")} checkout r720`), "deny");
});

test("podadresár worktree sa počíta do koreňa, mimo .worktrees hook nerobí nič", () => {
  mkdirSync(join(wt, "sub"), { recursive: true });
  assert.equal(run("alfa", `cd ${wt}/sub && git checkout x`), "deny");
  assert.equal(run("alfa", `git -C ${repo} checkout main`), "");
});

test("text v úvodzovkách a heredocu, čítanie a iné podpríkazy pustí", () => {
  assert.equal(run("alfa", 'echo "git checkout x"'), "");
  assert.equal(run("alfa", `cd ${wt} && echo 'git checkout x'`), "");
  assert.equal(run("alfa", `cd ${wt} && cat <<EOF\ngit checkout x\nEOF`), "");
  assert.equal(run("alfa", `git -C ${wt} log --oneline`), "");
  assert.equal(run("alfa", `git -C ${wt} diff`), "");
});

test("autor bez agenta (spravca-agentov) je neznámy vlastník, hook zamietne; neznámy agent pustí", () => {
  assert.match(run("alfa", `git -C ${join(base, "spravca-u720")} checkout cfb8af4`), /deny/);
  assert.match(run("beta", `git -C ${join(base, "spravca-u720")} reset --hard`), /deny/);
  assert.equal(run("", `git -C ${wt} checkout x`), "");
  assert.equal(run("niktoprazdny", `git -C ${wt} checkout x`), "");
});

test("agent-owner má prednosť pred autorom a predponou", () => {
  const admin = git(wt, "rev-parse", "--absolute-git-dir").trim();
  writeFileSync(join(admin, "agent-owner"), "alfa\n");
  try {
    assert.equal(run("alfa", `git -C ${wt} checkout x`), "");
    assert.equal(run("beta", `git -C ${wt} checkout x`), "deny");
  } finally {
    rmSync(join(admin, "agent-owner"));
  }
});

test("PostToolUse po git worktree add zapíše agent-owner nového worktree", () => {
  const nw = join(base, "alfa-review-u999");
  git(repo, "worktree", "add", "-q", "-b", "r999", nw);
  assert.equal(run("alfa", `git -C ${repo} worktree add -b r999 ${nw} origin/x`, "PostToolUse"), "");
  const admin = git(nw, "rev-parse", "--absolute-git-dir").trim();
  assert.equal(readFileSync(join(admin, "agent-owner"), "utf8").trim(), "alfa");
  // relatívna cesta od cd
  const nw2 = join(base, "gama-x");
  git(repo, "worktree", "add", "-q", "-b", "x2", nw2);
  run("gama", `cd ${base} && git -C ${repo} worktree add gama-x`, "PostToolUse");
  assert.equal(existsSync(join(git(nw2, "rev-parse", "--absolute-git-dir").trim(), "agent-owner")), false, "relatívna cesta sa berie od -C repo, tam gama-x nie je");
  run("gama", `cd ${base} && git worktree add gama-x`, "PostToolUse");
  assert.equal(readFileSync(join(git(nw2, "rev-parse", "--absolute-git-dir").trim(), "agent-owner"), "utf8").trim(), "gama");
});

test("PostToolUse bez git worktree add alebo bez agenta nič nezapíše", () => {
  const nw = join(base, "alfa-review-u998");
  git(repo, "worktree", "add", "-q", "-b", "r998", nw);
  const admin = git(nw, "rev-parse", "--absolute-git-dir").trim();
  run("alfa", `echo git worktree add ${nw}`, "PostToolUse");
  run("", `git worktree add ${nw}`, "PostToolUse");
  assert.equal(existsSync(join(admin, "agent-owner")), false);
});
