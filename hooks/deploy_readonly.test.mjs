// deploy_readonly.mjs: zápis súboru a git commit v /opt/tasker a /opt/agentic-workflow sa zamietne,
// čítanie a nasadenie správcu servera (fetch, checkout, merge) prejde. Hook sa púšťa len
// vstupom na stdin, nič sa nezapisuje a git sa nespúšťa nikdy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, symlinkSync, rmSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { protectedRoot, commitRoot } from "./deploy_readonly.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "deploy_readonly.mjs");

function run(input) {
  const out = execFileSync("node", [HOOK], { input: JSON.stringify(input) }).toString();
  return out ? JSON.parse(out).hookSpecificOutput : null;
}
const bash = (command, cwd = "/root/adam") => run({ tool_name: "Bash", cwd, tool_input: { command } });
const write = (tool_name, file_path, cwd = "/root/adam") => run({ tool_name, cwd, tool_input: { file_path, content: "x", old_string: "a", new_string: "b" } });

test("replay chyby 20. 10. 2026: Edit v /opt/tasker sa zamietne s postupom", () => {
  const r = write("Edit", "/opt/tasker/src/cli.js");
  assert.equal(r.permissionDecision, "deny");
  assert.match(r.permissionDecisionReason, /D0052/);
  assert.match(r.permissionDecisionReason, /Správny postup:.*\/root\/tasker.*správca servera/);
});

test("Edit, Write, MultiEdit a NotebookEdit v /opt/tasker a /opt/agentic-workflow zamietne", () => {
  for (const tool of ["Edit", "Write", "MultiEdit"]) {
    for (const f of ["/opt/tasker/a.js", "/opt/tasker/sub/dir/a.js", "/opt/agentic-workflow/RULES.md", "/opt/agentic-workflow/hooks/x.mjs", "/opt/tasker/../tasker/a.js", "/opt/tasker/x/../../agentic-workflow/a"]) {
      assert.equal(write(tool, f)?.permissionDecision, "deny", `${tool} ${f}`);
    }
  }
  assert.equal(run({ tool_name: "NotebookEdit", tool_input: { notebook_path: "/opt/tasker/n.ipynb" } })?.permissionDecision, "deny");
  assert.equal(write("Write", "src/a.js", "/opt/tasker")?.permissionDecision, "deny", "relatívna cesta od cwd");
  assert.equal(write("Edit", "./a.js", "/opt/agentic-workflow/hooks")?.permissionDecision, "deny");
  assert.equal(write("Write", "../tasker/a.js", "/opt/agentic-workflow")?.permissionDecision, "deny");
});

test("zápis inde a podobné cesty pustí", () => {
  for (const f of ["/root/tasker/src/a.js", "/root/agentic-workflow/RULES.md", "/opt/tasker-copy/a", "/opt/agentic-workflow2/a", "/opt/other/a", "/tmp/opt/tasker/a", "/root/adam/scratch/x"]) {
    assert.equal(write("Write", f), null, f);
  }
  assert.equal(write("Write", "a.js", "/root/tasker"), null);
  assert.equal(run({ tool_name: "Read", tool_input: { file_path: "/opt/tasker/a.js" } }), null);
  assert.equal(run({ tool_name: "Grep", tool_input: { path: "/opt/tasker" } }), null);
});

