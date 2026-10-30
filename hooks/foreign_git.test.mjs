// foreign_git.mjs: zamietne obchádzanie safe.directory, pustí git pod
// vlastníkom klonu, čítanie a text v heredocu.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, chownSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { foreignGitReason } from "./foreign_git.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "foreign_git.mjs");

function run(tool_input) {
  const out = execFileSync("node", [HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input }) }).toString();
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : "";
}

test("príkazy zo záznamu 20. 10. 2026 zamietne", () => {
  assert.ok(foreignGitReason("git -c safe.directory=* fetch"));
  assert.ok(foreignGitReason("cd /home/tasker-svc/projekty/x && git -c safe.directory=* status"));
  assert.ok(foreignGitReason("git -c safe.directory=* log --oneline"));
  assert.equal(run({ command: "git -c safe.directory=* fetch" }), "deny");
});

test("ďalšie varianty zamietne", () => {
  assert.ok(foreignGitReason("git -c 'safe.directory=*' status"));
  assert.ok(foreignGitReason('git -c "safe.directory=/x" status'));
  assert.ok(foreignGitReason("git -C /x -c safe.directory=/x pull"));
  assert.ok(foreignGitReason("git config --global --add safe.directory '*'"));
  assert.ok(foreignGitReason("git config --system safe.directory /x"));
  assert.ok(foreignGitReason("git config safe.directory /x"));
  assert.ok(foreignGitReason("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0='*' git status"));
  assert.ok(foreignGitReason("export GIT_CONFIG_KEY_0=safe.directory"));
  assert.ok(foreignGitReason("GIT_CONFIG_PARAMETERS=\"'safe.directory=*'\" git log"));
  assert.ok(foreignGitReason("git --config-env=safe.directory=V status"));
  assert.ok(foreignGitReason("sh -c 'git -c safe.directory=* status'"));
});

test("git pod vlastníkom a bežný git pustí", () => {
  assert.equal(foreignGitReason("runuser -u tasker-svc -- git pull"), null);
  assert.equal(foreignGitReason("git status"), null);
  assert.equal(foreignGitReason("git -c user.name=x commit -m fix"), null);
  assert.equal(foreignGitReason("git config user.name"), null);
  assert.equal(run({ command: "git status" }), "");
});

test("čítanie slova safe.directory pustí", () => {
  assert.equal(foreignGitReason("grep safe.directory súbor"), null);
  assert.equal(foreignGitReason("git config --list; grep safe.directory súbor"), null);
  assert.equal(foreignGitReason("git log | grep -n safe.directory"), null);
  assert.equal(foreignGitReason("echo safe.directory"), null);
});

test("text v heredocu pustí, príkaz za ním posúdi", () => {
  assert.equal(foreignGitReason("ask_agent.sh boris x <<'EOF'\nNepoužívaj git -c safe.directory=*.\nEOF"), null);
  assert.ok(foreignGitReason("cat <<EOF\ntext\nEOF\ngit -c safe.directory=* status"));
});

test("text v úvodzovkách pustí, argument gitu v úvodzovkách nie", () => {
  assert.equal(foreignGitReason(`printf '%s\\n' "hook zamietne git -c safe.directory=*; nasadené" | ask_agent.sh boris x; git commit -q -m "Chyba: git -c safe.directory=* v klone" -- a`), null);
  assert.ok(foreignGitReason(`git -c "safe.directory=/cesta s medzerou" status`));
  assert.ok(foreignGitReason(`git -c 'safe.directory=*' status`));
  assert.ok(foreignGitReason(`GIT_CONFIG_PARAMETERS="'safe.directory=*'" git status`));
});

// Druhá kontrola: clone a init v strome cudzieho používateľa. Vlastník ide
// cez fake, test nič nezapisuje ani nespúšťa git.
const fake = (map) => (p) => {
  for (const [k, uid] of Object.entries(map)) if (p === k || p.startsWith(k + "/")) return { uid };
  throw new Error("ENOENT");
};
const OWN = fake({ "/home/tasker-svc": 1001, "/root": 0, "/tmp": 0 });

test("git clone a init v cudzom strome zamietne", () => {
  assert.ok(foreignGitReason("cd /home/tasker-svc/projekty/x && git clone git@github.com:a/b.git", { stat: OWN }));
  assert.ok(foreignGitReason("git clone url /home/tasker-svc/p/b", { stat: OWN }));
  assert.ok(foreignGitReason("git -C /home/tasker-svc/p init nove", { stat: OWN }));
  assert.ok(foreignGitReason("git init", { cwd: "/home/tasker-svc/p", stat: OWN }));
  assert.ok(foreignGitReason("git clone --depth 1 -b main url", { cwd: "/home/tasker-svc/p", stat: OWN }));
  assert.ok(foreignGitReason("git -C /home/tasker-svc/p clone url", { cwd: "/root", stat: OWN }));
});

