// Testy kontrol rozhodnutí v hookoch tohto repa (úloha 395, U4 návrhu 390, presun
// úloha 528): K3 v reply_guard.mjs, sledovanie decisions/ v rules_delta.mjs
// a čítanie úloh Taskera (lib/tasker_read.mjs). Len fixtúry v dočasných
// priečinkoch: klon s decisions/ (git init v tmp), DB Taskera v tmp
// (TASKER_DB), HOME a CLAUDE_PROJECT_DIR v tmp. Živá DB ani klon sa nepoužijú:
// TASKER_DB ukazuje vždy na tmp a fetchTasks pri neexistujúcej výslovnej DB
// hodí chybu.
import "../lib/git_isolate.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync as mkdtempRaw, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { waitingProblem, decisionProblem, waitingUnits } from "../hooks/reply_guard.mjs";
import { fetchTasks } from "../lib/tasker_read.mjs";
import { delta } from "../hooks/rules_delta.mjs";

// Dočasné priečinky testu sa na konci zmažú (úloha 701).
const tmpDirs = [];
const mkdtempSync = (prefix) => { const d = mkdtempRaw(prefix); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

const HOOKS = join(dirname(fileURLToPath(import.meta.url)), "../hooks");
const tmp = () => mkdtempSync(join(tmpdir(), "roz-"));
const GIT_ENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const cleanEnv = () => { const e = { ...process.env, ...GIT_ENV }; for (const k of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "AR_ROZHODNUTIA", "TASKER_DB", "AR_STATE", "AGENT_OPERATOR_NAME", "TASKER_WEB_URL", "AGENT_NAME", "TASKER_USER"]) delete e[k]; return e; };