test("odkaz do /opt/tasker sa rozloží", () => {
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "deploy_ro_")));
  try {
    // /opt/tasker nemusí na stroji existovať, odkaz ukáže na jeho cestu a rozloží sa len ak ju realpath nájde
    symlinkSync("/opt", join(tmp, "o"));
    assert.equal(protectedRoot(join(tmp, "o/tasker/a.js")), "/opt/tasker");
    assert.equal(protectedRoot(join(tmp, "o/agentic-workflow/a.js")), "/opt/agentic-workflow");
    assert.equal(protectedRoot(join(tmp, "o/ine/a.js")), null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("git commit v /opt/tasker a /opt/agentic-workflow zamietne v rôznych tvaroch", () => {
  for (const cmd of [
    'git -C /opt/tasker commit -m "x" -- f',
    'git -C /opt/agentic-workflow commit -m x',
    "cd /opt/tasker && git commit -m x -- f",
    "cd /opt/agentic-workflow; git commit -m x",
    "cd /opt/tasker/src && git commit -am x",
    'git -C /opt/tasker/src commit -m x',
    "git --git-dir=/opt/tasker/.git commit -m x",
    "git -c user.name=x -C /opt/tasker commit -m x",
    "ls && git -C /opt/tasker commit -m x",
    "sh -c 'git -C /opt/tasker commit -m x'",
    "runuser -u tasker-svc -- git -C /opt/tasker commit -m x",
    "sudo -u tasker-svc git -C /opt/tasker commit -m x",
    "env X=1 git -C /opt/tasker commit -m x",
    "git -C /opt/tasker add f && git -C /opt/tasker commit -m x",
    "git -C /opt/tasker commit --amend --no-edit",
  ]) assert.ok(commitRoot(cmd), cmd);
  assert.equal(bash("git -C /opt/tasker commit -m x")?.permissionDecision, "deny");
  assert.match(bash("git -C /opt/agentic-workflow commit -m x").permissionDecisionReason, /Správny postup:/);
  assert.equal(bash("git commit -m x", "/opt/tasker")?.permissionDecision, "deny", "cwd v /opt/tasker");
  assert.equal(bash("git commit -m x", "/opt/agentic-workflow/hooks")?.permissionDecision, "deny");
});

test("fetch, checkout, merge, log, status a commit inde pustí", () => {
  for (const cmd of [
    "git -C /opt/tasker fetch origin",
    "git -C /opt/tasker checkout abc1234",
    "git -C /opt/tasker merge --ff-only origin/main",
    "git -C /opt/tasker log --oneline -3",
    "git -C /opt/tasker status --short",
    "git -C /opt/tasker diff",
    "git -C /opt/tasker rev-parse HEAD",
    "cd /opt/tasker && git fetch && git checkout abc1234",
    "cd /opt/agentic-workflow && git status",
    "git -C /opt/agentic-workflow fetch origin && git -C /opt/agentic-workflow merge --ff-only origin/main",
    "git -C /root/tasker commit -m x",
    "git -C /root/agentic-workflow commit -m x -- f",
    "cd /root/tasker && git commit -m x",
    "git commit -m x",
    "git -C /opt/tasker-copy commit -m x",
    'git commit -m "oprava v /opt/tasker"',
    'echo "git -C /opt/tasker commit -m x"',
    "echo git -C /opt/tasker commit",
    "grep -rn 'git commit' /opt/tasker",
    "cat <<'EOF'\ngit -C /opt/tasker commit -m x\nEOF",
    "# git -C /opt/tasker commit",
    "cd /opt/tasker && ls && cd /root/tasker && git commit -m x",
    'git -C "$REPO" commit -m x',
    "git -C $(pwd) commit -m x",
    "",
  ]) assert.equal(commitRoot(cmd), null, cmd);
  assert.equal(bash("git -C /opt/tasker fetch origin"), null);
  assert.equal(bash("git commit -m x", "/root/tasker"), null);
});

test("Bash zápis cez cat > súbor hook neposudzuje (len git commit)", () => {
  assert.equal(bash("ls /opt/tasker"), null);
  assert.equal(bash("cat /opt/tasker/package.json"), null);
});

// Spustí hook s vlastným prostredím (AR_READONLY_DIRS, AGENT_WORKFLOW, AGENT_BRAIN_GLOBAL).
function runEnv(input, extra, drop = []) {
  const env = { ...process.env, ...extra };
  for (const k of drop) delete env[k];
  const out = execFileSync("node", [HOOK], { input: JSON.stringify(input), env }).toString();
  return out ? JSON.parse(out).hookSpecificOutput : null;
}

test("AR_READONLY_DIRS prekryje chránené koreňe (predvolené /opt/tasker a klony sa nestrážia)", () => {
  const extra = { AR_READONLY_DIRS: "/tmp/ro-kod:/tmp/ro-mozog" };
  const w = (f) => runEnv({ tool_name: "Write", cwd: "/root/adam", tool_input: { file_path: f, content: "x" } }, extra);
  assert.equal(w("/tmp/ro-kod/a.js")?.permissionDecision, "deny");
  assert.equal(w("/tmp/ro-mozog/b/c.md")?.permissionDecision, "deny");
  assert.equal(w("/tmp/ro-mozog2/a"), null);
  assert.equal(w("/opt/tasker/a.js"), null);
  assert.equal(runEnv({ tool_name: "Bash", cwd: "/root/adam", tool_input: { command: "git -C /tmp/ro-kod commit -m x" } }, extra)?.permissionDecision, "deny");
});

test("AGENT_WORKFLOW a AGENT_BRAIN_GLOBAL určujú chránené klony", () => {
  const extra = { AGENT_WORKFLOW: "/tmp/wf-klon", AGENT_BRAIN_GLOBAL: "/tmp/mozog-klon" };
  const w = (f) => runEnv({ tool_name: "Edit", cwd: "/root/adam", tool_input: { file_path: f } }, extra, ["AR_READONLY_DIRS"]);
  assert.equal(w("/tmp/wf-klon/hooks/x.mjs")?.permissionDecision, "deny");
  assert.equal(w("/tmp/mozog-klon/RULES.md")?.permissionDecision, "deny");
  assert.equal(w("/opt/tasker/a.js")?.permissionDecision, "deny");
  assert.equal(w("/opt/agentic-workflow/hooks/x.mjs"), null);
});

// Úloha 680 (30. 10. 2026): `sed -i ... /root/CLAUDE.md`, odkaz na RULES.md v klone mozgu, prešiel.
// Chránený koreň je mktemp priečinok (AR_READONLY_DIRS), odkaz naň leží v inom mktemp priečinku.
function withLink(fn) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "deploy_ro_root_")));
  const other = realpathSync(mkdtempSync(join(tmpdir(), "deploy_ro_link_")));
  try {
    writeFileSync(join(root, "RULES.md"), "pravidlo\n");
    symlinkSync(join(root, "RULES.md"), join(other, "CLAUDE.md"));
    const extra = { AR_READONLY_DIRS: root };
    const b = (command, cwd = other) => runEnv({ tool_name: "Bash", cwd, tool_input: { command } }, extra);
    fn({ root, other, link: join(other, "CLAUDE.md"), b });
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
}

