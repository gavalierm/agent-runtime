// task_title.mjs: zamietne názov úlohy, ktorý pomenúva riešenie namiesto problému
// (úloha 587). Len reťazce a vstup hooku cez stdin, Tasker sa nevolá.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { taskTitleReason, titleReason, LISTS, POSTUP } from "./task_title.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "task_title.mjs");
const TK = "AGENT_NAME=adam /opt/agentic-workflow/bin/tk";
const run = (command) => {
  const out = execFileSync("node", [HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }) }).toString();
  return out ? JSON.parse(out).hookSpecificOutput : null;
};
const add = (title) => `${TK} task add --project agenti --assign boris --title ${JSON.stringify(title)} --body "x"`;

const BAD = [
  ["Nasadiť Tasker 276db3a (časy v Europe/Bratislava, úloha 578) do /opt/tasker", /pravidlo 1/],
  ["Agenti budú zadávať názvy správne", /pravidlo 6/],
  ["Hook: zadanie s novým mechanizmom bez overenia nástroja neprejde", /pravidlo 4/],
  ["Kontrola: beh neskončí bez hlásenia zlyhaného spoločného nástroja", /pravidlo 4/],
  ["Doctor Taskera: označiť poistky komentárom", /pravidlo 1/],
  ["Push a nasadenie Tasker 07385ba (úloha 551)", /pravidlo 3/],
  ["Zverejnenie repa example-org/agentic-workflow", /pravidlo 3/],
  ["Fix login", /pravidlo 5/],
  ["Oprav názvy úloh", /pravidlo 2/],
  ["pravidlo: názvy podľa problému", /pravidlo 4/],
];
const GOOD = [
  "Vlákno T3 vo full-access stálo 4 h na schválení príkazu Bash",
  "tasker block na úlohe v needs_human nezmení stav na blocked",
  "Commit v repe bez vlastného hooku obíde commit_guard",
  "Hook topic_task.mjs nezapíše úlohu, keď agent výstup task add prefiltruje rúrou",
  "Dispečer: slučka nebeží a nič to nezistí",
  "Tasker potrebuje paralelnu pracu",
  "Detail úlohy: riadky v poli Riešiteľ nalepené pod 6 px",
  "Agenti v Taskeri dávajú úlohám názvy podľa riešenia",
  "/opt/tasker beží bez 276db3a",
  "Pamäť agenta rastie bez limitu",
];

test("skutočné zlé názvy sa zamietnu v `task add`, hook dá Správny postup", () => {
  for (const [t, re] of BAD) {
    assert.match(taskTitleReason(add(t)) ?? "", re, t);
    const out = run(add(t));
    assert.equal(out.permissionDecision, "deny", t);
    assert.match(out.permissionDecisionReason, re, t);
    assert.ok(out.permissionDecisionReason.includes("env/server/CLAUDE.md"));
    assert.ok(out.permissionDecisionReason.includes("úloha 587"));
    assert.ok(out.permissionDecisionReason.includes("Správny postup:"));
  }
  assert.ok(POSTUP.includes("beží bez 276db3a"));
});

test("dobré názvy prejdú", () => {
  for (const t of GOOD) {
    assert.equal(taskTitleReason(add(t)), null, t);
    assert.equal(run(add(t)), null, t);
  }
});

test("task edit <id> --title a --title=", () => {
  assert.match(taskTitleReason(`${TK} task edit 5 --title "Nasadiť Tasker 276db3a"`), /task edit/);
  assert.ok(taskTitleReason(`tk task edit 5 --title="Nasadiť Tasker"`));
  assert.equal(taskTitleReason(`tk task edit 5 --title "/opt/tasker beží bez 276db3a"`), null);
  assert.equal(taskTitleReason(`tk task edit 5 --body "Nasadiť X"`), null);
});

test("tvary príkazu: tasker, cesta, premenné, sh -c, heredoc, súbor", () => {
  assert.ok(taskTitleReason(`tasker task add --project p --title "Zmazať logy"`));
  assert.ok(taskTitleReason(`/opt/agentic-workflow/bin/tk task add --project p --title 'Zmazať logy'`));
  assert.ok(taskTitleReason(`AGENT_NAME=adam TASKER_USER=adam /opt/agentic-workflow/bin/tk task add --project p --title="Zmazať logy"`));
  assert.ok(taskTitleReason(`cd /root && sh -c 'tk task add --project p --title "Zmazať logy"'`));
  assert.ok(taskTitleReason(`tk task add --project p --title "$(cat <<'EOF'\nZmazať logy\nEOF\n)"`));
  const read = (f) => (f === "/tmp/t.txt" ? "Nasadiť X" : null);
  assert.ok(taskTitleReason(`tk task add --project p --title "$(cat /tmp/t.txt)"`, read));
  assert.equal(taskTitleReason(`tk task add --project p --title "$T"`), null);
});

test("ostatné príkazy a telo/komentár sa neposudzujú", () => {
  for (const c of [
    "tk task show 5", `echo "Nasadiť"`, `tk comment 5 --body "Nasadiť X"`, "tk task list",
    `tk task add --project p --title "Beží bez X" --body "Nasadiť Tasker, budú zmeny"`,
    `grep -rn 'task add --title "Nasadiť"' .`,
  ]) {
    assert.equal(taskTitleReason(c), null, c);
    assert.equal(run(c), null, c);
  }
});

test("pravidlá po jednom, hranice slov", () => {
  for (const w of LISTS.imperative) assert.ok(titleReason(`${w} to`), w);
  for (const w of LISTS.actionNouns) assert.ok(titleReason(`${w} to`), w);
  for (const w of LISTS.english) assert.ok(titleReason(`${w} to`), w);
  for (const w of LISTS.future) assert.match(titleReason(`stav ${w.toUpperCase()} zlý`), /pravidlo 6/, w);
  for (const t of ["Zmeniť", "Označiť x", "zriadiť x", "POMÔCŤ x"]) assert.ok(titleReason(t), t);
  // podstatné mená na -sť, -äť a slová so zhodným začiatkom neprejdú falošne
  for (const t of ["Zvedavosť agenta", "Pamäť rastie", "Hrsť dát", "Opravy nie sú vidieť", "Budúci týždeň sa nič nedeje", "Prebudená relácia visí", "Úprava", ]) {
    if (t === "Úprava") assert.ok(titleReason(t)); else assert.equal(titleReason(t), null, t);
  }
});
