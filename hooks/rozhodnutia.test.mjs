// Testy hookov rozhodnutí (úloha 395, U4 návrhu 390): rozhodnutia_context.mjs,
// rozhodnutia_guard.mjs, K4 memory_claims.mjs a vypnutý prepínač AR_ROZHODNUTIA.
// K3 v reply_guard.mjs, rules_delta.mjs a fetchTasks majú test v repe
// agentic-workflow (test/rozhodnutia_hooks.test.mjs, úloha 528). Len fixtúry v dočasných priečinkoch: klon s
// decisions/ (git init v tmp), DB Taskera v tmp (TASKER_DB), HOME a
// CLAUDE_PROJECT_DIR v tmp. Živá DB ani klon sa nepoužijú: TASKER_DB ukazuje
// vždy na tmp a fetchTasks pri neexistujúcej výslovnej DB hodí chybu.
import "../lib/git_isolate.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync as mkdtempRaw, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { build } from "./rozhodnutia_context.mjs";
import { applySettings } from "../env/hooks.mjs";
import { bashTarget, reason as guardReason, ZMRAZENE } from "./rozhodnutia_guard.mjs";
import { memoryProblems } from "../lib/memory_claims.mjs";
import { formatRecord } from "../lib/rozhodnutia.mjs";

// Dočasné priečinky testu sa na konci zmažú (úloha 701).
const tmpDirs = [];
const mkdtempSync = (prefix) => { const d = mkdtempRaw(prefix); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

const HOOKS = new URL(".", import.meta.url).pathname;
const tmp = () => mkdtempSync(join(tmpdir(), "roz-"));
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
const cleanEnv = () => { const e = { ...process.env, ...GIT_ENV }; for (const k of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "AR_ROZHODNUTIA", "TASKER_DB", "AR_STATE"]) delete e[k]; return e; };