function clone() {
  const dir = join(tmp(), "clone");
  mkdirSync(join(dir, "decisions"), { recursive: true });
  const git = (...a) => { const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8", env: cleanEnv() }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git("init", "-q");
  const rec = (n) => writeFileSync(join(dir, "decisions", `D000${n}.md`), `---\nid: D000${n}\n---\nText.\n`);
  const commit = (m) => { git("add", "-A"); git("commit", "-q", "-m", m); };
  return { dir, rec, commit };
}

function taskDb(rows) {
  const f = join(tmp(), "tasker.db");
  const d = new DatabaseSync(f);
  d.exec("CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, status TEXT, assignee TEXT, project TEXT)");
  for (const r of rows) d.prepare("INSERT INTO tasks VALUES (?,?,?,?,?)").run(...r);
  d.close();
  return f;
}

test("fetchTasks číta fixtúru DB a výslovnú neexistujúcu DB odmietne", async () => {
  const f = taskDb([[1, "a", "needs_human", "boris", null], [2, "b", "queued", "boris", null]]);
  assert.deepEqual((await fetchTasks({ status: "needs_human", env: { TASKER_DB: f } })).map((t) => t.id), [1]);
  assert.deepEqual((await fetchTasks({ ids: [2], env: { TASKER_DB: f } })).map((t) => t.status), ["queued"]);
  await assert.rejects(fetchTasks({ env: { TASKER_DB: join(tmpdir(), "neexistuje-roz.db") } }));
});

const BORIS = [
  "Boris: Na teba čakajú tri veci:\n\n1. **Dlaždice webu Taskera.** K tvojej správe o zle naformátovaných dlaždiciach a o rozdiele medzi \"všetky úlohy\" a \"projekty\" v makete mi chýba tvoj pokyn. Povedal si mi, aby som počkal.\n2. **Disk HDD.** Kým nepríde rozdvojovač napájania SATA a nezapojíš ho, disk nepripojím.\n3. **Náhľad prehliadača v T3 pod rootom.** Chrome pod rootom so sandboxom nenaštartuje, takže chýba tvoje rozhodnutie o bezpečnosti, ktoré je zapísané v R153. Buď sandbox vypneme (`T3CODE_SERVER_BROWSER_SANDBOX=0`), alebo bude náhľad bežať len v inštancii T3 pod používateľom bez rootu. Odporúčam druhú možnosť, lebo zabezpečenie ostane bez zmeny.\n\nV Taskeri nečaká na teba žiadna moja úloha.",
  "Boris: Na teba čakajú tri veci, v Taskeri na teba nečaká žiadna moja úloha.\n\n1. Dlaždice webu Taskera: kým mi nedáš pokyn k svojej správe o ich formátovaní a o rozdiele medzi \"všetky úlohy\" a \"projekty\", nič s tým nerobím.\n2. Disk HDD čaká, kým zapojíš rozdvojovač napájania SATA.\n3. Náhľad prehliadača v T3 pod rootom (R153) potrebuje tvoje rozhodnutie, či sandbox vypneme alebo pustíme náhľad len v T3 bez rootu, a ja odporúčam druhú možnosť, lebo sa nemení zabezpečenie.",
];

test("K3a: odpoveď z vlákna dá dôvod bez odkazu na úlohu", async () => {
  for (const t of BORIS) {
    assert.ok(waitingUnits(t).length >= 1);
    const why = await waitingProblem(t, async () => []);
    assert.match(why, /bez odkazu na úlohu Taskera/);
    assert.match(why, /tasker ask/);
  }
});

test("K3a: odkaz na úlohu v needs_human prejde, iný stav, neznáma úloha a výpadok Taskera nie", async () => {
  const link = (id) => `[úloha ${id}](https://host.example.ts.net:8801/tasks/${id})`;
  const t = `Boris: Čaká na teba:\n- ${link(7)} HDD a rozdvojovač.\n- ${link(8)} sandbox.`;
  const rows = [{ id: 7, status: "needs_human" }, { id: 8, status: "needs_human" }];
  assert.equal(await waitingProblem(t, async () => rows), null);
  assert.match(await waitingProblem(t, async () => [rows[0], { id: 8, status: "queued" }]), /úloha 8 .* queued, nie needs_human/);
  assert.match(await waitingProblem(t, async () => [rows[0]]), /úloha 8 .* neexistuje/);
  assert.match(await waitingProblem(t, async () => { throw new Error("x"); }), /Tasker neodpovedal/);
  for (const ok of ["Boris: Nič. Sandbox je D0007.", "Boris: Čaká na teba: nič.", "Boris: Na teba nečaká nič, v Taskeri nečaká na teba žiadna úloha.", "Boris: Čaká na teba:\n- žiadne"])
    assert.equal(await waitingProblem(ok, async () => []), null, ok);
});

test("K3b: operátor rozhodol bez zápisu zastaví, so skriptom, číslom D alebo dátumom nie", () => {
  const env = { AGENT_OPERATOR_NAME: "Oskar" };
  const bad = "Adam: Oskar rozhodol, že sandbox ostane zapnutý.";
  assert.match(decisionProblem(bad, ["git status"], env), /bin\/rozhodni\.sh/);
  assert.equal(decisionProblem(bad, ["bin/rozhodni.sh --zrus D0007 --dovod x"], env), null);
  assert.equal(decisionProblem(bad, ["runuser -u tasker-svc -- env X=1 tasker ask 5 --body x"], env), null);
  assert.equal(decisionProblem("Adam: Oskar rozhodol v D0007, že sandbox ostane.", [], env), null);
  assert.equal(decisionProblem("Adam: Oskar rozhodol 19. 10., že sandbox ostane.", [], env), null);
  assert.match(decisionProblem("Adam: Oskar schválil plán a určil poradie.", [], env), /nebežal/);
  assert.equal(decisionProblem("Adam: Rozhodol som sám, Oskar sa nepýtal.", [], env), null);
});

function cli(script, input, env = {}) {
  const home = tmp();
  return spawnSync("node", [join(HOOKS, script)], { input: JSON.stringify(input), encoding: "utf8", env: { ...cleanEnv(), HOME: home, CLAUDE_PROJECT_DIR: home, REPLY_GUARD_NO_NET: "1", AGENT_THREADS: "", ...env } });
}

test("reply_guard CLI: odpoveď s prepínačom dá block, bez neho sa správanie nemení", () => {
  const dbf = taskDb([[7, "HDD", "needs_human", "boris", null], [8, "x", "queued", "boris", null]]);
  const on = { AR_ROZHODNUTIA: "1", TASKER_DB: dbf };
  // Text, ktorý ostatné kontroly pustia a K3 nie.
  const quiet = "Boris: Čaká na teba:\n- HDD a rozdvojovač.";
  assert.equal(cli("reply_guard.mjs", { last_assistant_message: quiet }).stdout, "", "vypnuté: bez zmeny");
  assert.equal(cli("reply_guard.mjs", { last_assistant_message: quiet }, { AR_ROZHODNUTIA: "0" }).stdout, "");
  // Prvá odpoveď má aj položky s viac vetami, zastaví ju už strop viet,
  // druhá a prázdny zoznam ostanú až na K3a.
  for (const t of [quiet, BORIS[1]]) {
    const out = JSON.parse(cli("reply_guard.mjs", { last_assistant_message: t }, on).stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /bez odkazu na úlohu Taskera/);
  }
  assert.equal(JSON.parse(cli("reply_guard.mjs", { last_assistant_message: BORIS[0] }, on).stdout).decision, "block");
  const link = (id) => `[úloha ${id}](https://host.example.ts.net:8801/tasks/${id})`;
  assert.equal(cli("reply_guard.mjs", { last_assistant_message: `Boris: Čaká na teba:\n- ${link(7)} HDD.` }, on).stdout, "", "needs_human prejde");
  assert.match(JSON.parse(cli("reply_guard.mjs", { last_assistant_message: `Boris: Čaká na teba:\n- ${link(8)} x.` }, on).stdout).reason, /queued/);
  assert.match(JSON.parse(cli("reply_guard.mjs", { last_assistant_message: quiet }, { AR_ROZHODNUTIA: "1", TASKER_DB: join(tmpdir(), "nie-je-roz.db") }).stdout).reason, /Tasker neodpovedal|odkazu/);
});

test("reply_guard CLI: K3b číta príkazy z prepisu, stop_hook_active mlčí", () => {
  const dir = tmp();
  const tr = (cmd) => {
    const f = join(dir, `t${Math.random()}.jsonl`);
    const lines = [{ type: "user", message: { content: "ahoj" } }, { type: "assistant", message: { content: [...(cmd ? [{ type: "tool_use", name: "Bash", input: { command: cmd } }] : []), { type: "text", text: "x" }] } }];
    writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n"));
    return f;
  };
  const dbf = taskDb([]);
  const on = { AR_ROZHODNUTIA: "1", TASKER_DB: dbf, AGENT_OPERATOR_NAME: "Oskar" };
  const text = "Adam: Oskar rozhodol, že sandbox ostane zapnutý.";
  assert.equal(JSON.parse(cli("reply_guard.mjs", { last_assistant_message: text, transcript_path: tr(null) }, on).stdout).decision, "block");
  assert.equal(cli("reply_guard.mjs", { last_assistant_message: text, transcript_path: tr("bin/rozhodni.sh --nazov x") }, on).stdout, "");
  assert.equal(cli("reply_guard.mjs", { last_assistant_message: text, transcript_path: tr(null), stop_hook_active: true }, on).stdout, "");
  assert.equal(cli("reply_guard.mjs", { last_assistant_message: text, transcript_path: tr(null) }, { AGENT_OPERATOR_NAME: "Oskar" }).stdout, "", "vypnuté");
});

test("rules_delta: decisions/ ide do ťahu len so zapnutým prepínačom (delta aj hook)", () => {
  const { dir, rec, commit } = clone();
  writeFileSync(join(dir, "RULES.md"), "v1\n"); commit("prvy");
  const a = { clone: dir, sessionId: "s1" };
  const off = join(tmp(), "off"), on = join(tmp(), "on");
  delta({ ...a, stateDir: off, paths: ["RULES.md"] }); delta({ ...a, stateDir: on, paths: ["RULES.md", "decisions/"] });
  rec(1); commit("zaznam");
  assert.equal(delta({ ...a, stateDir: off, paths: ["RULES.md"] }), null);
  const text = delta({ ...a, stateDir: on, paths: ["RULES.md", "decisions/"] });
  assert.match(text, /D0001\.md/);
  assert.match(text, /^\[pravidlá\]/);
});

test("rules_delta hook: dva klony, decisions/ z AGENT_BRAIN_GLOBAL len s AR_ROZHODNUTIA=1", () => {
  const wf = clone(), brain = clone();
  writeFileSync(join(wf.dir, "RULES.md"), "v1\n"); wf.commit("prvy");
  mkdirSync(join(brain.dir, "env", "server"), { recursive: true });
  writeFileSync(join(brain.dir, "env", "server", "RULES.md"), "s1\n"); brain.commit("prvy");
  const run = (extra, sid) => spawnSync("node", [join(HOOKS, "rules_delta.mjs")], {
    input: JSON.stringify({ session_id: sid }), encoding: "utf8",
    env: { ...cleanEnv(), HOME: tmp(), AGENT_THREADS: "", AGENT_WORKFLOW: wf.dir, AGENT_BRAIN_GLOBAL: brain.dir, AR_STATE: join(tmp(), "st"), AR_ENV: "server", ...extra },
  });
  const states = { off: join(tmp(), "off"), on: join(tmp(), "on") };
  for (const k of ["off", "on"]) assert.equal(run({ AR_STATE: states[k], ...(k === "on" ? { AR_ROZHODNUTIA: "1" } : {}) }, "s1").stdout, "");
  writeFileSync(join(wf.dir, "RULES.md"), "v2\n"); wf.commit("pravidlo");
  brain.rec(1); brain.commit("zaznam");
  const off = run({ AR_STATE: states.off }, "s1").stdout;
  assert.match(off, /v2/);
  assert.doesNotMatch(off, /D0001\.md/);
  const on = run({ AR_STATE: states.on, AR_ROZHODNUTIA: "1" }, "s1").stdout;
  assert.match(on, /v2/);
  assert.match(on, /D0001\.md/);
});
