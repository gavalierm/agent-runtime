// web_review.mjs: zamietne zadanie úlohy agentovi webu mimo uloha-webu.sh.
// web_gate.mjs: brána mockupu pri zakladaní úlohy webu. Zoznam agentov, `run`
// a `show` sú vstreknuté, test nevolá živý Tasker.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// Používateľ správcu úloh a dizajnér sa čítajú pri načítaní modulov.
process.env.AGENT_TASKER_USER = "tasker-svc";
process.env.WEB_DESIGNER = "eva";
const { webReviewReason, ASSIGN_MESSAGE, ASSIGN_POSTUP } = await import("./web_review.mjs");
const { parseAgents, isWebAgent, createWebTask, parseCreateArgs, mockupProblems } = await import("../lib/web_gate.mjs");

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "web_review.mjs");
const AGENTS = parseAgents("dan\tenabled\t/home/tasker-svc/projekty/webproject/webproject-web\neva\tenabled\t/home/tasker-svc/agenti/eva\nadam\tdisabled\t/root/adam\nwebclient-web\tenabled\t/x/webclient-web\n");
const T = "AGENT_NAME=adam /opt/agentic-workflow/bin/tk";
const noRun = () => { throw new Error("Tasker sa nemal volať"); };
const chk = (cmd) => webReviewReason(cmd, { agents: () => AGENTS });

test("task add pre agenta webu zamietne", () => {
  assert.equal(chk(`${T} task add --title x --assign webclient-web --project webclient`), ASSIGN_MESSAGE);
  assert.equal(chk(`tasker task add --title "dlhý názov; so stredníkom" --assign=dan --project k`), ASSIGN_MESSAGE);
  assert.equal(chk(`${T} task add --assign "clientsite-web" --title x --project s`), ASSIGN_MESSAGE);
  assert.equal(chk(`cd /x && sh -c '${T} task add --title x --assign dan --project k'`), ASSIGN_MESSAGE);
  assert.equal(chk(`id=$(${T} task add --assign webproject2-web --title x --project v)`), ASSIGN_MESSAGE);
  assert.equal(chk(`${T} task add --title x --body "$(cat <<'EOF'\nbody\nEOF\n)" --assign dan --project k`), ASSIGN_MESSAGE);
});

test("obal tk bez cesty a priamy tasker zamietne rovnako", () => {
  assert.equal(chk(`tk task add --title x --assign dan --project k`), ASSIGN_MESSAGE);
  assert.equal(chk(`AGENT_NAME=adam tk assign 5 dan`), ASSIGN_MESSAGE);
  assert.equal(chk(`runuser -u tasker-svc -- env TASKER_USER=adam tasker assign 5 dan`), ASSIGN_MESSAGE);
});

test("assign agentovi webu zamietne", () => {
  assert.equal(chk(`${T} assign 375 webclient-web`), ASSIGN_MESSAGE);
  assert.equal(chk(`tasker assign 5 dan`), ASSIGN_MESSAGE);
});

test("iný agent, uloha-webu.sh a text pustí", () => {
  assert.equal(chk(`${T} task add --title x --assign eva --project p`), null);
  assert.equal(chk(`${T} task add --title x --assign songbook --project p`), null);
  assert.equal(chk(`${T} assign 5 adam`), null);
  assert.equal(chk(`/opt/agentic-workflow/bin/uloha-webu.sh --project p --assign webclient-web --title x --body y`), null);
  assert.equal(chk(`${T} task add --title x --body "pozri tasker assign 5 dan" --assign eva --project p`), null);
  assert.equal(chk(`echo 'tasker task add --assign dan'`), null);
  assert.equal(chk(`grep -n "assign dan" tasker.log`), null);
  assert.equal(chk(`${T} task list --project webclient --json`), null);
  assert.equal(chk(`ask_agent.sh boris x <<'EOF'\ntasker assign 5 dan\nEOF`), null);
});

test("zoznam agentov nedostupný: platí pravidlo mena", () => {
  const o = { agents: () => null };
  assert.equal(webReviewReason(`tasker assign 5 xyz-web`, o), ASSIGN_MESSAGE);
  assert.equal(webReviewReason(`tasker assign 5 dan`, o), null);
});

test("tasker wait hook nezamietne", () => {
  assert.equal(chk(`${T} wait 373 --reason "čaká na Oskara"`), null);
  assert.equal(chk(`${T} wait 373 --reason x`), null);
});

test("hook ako proces: deny a prázdny výstup", () => {
  const run = (command) => execFileSync("node", [HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }) }).toString();
  const out = JSON.parse(run(`${T} task add --title x --assign webclient-web --project webclient`));
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, `${ASSIGN_MESSAGE}\nSprávny postup: ${ASSIGN_POSTUP}`);
  assert.equal(run("ls -la"), "");
  assert.equal(run("grep -n tasker x"), "");
});

// --- brána mockupu (lib/web_gate.mjs) ---

test("agent webu podľa mena aj workdiru", () => {
  assert.ok(isWebAgent("webclient-web", null));
  assert.ok(isWebAgent("dan", AGENTS));
  assert.ok(!isWebAgent("dan", null));
  assert.ok(!isWebAgent("eva", AGENTS));
});

const mockupTask = (over = {}) => ({ id: 77, assignee: "eva", status: "done", comments: [
  { id: 1, author: "eva", body: "Mockup: /home/tasker-svc/agenti/eva/mockupy/x/index.html" },
  { id: 2, author: "oskar", body: "Ďakujem.\nMockup schválený: áno" },
], ...over });
const base = { assign: "webclient-web", project: "p", title: "Nový dizajn", body: "Telo" };
const mk = (task) => {
  const calls = [];
  const shown = [];
  const run = (args) => { calls.push(args); return JSON.stringify({ id: 100 }); };
  const show = (id) => { shown.push(id); if (task instanceof Error) throw task; return task; };
  return { calls, shown, opts: { agents: AGENTS, run, show } };
};
const bodyOf = (call) => call[call.indexOf("--body") + 1];

