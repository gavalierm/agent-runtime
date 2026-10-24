import { test } from "node:test";
import assert from "node:assert/strict";
import { bridgeTrigger } from "../tasker_events.mjs";

const ev = (o) => ({ assignee: "boris", status: "todo", kind: "status", actor: "tasker", from_status: "blocked", to_status: "todo", ...o });

test("návrat do todo budí agenta", () => {
  assert.equal(bridgeTrigger(ev({}), "boris"), "todo");
});

test("uplynuté čakanie budí agenta", () => {
  assert.equal(bridgeTrigger(ev({ from_status: "waiting" }), "boris"), "todo");
});

test("tasker resume samotného agenta ho nebudí", () => {
  assert.equal(bridgeTrigger(ev({ from_status: "waiting", actor: "human:boris" }), "boris"), null);
});

test("resume od iného človeka agenta budí", () => {
  assert.equal(bridgeTrigger(ev({ from_status: "waiting", actor: "human:adam" }), "boris"), "todo");
});

test("prechod do waiting nebudí", () => {
  assert.equal(bridgeTrigger(ev({ status: "waiting", from_status: "todo", to_status: "waiting", actor: "human:boris" }), "boris"), null);
});

test("komentár iného autora na waiting úlohe budí", () => {
  assert.equal(bridgeTrigger(ev({ kind: "comment", status: "waiting", actor: "human:adam" }), "boris"), "comment");
});

test("vlastník mostu je v zozname agentov vždy", async () => {
  const { externalAgents } = await import("../tasker_events.mjs");
  assert.deepEqual(externalAgents({ AGENT_NAME: "adam", TASKER_EXTERNAL_AGENTS: "boris" }).map((a) => a.name), ["boris", "adam"]);
  assert.deepEqual(externalAgents({ AGENT_NAME: "adam" }).map((a) => a.name), ["adam"]);
});

test("komentár operátora na úlohe vlastníka mostu ho budí", () => {
  assert.equal(bridgeTrigger(ev({ assignee: "adam", kind: "comment", actor: "human:operator" }), "adam"), "comment");
});

test("úloha založená agentom pre seba ho nebudí", () => {
  assert.equal(bridgeTrigger(ev({ assignee: "adam", kind: "created", actor: "human:adam" }), "adam"), null);
});

test("koniec ohlásenej práce in_progress -> todo agenta nebudí (úloha 476, 24. 10. 2026)", () => {
  assert.equal(bridgeTrigger(ev({ from_status: "in_progress", actor: "tasker" }), "boris"), null);
  assert.equal(bridgeTrigger(ev({ from_status: "in_progress", actor: "human:boris" }), "boris"), null);
});

test("prechod do todo od samotného agenta ho nebudí, aj z needs_human (úloha 491, 24. 10. 2026)", async () => {
  assert.equal(bridgeTrigger(ev({ assignee: "adam", from_status: "needs_human", actor: "human:adam" }), "adam"), null);
  assert.equal(bridgeTrigger(ev({ assignee: "adam", from_status: "needs_human", actor: "human:operator" }), "adam"), "todo");
});

test("prechod do todo pri živej práci nebudí, komentár iného áno", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const { liveWork } = await import("../tasker_events.mjs");
  const db = new DatabaseSync(":memory:");
  assert.equal(liveWork(db, 491), false);
  db.exec("CREATE TABLE work (id INTEGER PRIMARY KEY, task_id INT, agent TEXT, thread TEXT, since INT, until INT, ended_at INT)");
  const now = Date.now();
  db.exec(`INSERT INTO work(task_id, agent, since, until) VALUES (491, 'x', ${now}, ${now + 60000}), (492, 'x', ${now}, ${now - 1}), (493, 'x', ${now}, ${now + 60000})`);
  db.exec("UPDATE work SET ended_at = 1 WHERE task_id = 493");
  assert.equal(liveWork(db, 491, now), true);
  assert.equal(liveWork(db, 492, now), false);
  assert.equal(liveWork(db, 493, now), false);
  assert.equal(bridgeTrigger(ev({ assignee: "adam", from_status: "needs_human", actor: "tasker" }), "adam", { liveWork: true }), null);
  assert.equal(bridgeTrigger(ev({ assignee: "adam", from_status: "needs_human", actor: "tasker" }), "adam", { liveWork: false }), "todo");
  assert.equal(bridgeTrigger(ev({ assignee: "adam", kind: "comment", actor: "human:operator" }), "adam", { liveWork: true }), "comment");
});

// Chyba 24. 10. 2026: úloha 491 po done blokéra 493 (blocked -> todo, actor
// tasker) nikoho nezobudila, lebo na nej visela ohlásená práca relácie, ktorá
// skončila čistým kontextom. Koniec blokovania budí vždy.
test("odblokovanie budí aj pri živej práci", () => {
  assert.equal(bridgeTrigger(ev({ assignee: "adam", from_status: "blocked", actor: "tasker" }), "adam", { liveWork: true }), "todo");
  assert.equal(bridgeTrigger(ev({ assignee: "adam", from_status: "blocked", actor: "human:adam" }), "adam", { liveWork: true }), null);
});