function clone() {
  const dir = join(tmp(), "clone");
  mkdirSync(join(dir, "decisions"), { recursive: true });
  const git = (...a) => { const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8", env: cleanEnv() }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git("init", "-q");
  const rec = (n, o) => writeFileSync(join(dir, "decisions", `D000${n}.md`), formatRecord({
    id: `D000${n}`, nazov: `Rozhodnutie ${n}`, stav: "platí", kluc: `test.k${n}`, rozsah: "server", agenti: "boris", rozhodol: "Oskar", moc: "operator",
    zapisal: "Adam", datum: "2026-10-2" + n, zdroj: "vlákno Adam", uloha: "", nahradza: "", nahradene: "", alias: "", subory: "", "zrusene-tvrdenie": "", telo: "Text.", ...o,
  }));
  const commit = (m) => { git("add", "-A"); git("commit", "-q", "-m", m); };
  return { dir, git, rec, commit };
}

const noTasks = async () => [];

test("kontext: bez zmeny najviac 2 riadky, s 2 zmenenými zázn. 4 riadky", async () => {
  const { dir, rec, commit } = clone();
  rec(1, {}); rec(2, { agenti: "adam", rozsah: "dizajn" }); commit("prvé");
  const stateDir = join(tmp(), "state");
  const a = { clone: dir, stateDir, name: "boris", roles: [], stroj: "server", tasks: noTasks };
  const first = (await build(a)).split("\n");
  assert.ok(first.length <= 2, first.join("\n"));
  assert.match(first[0], /^\[rozhodnutia\] 2 platných, pre teba 1 \(zoznam: node .*list --agent boris/);
  assert.match(first[0], /Prvý štart/);
  const same = (await build(a)).split("\n");
  assert.ok(same.length <= 2, same.join("\n"));
  assert.match(same[0], /bez zmeny/);
  assert.match(same[1], /^\[otázky\].*žiadna/);
  rec(3, {}); rec(4, { agenti: "*", rozsah: "git" }); rec(5, { agenti: "eva", rozsah: "dizajn" }); commit("dve nové pre boris, jedna cudzia");
  const out = (await build(a)).split("\n");
  assert.equal(out.length, 4, out.join("\n"));
  assert.match(out[0], /zmenené 2:/);
  assert.match(out[1], /^D0003 2026-10-23 server boris Oskar Rozhodnutie 3$/);
  assert.match(out[2], /^D0004 /);
  assert.equal((await build(a)).split("\n").length, 2, "po prečítaní zasa bez zmeny");
});

test("kontext: filter roly a stroja, zrušený záznam nesie značku, otázky z Taskera", async () => {
  const { dir, rec, commit } = clone();
  rec(1, {}); commit("prvé");
  const stateDir = join(tmp(), "state");
  const a = { clone: dir, stateDir, name: "eva", roles: ["dizajner"], stroj: "mac" };
  await build({ ...a, tasks: noTasks });
  rec(2, { agenti: "adam", rozsah: "dizajn" }); rec(3, { agenti: "adam", rozsah: "server" }); rec(1, { stav: "zrušené", agenti: "*" }); commit("zmeny");
  const out = (await build({ ...a, tasks: async () => [{ id: 12, title: "Otázka: farba", status: "needs_human", assignee: "eva", project: null }, { id: 13, title: "cudzia", status: "needs_human", assignee: "boris", project: "boris-x" }] })).split("\n");
  assert.match(out[0], /zmenené 2:/);
  assert.ok(out.some((l) => l.startsWith("D0002 ")), "rola dizajner vidí rozsah dizajn");
  assert.ok(out.some((l) => /^D0001 .*\[zrušené\]$/.test(l)));
  assert.ok(!out.some((l) => l.startsWith("D0003 ")), "stroj mac nevidí rozsah server");
  assert.match(out.at(-1), /úloha 12 \(Otázka: farba\)/);
  assert.doesNotMatch(out.at(-1), /cudzia/);
  const fail = await build({ ...a, tasks: async () => { throw new Error("x"); } });
  assert.match(fail.split("\n").at(-1), /Tasker neodpovedal/);
});

// Zmrazený log nesie značku v prvých riadkoch, voľný ju nemá (U7 až U9 ju vkladajú migráciou).
const Z = tmp();
const FREE = tmp();
for (const f of ["DECISIONS.md", "SCHVALENE.md"]) {
  writeFileSync(join(Z, f), `# Archív\n${ZMRAZENE}\n\nstarý obsah\n`);
  writeFileSync(join(FREE, f), "# Log\n\nzápis\n");
}
// Register rozhodnutí má v decisions/ aj ROZSAHY.md, cudzie repo bez neho nie (úloha 693).
const REG = tmp();
const NOREG = tmp();
for (const d of [REG, NOREG]) mkdirSync(join(d, "decisions"));
writeFileSync(join(REG, "decisions", "ROZSAHY.md"), "# Rozsahy\n");
const guardRun = (input) => spawnSync("node", [join(HOOKS, "rozhodnutia_guard.mjs")], { input: JSON.stringify(input), encoding: "utf8", env: cleanEnv() }).stdout;

test("guard K2: Edit na DECISIONS.md prejde, kým log nie je zmrazený, po zmrazení deny", () => {
  const edit = (file_path) => guardRun({ tool_name: "Edit", tool_input: { file_path, old_string: "a", new_string: "b" } });
  assert.equal(edit(join(FREE, "DECISIONS.md")), "", "voľný log prejde");
  assert.equal(edit(join(FREE, "neexistuje", "DECISIONS.md")), "", "neexistujúci súbor nie je zmrazený");
  const deny = JSON.parse(edit(join(Z, "DECISIONS.md")));
  assert.equal(deny.hookSpecificOutput.permissionDecision, "deny");
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /rozhodni\.sh/);
  // Zmrazenie sa zapína značkou: po jej vložení do voľného logu je deny.
  const late = join(tmp(), "DECISIONS.md");
  writeFileSync(late, "# Log\n");
  assert.equal(edit(late), "");
  writeFileSync(late, `# Log\n${ZMRAZENE}\n`);
  assert.equal(JSON.parse(edit(late)).hookSpecificOutput.permissionDecision, "deny");
  // Značka hlboko v texte (po 10. riadku) log nezmrazí.
  writeFileSync(late, "x\n".repeat(12) + ZMRAZENE + "\n");
  assert.equal(edit(late), "");
});

test("guard K2: záznam decisions/D0001.md dá deny vždy, aj neexistujúci, INDEX.md v registri", () => {
  for (const f of ["/nikde/decisions/D0001.md", join(REG, "decisions", "INDEX.md")])
    for (const tool of ["Edit", "Write", "MultiEdit"])
      assert.equal(JSON.parse(guardRun({ tool_name: tool, tool_input: { file_path: f } })).hookSpecificOutput.permissionDecision, "deny", `${tool} ${f}`);
  assert.equal(guardRun({ tool_name: "Bash", tool_input: { command: "/opt/agentic-workflow/bin/rozhodni.sh --nazov 'Test' --kluc a.b --rozsah server --agenti boris --rozhodol Oskar --moc operator --zdroj 'vlákno Adam' <<'EOF'\ntext DECISIONS.md\nEOF", cwd: Z } }), "");
  assert.equal(guardRun({ tool_name: "Edit", tool_input: { file_path: "/root/agentic-workflow/hooks/reply_guard.mjs" } }), "");
});

test("guard K2: Write, MultiEdit, zmrazené logy aj Bash zápisy", () => {
  for (const p of [join(Z, "SCHVALENE.md"), join(Z, "DECISIONS.md"), "decisions/D0007.md", join(REG, "decisions", "INDEX.md")])
    for (const tool of ["Write", "MultiEdit"]) assert.ok(guardReason({ tool_name: tool, tool_input: { file_path: p }, cwd: Z }), `${tool} ${p}`);
  assert.ok(guardReason({ tool_name: "Write", tool_input: { file_path: "DECISIONS.md" }, cwd: Z }), "relatívna cesta voči cwd");
  assert.equal(guardReason({ tool_name: "Write", tool_input: { file_path: "DECISIONS.md" }, cwd: FREE }), null);
  assert.equal(guardReason({ tool_name: "Edit", tool_input: { file_path: "/opt/agentic-workflow/decisions/ROZSAHY.md" } }), null);
  assert.equal(guardReason({ tool_name: "Edit", tool_input: { file_path: "/x/MY_DECISIONS.md.bak" } }), null);
  for (const c of [
    `echo hotovo >> ${Z}/DECISIONS.md`,
    `cat nove.md > ${Z}/SCHVALENE.md`,
    `sed -i 's/a/b/' ${Z}/DECISIONS.md`,
    "sed -i.bak -e 's/a/b/' DECISIONS.md",
    `printf x | tee -a ${Z}/DECISIONS.md`,
    "cp /tmp/x decisions/D0003.md",
  ]) assert.ok(bashTarget(c, Z), c);
  assert.ok(bashTarget("echo x >decisions/INDEX.md", REG), "INDEX.md v registri");
  assert.equal(bashTarget("echo x >> DECISIONS.md", FREE), null, "voľný log");
  for (const c of [
    "grep -n rozhodol /root/adam/DECISIONS.md",
    "sed -n '1,5p' DECISIONS.md",
    "cat DECISIONS.md > /tmp/kopia.md",
    "git commit -m 'Oprava DECISIONS.md zápis' -- DECISIONS.md",
    "echo 'v DECISIONS.md je záznam' > /tmp/x",
    "node lib/rozhodnutia.mjs show R153 2>&1",
    "cp DECISIONS.md /tmp/",
  ]) assert.equal(bashTarget(c, Z), null, c);
});

test("guard K2: INDEX.md je chránený len v decisions/ s ROZSAHY.md, D0001.md všade", () => {
  const verdict = (tool_name, tool_input, cwd) => guardRun({ tool_name, tool_input, cwd }) ? "deny" : "";
  for (const [tool, input] of [["Write", { file_path: "decisions/INDEX.md" }], ["Bash", { command: "echo x > decisions/INDEX.md" }], ["Bash", { command: "echo x >> decisions/INDEX.md" }]]) {
    assert.equal(verdict(tool, input, NOREG), "", `bez ROZSAHY.md prejde: ${JSON.stringify(input)}`);
    assert.equal(verdict(tool, input, REG), "deny", `s ROZSAHY.md deny: ${JSON.stringify(input)}`);
  }
  assert.equal(verdict("Write", { file_path: join(NOREG, "decisions", "INDEX.md") }, "/"), "", "absolútna cesta bez ROZSAHY.md");
  assert.equal(verdict("Write", { file_path: join(REG, "decisions", "INDEX.md") }, "/"), "deny", "absolútna cesta s ROZSAHY.md");
  assert.equal(verdict("Write", { file_path: join(NOREG, "decisions", "neexistuje", "INDEX.md") }, "/"), "", "podpriečinok bez ROZSAHY.md");
  for (const [tool, input] of [["Write", { file_path: "decisions/D0001.md" }], ["Bash", { command: "echo x > decisions/D0001.md" }]])
    for (const cwd of [NOREG, REG]) assert.equal(verdict(tool, input, cwd), "deny", `${JSON.stringify(input)} v ${cwd === REG ? "REG" : "NOREG"}`);
});

test("guard K2: INDEX.md cez cd a ~ v príkaze Bash (fail closed, úloha 693)", () => {
  // base/home je HOME, base/brain je register s ROZSAHY.md; cwd hooku je cudzí priečinok bez registra.
  const base = tmp();
  const home = join(base, "home");
  const brain = join(base, "brain");
  mkdirSync(home); mkdirSync(join(brain, "decisions"), { recursive: true });
  writeFileSync(join(brain, "decisions", "ROZSAHY.md"), "# Rozsahy\n");
  const run = (command, cwd = NOREG) => {
    const out = spawnSync("node", [join(HOOKS, "rozhodnutia_guard.mjs")], { input: JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } }), encoding: "utf8", env: { ...cleanEnv(), HOME: home } }).stdout;
    return out ? "deny" : "";
  };
  // Bod 1: relatívna cesta sa rozloží proti cd v príkaze, nie proti cwd hooku.
  for (const c of [
    `cd ${brain} && echo x > decisions/INDEX.md`,
    `cd ${brain}/decisions && echo x > INDEX.md`,
    `cd ${brain}; echo x >> decisions/INDEX.md`,
    `(cd ${brain} && echo x > decisions/INDEX.md)`,
    `true || cd ${brain}\necho x > decisions/INDEX.md`,
    `cd /tmp/x && echo x > decisions/INDEX.md`, // zámer: cd v príkaze, cieľ neoverím, zamietnuté
    `cd /tmp/x && tee decisions/INDEX.md`,
  ]) assert.equal(run(c), "deny", c);
  // Bod 2: `~` a `$HOME` sa rozbalia na HOME, `..` sa rozloží.
  for (const c of [
    "echo x > ~/../brain/decisions/INDEX.md",
    "echo x > $HOME/../brain/decisions/INDEX.md",
    "echo x > ${HOME}/../brain/decisions/INDEX.md",
    "cp /tmp/x ~/../brain/decisions/INDEX.md",
    "D=x; echo x > $D/INDEX.md",
    "echo x > $B/decisions/INDEX.md", // iná premenná: nevie sa rozložiť, chránené
  ]) assert.equal(run(c), "deny", c);
  // Dovolené: absolútna cesta bez registra, čítanie, cd bez zápisu do INDEX.md, `cd` len ako text.
  for (const c of [
    "echo x > /tmp/decisions/INDEX.md",
    `echo x > ${NOREG}/decisions/INDEX.md`,
    `cd /tmp && cat ${brain}/decisions/INDEX.md`,
    `cd ${brain} && cat decisions/INDEX.md`,
    `cd ${brain} && grep D0203 decisions/INDEX.md > /tmp/o`,
    `cd ${brain} && echo x > /tmp/decisions/INDEX.md`,
    "echo x > ~/decisions/INDEX.md",
    "echo x > decisions/INDEX.md",
  ]) assert.equal(run(c), "", c);
  // `echo cd` je falošný zásah, ktorý fail closed prijíma (slovo cd kdekoľvek).
  assert.equal(run("echo cd x > decisions/INDEX.md"), "deny");
  // Write a Edit s relatívnou cestou ostávajú podľa cwd, `cd` tam nie je.
  assert.equal(guardReason({ tool_name: "Write", tool_input: { file_path: "decisions/INDEX.md" }, cwd: NOREG }), null);
});

