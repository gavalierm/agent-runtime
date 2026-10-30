// Sledovač čistého kontextu ostatných vlákien T3 proti falošnému T3 serveru.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync as mkdtempRaw, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeT3 } from "./fake_t3.mjs";
import { T3Client } from "../lib.mjs";
import { watchStep } from "../clear_watch.mjs";

// Dočasné priečinky testu sa na konci zmažú (úloha 701).
const tmpDirs = [];
const mkdtempSync = (prefix) => { const d = mkdtempRaw(prefix); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

async function setup(t) {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  const root = mkdtempSync(join(tmpdir(), "clear-watch-"));
  const state = join(root, "adam");
  const boris = join(root, "boris");
  mkdirSync(state); mkdirSync(boris);
  writeFileSync(join(state, "thread_id"), "thr-adam\n");
  writeFileSync(join(boris, "thread_id"), "thr-boris\n");
  const kontextDir = join(root, "kontext");
  mkdirSync(kontextDir);
  const cfg = { name: "adam", state, pollMs: 10, kontextDir };
  const client = new T3Client({ url: t3.url, token: t3.token, timeoutMs: 3000 });
  for (const id of ["thr-adam", "thr-boris", "thr-tema", "thr-ine"]) t3.addThread(id, { title: id });
  // Prvý priechod bez stavu len zapíše východisko.
  assert.equal((await watchStep(cfg, client))[0].action, "baseline");
  const work = async (id, reply) => {
    await client.dispatch({ type: "message.dispatch", commandId: "c-" + Math.random(), messageId: "m", createdBy: "user", creationSource: "web", threadId: id, text: "práca", attachments: [], dispatchMode: { type: "queue_after_active" } });
    t3.finishRun(id, { reply, usedTokens: 150001 });
  };
  const sent = (id) => t3.state.messages.filter((m) => m.threadId === id).map((m) => m.text);
  const clears = () => t3.state.messages.filter((m) => m.text === "/clear").map((m) => m.threadId);
  return { t3, cfg, client, work, sent, clears, state, kontextDir };
}

test("vlákno mimo thread_id so slovom dostane /clear, vlákna agentov a vlákno bez slova nie", async (t) => {
  const { t3, cfg, client, work, sent, clears } = await setup(t);
  await work("thr-tema", "Zapísal som pamäť.\n\nHOTOVO-KONTEXT\n");
  await work("thr-ine", "Hotovo, slovo HOTOVO-KONTEXT tu len citujem.");
  await work("thr-adam", "x\nHOTOVO-KONTEXT");
  await work("thr-boris", "x\nHOTOVO-KONTEXT");
  const r = await watchStep(cfg, client);
  assert.deepEqual(r.map((a) => [a.action, a.threadId]), [["cleared", "thr-tema"]]);
  assert.deepEqual(clears(), ["thr-tema"], "len vlákno témy");
  assert.deepEqual(sent("thr-tema"), ["práca", "/clear"], "holé slovo: len /clear");
  assert.equal(sent("thr-ine").length, 1, "vlákno bez slova na konci nedostane nič");
});

const KEY = "0123456789abcdef";
const handoff = (dir, over = {}) => writeFileSync(join(dir, "1a2b3c4d-0000-4000-8000-000000000001.json"), JSON.stringify({ key: KEY, rezim: "pokracuj", dalej: "dokončiť úlohu 9", stav: "s", cwd: "/x", at: "2026-10-23T10:00:00Z", ...over }));

test("pokracuj s platným kľúčom: /clear a správa s ďalším krokom, druhé použitie kľúča len /clear", async (t) => {
  const { t3, cfg, client, work, sent, kontextDir } = await setup(t);
  handoff(kontextDir);
  await work("thr-tema", `Hotovo.\nHOTOVO-KONTEXT pokracuj ${KEY}`);
  const r = await watchStep(cfg, client);
  assert.deepEqual(r.map((a) => a.action), ["cleared"]);
  assert.deepEqual(sent("thr-tema"), ["práca", "/clear", "[budič] Kontext vyčistený. Ďalší krok: dokončiť úlohu 9"]);
  t3.finishRun("thr-tema", { reply: "" });
  await watchStep(cfg, client);
  await work("thr-tema", `HOTOVO-KONTEXT pokracuj ${KEY}`);
  await watchStep(cfg, client);
  assert.equal(sent("thr-tema").filter((x) => /Ďalší krok/.test(x)).length, 1, "kľúč sa nepoužije druhý raz");
  assert.equal(sent("thr-tema").filter((x) => x === "/clear").length, 2);
});

test("pokracuj s neplatným kľúčom, spanok a citát: len /clear, resp. nič", async (t) => {
  const { t3, cfg, client, work, sent, kontextDir } = await setup(t);
  handoff(kontextDir, { key: "ffffffffffffffff" });
  await work("thr-tema", `HOTOVO-KONTEXT pokracuj ${KEY}`);
  await work("thr-ine", `Citát:\nHOTOVO-KONTEXT pokracuj ${KEY}\nkoniec`);
  await watchStep(cfg, client);
  assert.deepEqual(sent("thr-tema"), ["práca", "/clear"]);
  assert.deepEqual(sent("thr-ine"), ["práca"]);
  await work("thr-tema", `HOTOVO-KONTEXT spanok ${KEY}`);
  await watchStep(cfg, client);
  assert.deepEqual(sent("thr-tema").slice(2), ["práca", "/clear"]);
});

test("pád medzi /clear a správou pri pokracuj: pending sa dokončí s ďalším krokom a stabilnými commandId", async (t) => {
  const { t3, cfg, client, work, sent, state, clears } = await setup(t);
  await work("thr-tema", "x");
  const run = t3.state.threads.get("thr-tema").latestRunId;
  writeFileSync(join(state, "clear_watch.json"), JSON.stringify({ checked: {}, pending: { "thr-tema": { threadId: "thr-tema", runId: run, title: "t", tokens: 1, rezim: "pokracuj", dalej: "krok X" } } }));
  assert.equal((await watchStep(cfg, client))[0].resumed, true);
  assert.deepEqual(sent("thr-tema").slice(1), ["/clear", "[budič] Kontext vyčistený. Ďalší krok: krok X"]);
  writeFileSync(join(state, "clear_watch.json"), JSON.stringify({ checked: {}, pending: { "thr-tema": { threadId: "thr-tema", runId: run, title: "t", tokens: 1, rezim: "pokracuj", dalej: "krok X" } } }));
  await watchStep(cfg, client);
  assert.equal(sent("thr-tema").length, 3, "T3 commandId nezopakuje");
  assert.equal(clears().length, 1);
});

test("pád medzi /clear a koncom pri spanku: pending sa dokončí len /clear", async (t) => {
  const { t3, cfg, client, work, sent, state } = await setup(t);
  await work("thr-tema", "x");
  const run = t3.state.threads.get("thr-tema").latestRunId;
  writeFileSync(join(state, "clear_watch.json"), JSON.stringify({ checked: {}, pending: { "thr-tema": { threadId: "thr-tema", runId: run, title: "t", tokens: 1, rezim: "spanok", dalej: null } } }));
  await watchStep(cfg, client);
  assert.deepEqual(sent("thr-tema"), ["práca", "/clear"]);
});

test("opakovaný beh sledovača: druhý /clear nepríde, ani po strate stavu pending", async (t) => {
  const { t3, cfg, client, work, clears, state } = await setup(t);
  await work("thr-tema", "HOTOVO-KONTEXT");
  const run = t3.state.threads.get("thr-tema").latestRunId;
  await watchStep(cfg, client);
  // Beh /clear a pokračovania skončí riadne bez slova.
  t3.finishRun("thr-tema", { reply: "Pokračujem." });
  assert.deepEqual(await watchStep(cfg, client), []);
  assert.deepEqual(await watchStep(cfg, client), []);
  assert.deepEqual(clears(), ["thr-tema"], "jeden /clear");
  // Pád medzi /clear a pokračovaním: pending sa dokončí s tými istými commandId.
  writeFileSync(join(state, "clear_watch.json"), JSON.stringify({ checked: {}, pending: { "thr-tema": { threadId: "thr-tema", runId: run, title: "thr-tema", tokens: 1 } } }));
  const r = await watchStep(cfg, client);
  assert.equal(r[0].action, "cleared");
  assert.deepEqual(clears(), ["thr-tema"], "T3 commandId nezopakuje");
});

test("zaneprázdnené, archivované a nahradené vlákno agenta nedostane /clear, prvý štart nič nepošle", async (t) => {
  const { t3, cfg, client, work, clears, state } = await setup(t);
  await work("thr-tema", "HOTOVO-KONTEXT");
  t3.state.threads.get("thr-tema").pendingRuntimeRequest = { id: "x" };
  assert.deepEqual(await watchStep(cfg, client), [], "čaká na schválenie");
  t3.state.threads.get("thr-tema").pendingRuntimeRequest = null;
  t3.state.threads.get("thr-tema").archived = true;
  assert.deepEqual(await watchStep(cfg, client), [], "archivované");
  await work("thr-ine", "HOTOVO-KONTEXT");
  writeFileSync(join(state, "retired_threads"), "thr-ine\n");
  assert.deepEqual(await watchStep(cfg, client), [], "nahradené vlákno agenta");
  rmSync(join(state, "retired_threads"));
  rmSync(join(state, "clear_watch.json"));
  assert.equal((await watchStep(cfg, client))[0].action, "baseline");
  assert.deepEqual(await watchStep(cfg, client), [], "po východisku staré slovo nič nespustí");
  assert.deepEqual(clears(), []);
});

// Stojaci beh vo vlákne témy (úloha 419): beh má len notifikáciu starú 52 min.
test("vlákno témy so stojacim behom dostane run.interrupt raz, s položkou running nie", async (t) => {
  const { t3, cfg, client } = await setup(t);
  const stall = async (id, items) => {
    await client.dispatch({ type: "message.dispatch", commandId: "c-" + id, messageId: "m-" + id, createdBy: "user", creationSource: "web", threadId: id, text: "práca", attachments: [], dispatchMode: { type: "queue_after_active" } });
    const th = t3.state.threads.get(id);
    const at = new Date(Date.now() - 52 * 60_000).toISOString();
    th._turnItems.push(...items.map((i, n) => ({ id: `${id}-${n}`, runId: th.activeRunId, updatedAt: at, ...i })));
    return th;
  };
  const th = await stall("thr-tema", [{ type: "notification", status: "completed" }]);
  const sub = await stall("thr-ine", [{ type: "notification", status: "completed" }, { type: "command_execution", status: "running" }]);
  const runId = th.activeRunId;
  const alertFile = join(cfg.state, "alerts.txt");
  cfg.stalledMs = 10 * 60_000;
  cfg.alertCmd = `cat >> '${alertFile}'`;
  const r = await watchStep(cfg, client);
  assert.deepEqual(r.map((a) => [a.action, a.threadId, a.runId]), [["interrupt-stalled", "thr-tema", runId]]);
  assert.ok(th._turnItems.some((i) => i.type === "run_interrupt_request" && i.runId === runId));
  assert.ok(!sub._turnItems.some((i) => i.type === "run_interrupt_request"), "sub-agent beží");
  assert.deepEqual(await watchStep(cfg, client), [], "raz na beh");
  assert.equal(t3.state.commands.filter((c) => c.type === "run.interrupt").length, 1);
  assert.match(readFileSync(alertFile, "utf8"), /thr-tema/);
});