test("680: zápis cez odkaz do chráneného koreňa sa zamietne s cieľom, koreňom a postupom", () => {
  withLink(({ root, link, b }) => {
    const r = b(`sed -i 's/a/b/' ${link}`);
    assert.equal(r?.permissionDecision, "deny");
    assert.ok(r.permissionDecisionReason.includes(link), "cieľ");
    assert.ok(r.permissionDecisionReason.includes(join(root, "RULES.md")), "rozložená cesta");
    assert.ok(r.permissionDecisionReason.includes(root), "koreň");
    assert.match(r.permissionDecisionReason, /Správny postup:.*klone na zápis.*commitni.*sťahovanie/);
    assert.equal(b(`sed --in-place -e 's/a/b/' ${link}`)?.permissionDecision, "deny");
    assert.equal(b(`sed -i.bak -e 's/a/b/' ${link}`)?.permissionDecision, "deny");
    assert.equal(b(`echo x >> ${link}`)?.permissionDecision, "deny");
    assert.equal(b(`echo x > ${link}`)?.permissionDecision, "deny");
    assert.equal(b(`echo x 2>&1 >${link}`)?.permissionDecision, "deny");
    assert.equal(b(`perl -pi -e 's/a/b/' ${link}`)?.permissionDecision, "deny");
    assert.equal(b(`cat a | tee -a ${link}`)?.permissionDecision, "deny");
    assert.equal(b("sed -i 's/a/b/' RULES.md", root)?.permissionDecision, "deny", "relatívna cesta od cwd");
    assert.equal(b(`cd ${root} && sed -i 's/a/b/' RULES.md`)?.permissionDecision, "deny", "cd v príkaze");
    assert.equal(b(`sudo -u x sed -i 's/a/b/' ${link}`)?.permissionDecision, "deny");
    assert.equal(b(`cat > ${link} <<'EOF'\nnovy\nEOF`)?.permissionDecision, "deny", "heredoc ide do súboru");
  });
});