test("guard K2: INDEX.md cez pushd, builtin cd, blok, if, sh -c, ~user, ~+ a \"$HOME\" (tretie kolo, úloha 693)", () => {
  const base = tmp();
  const home = join(base, "home");
  const brain = join(base, "brain");
  mkdirSync(home); mkdirSync(join(brain, "decisions"), { recursive: true });
  writeFileSync(join(brain, "decisions", "ROZSAHY.md"), "# Rozsahy\n");
  const run = (command, cwd = NOREG) => {
    const out = spawnSync("node", [join(HOOKS, "rozhodnutia_guard.mjs")], { input: JSON.stringify({ tool_name: "Bash", cwd, tool_input: { command } }), encoding: "utf8", env: { ...cleanEnv(), HOME: home } }).stdout;
    return out ? "deny" : "";
  };
  for (const c of [
    `pushd ${brain} && echo x > decisions/INDEX.md`, // 1
    `builtin cd ${brain} && echo x > decisions/INDEX.md`, // 2
    `{ cd ${brain}; echo x > decisions/INDEX.md; }`, // 3
    `if true; then cd ${brain}; fi; echo x > decisions/INDEX.md`, // 4
    `sh -c "cd ${brain} && echo x > decisions/INDEX.md"`, // 5
    `bash -lc 'cd ${brain} && echo x > decisions/INDEX.md'`,
    `pushd ${brain}; popd; tee decisions/INDEX.md`,
    "echo x > ~root/../brain/decisions/INDEX.md", // 6
    "echo x > ~-/decisions/INDEX.md",
    "echo x > ~1/decisions/INDEX.md",
    'echo x > "$HOME"/../brain/decisions/INDEX.md', // stará medzera
    "echo x > '$HOME'/../brain/decisions/INDEX.md",
    'cp /tmp/x "$HOME"/../brain/decisions/INDEX.md',
  ]) assert.equal(run(c), "deny", c);
  assert.equal(run("echo x > ~+/decisions/INDEX.md", brain), "deny", "~+ v cwd registra"); // 7
  // Protipríklady: bez zápisu, bez cd v príkaze alebo s cieľom mimo INDEX.md.
  for (const c of [
    `cd /tmp && cat ${brain}/decisions/INDEX.md`,
    "echo x > /tmp/decisions/INDEX.md",
    "pushd /tmp && ls",
    `cd ${brain} && echo x > ~root/out.md`,
    "echo x > ~root/out.md",
    "sh script.sh > /tmp/o",
  ]) assert.equal(run(c), "", c);
});