test("--mockup s done úlohou niny a schválením od iného autora prejde", () => {
  const { calls, shown, opts } = mk(mockupTask());
  const r = createWebTask({ ...base, parent: "50", verify: "true", mockup: "77" }, opts);
  assert.deepEqual(r, { w: 100 });
  assert.deepEqual(shown, ["77"]);
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.deepEqual(c.slice(0, 2), ["task", "add"]);
  assert.equal(c[c.indexOf("--assign") + 1], "webclient-web");
  assert.equal(c[c.indexOf("--parent") + 1], "50");
  assert.ok(!c.includes("--blocked-by"));
  const b = bodyOf(c);
  assert.ok(b.startsWith("Telo\n\nImplementuj podľa mockupu z úlohy 77"));
  assert.match(b, /1440 a 390 px/);
  assert.match(b, /browser\.sh --gaps/);
  assert.match(b, /Pred prácou prečítaj dizajn manuál \/home\/tasker-svc\/agenti\/eva\/manualy\/web\.md/);
  assert.ok(!/Bez mockupu:/.test(b));
});

test("--mockup bez schválenia, so schválením od niny, cudzí riešiteľ, nie done zlyhá bez založenia úlohy", () => {
  const cases = [
    ["bez schválenia", mockupTask({ comments: [{ id: 1, author: "eva", body: "hotovo" }] }), /Mockup schválený/],
    ["bez komentárov", mockupTask({ comments: [] }), /Mockup schválený/],
    ["schválenie od niny", mockupTask({ comments: [{ id: 1, author: "eva", body: "Mockup schválený: áno" }] }), /Mockup schválený/],
    ["schválenie mimo začiatku riadku", mockupTask({ comments: [{ id: 1, author: "oskar", body: "nie je Mockup schválený: tu" }] }), /Mockup schválený/],
    ["iný riešiteľ", mockupTask({ assignee: "adam" }), /nemá riešiteľa eva/],
    ["nie done", mockupTask({ status: "in_progress" }), /nie je done/],
    ["úloha neexistuje", new Error("not found"), /nenačítala/],
  ];
  for (const [name, task, re] of cases) {
    const { calls, opts } = mk(task);
    assert.throws(() => createWebTask({ ...base, mockup: "77" }, opts), re, name);
    assert.equal(calls.length, 0, name);
  }
  assert.throws(() => createWebTask({ ...base, mockup: "abc" }, mk(mockupTask()).opts), /číslo úlohy/);
});

test("mockupProblems vráti všetky chyby naraz", () => {
  assert.equal(mockupProblems(7, () => mockupTask()).length, 0);
  assert.equal(mockupProblems(7, () => mockupTask({ assignee: "dan", status: "queued", comments: [] })).length, 3);
});

test("--bez-mockupu s dôvodom prejde a dôvod ide do tela", () => {
  const { calls, shown, opts } = mk(null);
  const r = createWebTask({ ...base, "bez-mockupu": "SEO: len meta popisy, vzhľad sa nemení" }, opts);
  assert.deepEqual(r, { w: 100 });
  assert.equal(shown.length, 0);
  assert.equal(calls.length, 1);
  const b = bodyOf(calls[0]);
  assert.match(b, /^Bez mockupu: SEO: len meta popisy, vzhľad sa nemení$/m);
  assert.ok(!/Implementuj podľa mockupu/.test(b));
  assert.match(b, /Pred prácou prečítaj dizajn manuál/);
});

test("--bez-mockupu s krátkym dôvodom zlyhá", () => {
  const { calls, opts } = mk(null);
  assert.throws(() => createWebTask({ ...base, "bez-mockupu": "SEO" }, opts), /aspoň 10 znakov/);
  assert.throws(() => createWebTask({ ...base, "bez-mockupu": "         x    " }, opts), /aspoň 10 znakov/);
  assert.equal(calls.length, 0);
});

test("obe voľby naraz a žiadna zlyhá", () => {
  const { calls, opts } = mk(mockupTask());
  assert.throws(() => createWebTask({ ...base, mockup: "77", "bez-mockupu": "dôvod dlhší ako desať" }, opts), /naraz/);
  assert.throws(() => createWebTask(base, opts), /chýba --mockup/);
  assert.equal(calls.length, 0);
});

test("uloha-webu: odmietne iného agenta ešte pred Taskerom", () => {
  assert.throws(() => createWebTask({ ...base, assign: "eva", mockup: "77" }, { agents: AGENTS, run: noRun, show: noRun }), /nie je agent webu/);
});

test("uloha-webu: voľby sa parsujú", () => {
  assert.throws(() => parseCreateArgs(["--project", "p", "--assign", "x-web", "--title", "t"]), /chýba --body/);
  assert.throws(() => parseCreateArgs(["--zle", "x"]), /neznáma/);
  assert.equal(parseCreateArgs(["--project=p", "--assign", "x-web", "--title", "t", "--body", "b", "--max-runs", "3", "--mockup", "9"]).mockup, "9");
  assert.equal(parseCreateArgs(["--project=p", "--assign", "x-web", "--title", "t", "--body", "b", "--bez-mockupu", "SEO bez zmeny vzhľadu"])["bez-mockupu"], "SEO bez zmeny vzhľadu");
});
