// Hook idle_wake.mjs: zbytočné zobudenie zo schránky sa zapíše ako úloha.
// Falošný tk zapisuje argumenty do súboru, stav je v mkdtemp, živý Tasker
// ani schránka sa nedotknú. Replay: zobudenia 24. 10. 2026
// tasker-20261024-215628-486.md a tasker-20261024-215807-1927321-350064f5.md.
import "../lib/git_isolate.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readOnlyCommand, detect, inboxMessages } from "../hooks/idle_wake.mjs";
import { bridgeTrigger } from "../tasker_events.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "../hooks/idle_wake.mjs");
const M1 = "tasker-20261024-215628-486.md";
const M2 = "tasker-20261024-215807-1927321-350064f5.md";
const prompt = (id, mode = "nečakám") => ({ type: "user", message: { role: "user", content: `<schranka od="tasker" id="${id}" odpoveď="${mode}">\nodpoveď netreba\n\nTasker: úloha #486 skúška trasy.\n</schranka>` } });
const call = (name, input) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name, input }] } });
const result = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } };
const lines = (...e) => e.map((x) => JSON.stringify(x));

function sandbox(entries) {
  const dir = mkdtempSync(join(tmpdir(), "idle_wake-"));
  const log = join(dir, "tk.log");
  const fake = join(dir, "tk");
  writeFileSync(fake, `#!/bin/sh\necho "$AGENT_NAME|$TASKER_USER|$*" >> "${log}"\necho 600\n`);
  chmodSync(fake, 0o755);
  const tr = join(dir, "t.jsonl");
  writeFileSync(tr, lines(...entries).join("\n") + "\n");
  const run = () => spawnSync("node", [HOOK], { input: JSON.stringify({ session_id: "S1", transcript_path: tr, cwd: dir }), env: { PATH: process.env.PATH, HOME: dir, AGENT_NAME: "adam", IDLE_WAKE_TK: fake, IDLE_WAKE_STATE: join(dir, "state") }, encoding: "utf8" });
  const full = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
  return { run, full, calls: () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("adam|adam|")) : []) };
}

test("readOnlyCommand: čítanie áno, zápis nie", () => {
  for (const c of ["ls /var/lib/adam", "AGENT_NAME=adam /opt/agent-rules/bin/tk task show 486 --json", "git status --short && git log --oneline -3", "grep -n x f | head", "sed -n 1,5p f"]) assert.equal(readOnlyCommand(c), true, c);
  for (const c of ["tk comment 486 --body x", "git commit -m x -- f", "echo a > f", "sed -i s/a/b/ f", "/root/agent-runtime/reply.sh id", "node --test test/", "tk done 5 --summary x", "rm f"]) assert.equal(readOnlyCommand(c), false, c);
});

test("inboxMessages: tasker správa áno, na vedomie a slovo operátora nie", () => {
  assert.deepEqual(inboxMessages(prompt(M1).message.content).map((m) => m.id), [M1]);
  assert.deepEqual(inboxMessages(prompt(M1, "na vedomie").message.content), []);
  assert.deepEqual(inboxMessages("nazdar, pozri úlohu 5"), []);
});

for (const id of [M1, M2]) {
  test(`replay ${id}: ťah len s čítaním založí úlohu agenti/adam s id správy a vláknom`, () => {
    const s = sandbox([prompt(id), call("Bash", { command: "AGENT_NAME=adam /opt/agent-rules/bin/tk task show 486 --json" }), result, call("Bash", { command: "git status --short" }), result]);
    const r = s.run();
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
    const c = s.calls();
    assert.equal(c.length, 1);
    assert.match(c[0], /^adam\|adam\|task add --project agenti --assign adam --title Zbytočné zobudenie: /);
    assert.ok(s.full().includes(`Správa: ${id}`));
    assert.ok(s.full().includes("Vlákno (relácia claude): S1"));
    // druhý Stop tej istej správy úlohu nezopakuje
    s.run();
    assert.equal(s.calls().length, 1);
  });
}

test("ťah so zápisom (komentár, Edit, sub-agent) alebo bez správy schránky úlohu nezaloží", () => {
  for (const entries of [
    [prompt(M1), call("Bash", { command: "tk comment 486 --body hotovo" })],
    [prompt(M1), call("Edit", { file_path: "/x" })],
    [prompt(M1), call("Agent", { prompt: "úloha 486" })],
    [prompt(M1, "na vedomie")],
    [{ type: "user", message: { role: "user", content: "slovo operátora" } }],
    [prompt(M1), call("Bash", { command: "ls" }), { type: "user", message: { role: "user", content: "slovo operátora" } }],
  ]) {
    const s = sandbox(entries);
    s.run();
    assert.deepEqual(s.calls(), []);
  }
});

test("detect: výzva nasledujúca po tool_result sa nepovažuje za novú, nástroje pred správou sa nepočítajú", () => {
  assert.equal(detect(lines(call("Bash", { command: "tk done 1" }), prompt(M1), call("Bash", { command: "ls" }), result)).msgs.length, 1);
});

test("hlásenie nezobudí agenta: úloha založená agentom pre seba (created, assigned) nespustí most", () => {
  const ev = (o) => ({ assignee: "adam", status: "handoff", actor: "human:adam", ...o });
  assert.equal(bridgeTrigger(ev({ kind: "created" }), "adam"), null);
  assert.equal(bridgeTrigger(ev({ kind: "assigned", detail: "adam" }), "adam"), null);
});

test("chyba hooku: kód 0, bez výstupu", () => {
  const r = spawnSync("node", [HOOK], { input: "nie json", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