test("env/hooks.mjs zapíše oba hooky rozhodnutí a AR_ROZHODNUTIA, opakovaný beh nič nezdvojí", () => {
  const dir = tmp();
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ env: { X: "1" }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "iny" }] }] } }));
  const run = () => applySettings(join(dir, "settings.json"), "main", "/h/hooks", "/h");
  run(); run();
  const d = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  const cmds = (ev) => d.hooks[ev].flatMap((g) => g.hooks.map((h) => h.command));
  assert.equal(cmds("SessionStart").filter((c) => /rozhodnutia_context/.test(c)).length, 1);
  assert.equal(cmds("PreToolUse").filter((c) => /rozhodnutia_guard/.test(c)).length, 1);
  assert.match(d.hooks.PreToolUse.find((g) => g.hooks.some((h) => /rozhodnutia_guard/.test(h.command))).matcher, /Write\|Edit\|MultiEdit\|NotebookEdit\|Bash/);
  assert.ok(cmds("PreToolUse").includes("iny"));
  assert.equal(d.env.X, "1");
  assert.equal(d.env.AR_ROZHODNUTIA, "1");
});

test("K4: pamäť s 'čaká na Oskara' a rozhodnutím bez čísla", () => {
  const t = "Otvorené u Oskara: dlaždice.\nČaká na Oskara (úloha 12).\nAdam za Oskara rozhodol: bez mockupu\nrozhodnutie D0011 platí\nHDD čaká na rozdvojovač";
  const p = memoryProblems(t, { AGENT_OPERATOR_NAME: "Oskar" });
  assert.deepEqual(p.map((x) => x.riadok), [1, 3]);
});