test("git clone a init pod vlastníkom, v rootovom strome a pri neurčitej ceste pustí", () => {
  assert.equal(foreignGitReason("runuser -u tasker-svc -- git clone url /home/tasker-svc/p/b", { stat: OWN }), null);
  assert.equal(foreignGitReason("sudo -u tasker-svc git init /home/tasker-svc/p", { stat: OWN }), null);
  assert.equal(foreignGitReason("git clone url /root/x", { stat: OWN }), null);
  assert.equal(foreignGitReason("git clone url /tmp/x", { stat: fake({ "/tmp": 0 }) }), null);
  assert.equal(foreignGitReason('git clone url "$D"', { stat: OWN }), null);
  assert.equal(foreignGitReason("cd $D && git clone url", { stat: OWN }), null);
  assert.equal(foreignGitReason("git clone url", { stat: OWN }), null);
  assert.equal(foreignGitReason("ls", { cwd: "/home/tasker-svc/p", stat: OWN }), null);
});

// Tretia kontrola: priamy git v klone iného používateľa, aj čítanie.
// Klony sú fake, `uid` je uid procesu hooku (root).
const repos = (map) => (p) => {
  for (const [k, uid] of Object.entries(map)) if (p === k || p === k + "/.git") return { uid };
  throw new Error("ENOENT");
};
const WEB = "/home/tasker-svc/projekty/webproject2/webproject2-web";
const R = repos({ [WEB]: 1001, "/home/tasker-svc/projekty/x": 1001, "/root/adam": 0, "/opt/agentic-workflow": 0, "/root/x": 0 });
const chk = (cmd, o = {}) => foreignGitReason(cmd, { stat: R, uid: 0, cwd: "/root/adam", ...o });

test("príkaz z 22. 10. 2026 a cd do cudzieho klonu zamietne", () => {
  const why = chk(`git -C ${WEB} fetch origin`);
  assert.match(why, /^git ako uid 0 v klone používateľa uid 1001: /);
  assert.ok(why.includes(WEB) && why.includes("runuser -u"));
  assert.ok(chk("cd /home/tasker-svc/projekty/x && git status"));
  assert.ok(chk("cd /home/tasker-svc/projekty/x; git log --oneline"));
  assert.ok(chk("git status", { cwd: `${WEB}/src/lib` }));
  assert.ok(chk("git -C ../../home/tasker-svc/projekty/x log"));
});

test("git za oddeľovačmi, v podshelli a obale zamietne", () => {
  assert.ok(chk(`echo a | git -C ${WEB} log`));
  assert.ok(chk(`ls; git -C ${WEB} fetch`));
  assert.ok(chk(`ls && git -C ${WEB} pull`));
  assert.ok(chk(`x=$(git -C ${WEB} rev-parse HEAD)`));
  assert.ok(chk(`(cd ${WEB} && git status)`));
  assert.ok(chk(`GIT_TERMINAL_PROMPT=0 git -C ${WEB} fetch`));
  assert.ok(chk(`timeout 20 git -C ${WEB} fetch`));
  assert.ok(chk(`sh -c 'git -C ${WEB} fetch'`));
  assert.ok(chk(`sh -c "cd ${WEB} && git status"`));
  assert.ok(chk(`if cd ${WEB}; then git status; fi`));
  assert.ok(chk(`git --git-dir=${WEB}/.git status`));
  assert.ok(chk(`sudo git -C ${WEB} status`));
  assert.ok(chk(`echo "$(git -C ${WEB} log -1)"`));
  assert.ok(chk(`git -C '${WEB}' fetch`));
});

test("git pod vlastníkom, v rootovom klone a bez gitu pustí", () => {
  assert.equal(chk(`runuser -u tasker-svc -- git -C ${WEB} fetch origin`), null);
  assert.equal(chk(`cd ${WEB} && runuser -u tasker-svc -- git fetch`), null);
  assert.equal(chk(`sudo -u tasker-svc git -C ${WEB} fetch`), null);
  assert.equal(chk(`su - tasker-svc -c 'git -C ${WEB} fetch'`), null);
  assert.equal(chk(`runuser tasker-svc -c "git -C ${WEB} fetch"`), null);
  assert.equal(chk("git status"), null);
  assert.equal(chk("git -C /root/x fetch"), null);
  assert.equal(chk("git -C /opt/agentic-workflow log"), null);
  assert.equal(chk("cd /root/x && git status"), null);
  assert.equal(chk(`cat ${WEB}/package.json`), null);
  assert.equal(chk(`ls ${WEB} | grep git`), null);
  assert.equal(chk(`grep -rn fetch ${WEB}/src`), null);
  assert.equal(chk(`cd ${WEB} && cat .git/HEAD`), null);
  assert.equal(chk(`ssh examplehost 'git -C ${WEB} fetch'`), null);
  assert.equal(chk("git --version", { cwd: WEB }), null);
});