test("680: čítanie cez odkaz prejde", () => {
  withLink(({ root, link, b }) => {
    for (const cmd of [
      `sed -n 1p ${link}`,
      `sed -n -e 1p ${link}`,
      `cat ${link}`,
      `grep pravidlo ${link}`,
      `diff ${link} /tmp/x`,
      `cp ${link} /tmp/x`,
      `cp ${join(root, "RULES.md")} /tmp/x`,
      `git -C ${root} log --oneline -3`,
      `cat ${link} > /tmp/kopia`,
      `ls ${root} 2>&1`,
      `echo "text s ${link} a medzerou" `,
    ]) assert.equal(b(cmd), null, cmd);
  });
});

test("680: tee, cp, mv, install, rm, truncate a python s cestou pod koreňom sa zamietne", () => {
  withLink(({ root, b }) => {
    const f = join(root, "sub/f.md");
    for (const cmd of [
      `tee ${f}`,
      `echo x | tee ${f}`,
      `tee -a ${f}`,
      `cp a ${f}`,
      `cp -r a ${root}/`,
      `cp -t ${root} a`,
      `cp --target-directory=${root} a b`,
      `mv a ${f}`,
      `mv ${f} /tmp/x`,
      `install -m 644 a ${f}`,
      `rm ${f}`,
      `rm -rf ${root}`,
      `truncate -s 0 ${f}`,
      `python3 -c "open('${f}', 'w').write('x')"`,
      `python3 -c "open('${f}','a').write('x')"`,
      `python3 -c "from pathlib import Path; Path('${f}').write_text('x')"`,
      `sh -c 'echo x > ${f}'`,
      `ls && echo x >> ${f}`,
    ]) assert.equal(b(cmd)?.permissionDecision, "deny", cmd);
  });
});

test("680: cp z koreňa von, ciele mimo koreňov, premenná a text v úvodzovkách prejdú", () => {
  withLink(({ root, other, b }) => {
    const f = join(root, "sub/f.md");
    const out = join(other, "mimo.md");
    writeFileSync(out, "x\n");
    for (const cmd of [
      `cp ${f} /tmp/x`,
      `cp -a ${root} /tmp/zaloha`,
      `sed -i 's/a/b/' ${out}`,
      `sed -i 's/a/b/' $F`,
      `sed -i 's/a/b/' "$(pwd)/x"`,
      `sed -i 's/a/b/' $(ls ${root})`,
      `echo x >> $OUT`,
      `echo x > /dev/null`,
      `tee ${out}`,
      `cp a ${out}`,
      `rm ${out}`,
      `mv ${out} ${out}.old`,
      `truncate -s 0 ${out}`,
      `echo "sed -i s/a/b/ ${f}"`,
      `git commit -m "zapisujem do ${f} a presmerovanie > ${f}" -- x`,
      `python3 -c "print(open('${f}').read())"`,
      `python3 -c "open('${out}', 'w').write('x')"`,
      `cat <<'EOF'\nsed -i 's/a/b/' ${f}\necho x > ${f}\nEOF`,
      `echo 'text s medzerou > ${f}'`,
      `cd /tmp && sed -i 's/a/b/' RULES.md`,
    ]) assert.equal(b(cmd), null, cmd);
  });
});

test("680: rm a mv odkazu zmaže odkaz, nie súbor v koreni", () => {
  withLink(({ link, b }) => {
    assert.equal(b(`rm ${link}`), null);
    assert.equal(b(`mv ${link} ${link}.old`), null);
    assert.equal(b(`rm -f ${link}`), null);
  });
});

test("680 replay: sed -i na /root/CLAUDE.md s AR_READONLY_DIRS=/opt/agentic-brain-global skončí zamietnutím", () => {
  // hook len číta realpath, nič nemení; bez odkazu /root/CLAUDE.md na stroji sa cesta nerozloží
  // a zamietnutie nemá z čoho vzísť, preto sa test spolieha na odkaz len ak existuje.
  let target = null;
  try { target = realpathSync("/root/CLAUDE.md"); } catch {}
  if (!target?.startsWith("/opt/agentic-brain-global/")) return;
  const r = runEnv({ tool_name: "Bash", cwd: "/root/adam", tool_input: { command: "sed -i 's/x/y/' /root/CLAUDE.md" } }, { AR_READONLY_DIRS: "/opt/agentic-brain-global" });
  assert.equal(r?.permissionDecision, "deny");
  assert.ok(r.permissionDecisionReason.includes("/root/CLAUDE.md"));
  assert.ok(r.permissionDecisionReason.includes(target));
});