test("git v heredocu a v úvodzovkách je text", () => {
  assert.equal(chk(`ask_agent.sh boris x <<'EOF'\nSpusti git -C ${WEB} fetch.\nEOF`), null);
  assert.equal(chk(`echo "spusti git -C ${WEB} fetch"`), null);
  assert.equal(chk(`tasker comment 5 --body 'chyba: git -C ${WEB} fetch ako root'`), null);
  assert.equal(chk(`git commit -m "oprava git -C ${WEB} fetch" -- a`), null);
  assert.ok(chk(`cat <<EOF\ntext\nEOF\ngit -C ${WEB} fetch`));
});

test("neurčitá cesta a repo mimo stromu pustí", () => {
  assert.equal(chk('git -C "$D" fetch'), null);
  assert.equal(chk("cd $D && git status"), null);
  assert.equal(chk("git -C $(dirname x) status"), null);
  assert.equal(chk("git status", { cwd: null }), null);
  assert.equal(chk("git -C /tmp/nic status"), null);
  assert.equal(chk("git clone url /home/tasker-svc/projekty/nove", { stat: repos({}) }), null);
});

test("hook so skutočným statom: cudzí uid zamietne, vlastný pustí", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "fg-"));
  try {
    mkdirSync(join(dir, ".git"));
    const cmd = `git -C ${dir} fetch`;
    assert.equal(run({ command: cmd }), "");
    if (process.getuid() !== 0) return t.skip("chown potrebuje root");
    chownSync(dir, 1001, 1001);
    assert.equal(run({ command: cmd }), "deny");
    assert.equal(run({ command: `runuser -u nobody -- ${cmd}` }), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("git stash, reset --hard, restore, clean a --autostash zamietne", () => {
  assert.ok(foreignGitReason("git stash"));
  assert.ok(foreignGitReason("git -C /root/adam stash push"));
  assert.ok(foreignGitReason("cd x && git rebase --autostash origin/main"));
  assert.ok(foreignGitReason("git pull --autostash"));
  assert.ok(foreignGitReason("git reset --hard origin/main"));
  assert.ok(foreignGitReason("git checkout -- ."));
  assert.ok(foreignGitReason("git restore x"));
  assert.ok(foreignGitReason("git clean -fd"));
  assert.ok(foreignGitReason("runuser -u tasker-svc -- git stash"));
  assert.ok(foreignGitReason("sudo -u tasker-svc git rebase --autostash origin/main"));
  assert.equal(run({ command: "git rebase --autostash origin/main" }), "deny");
});

test("git stash list, rebase, commit a text so stash pustí", () => {
  assert.equal(foreignGitReason("git stash list"), null);
  assert.equal(foreignGitReason("git stash show -p"), null);
  assert.equal(foreignGitReason("git rebase origin/main"), null);
  assert.equal(foreignGitReason('git commit -m "stash"'), null);
  assert.equal(foreignGitReason('git commit -m "zákaz git stash a --autostash"'), null);
  assert.equal(foreignGitReason("echo 'git stash'"), null);
  assert.equal(foreignGitReason("cat <<'EOF'\ngit stash\nEOF"), null);
  assert.equal(run({ command: "git rebase origin/main" }), "");
});

test("git add -A, --all a . zamietne, git add súboru pustí (úloha 694)", () => {
  assert.equal(foreignGitReason("git add -A"), "ADD_ALL");
  assert.equal(foreignGitReason("git -C /root/x add --all"), "ADD_ALL");
  assert.equal(foreignGitReason("cd /root/x && git add ."), "ADD_ALL");
  assert.equal(foreignGitReason("runuser -u tasker-svc -- git add -Av"), "ADD_ALL");
  assert.equal(foreignGitReason("git add f.txt", { cwd: "/tmp" }), null);
  assert.equal(foreignGitReason('git commit -m "git add -A"'), null);
  assert.equal(run({ command: "git add ." }), "deny");
  assert.equal(run({ command: "git add f.txt" }), "");
});

test("replay 30. 10. 2026: git add -A v klone agenta, hook v tmp cwd (úloha 694)", () => {
  const cwd = mkdtempSync(join(tmpdir(), "u694-fg-"));
  try {
    const command = "cd /root/agent/.scratch/sablona/repo && git add -A";
    const out = execFileSync("node", [HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd }) }).toString();
    const h = JSON.parse(out).hookSpecificOutput;
    assert.equal(h.permissionDecision, "deny");
    assert.match(h.permissionDecisionReason, /git add -A/);
    assert.match(h.permissionDecisionReason, /git commit -m "<správa>" -- <zoznam vlastných súborov>/);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
