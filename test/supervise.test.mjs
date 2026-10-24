// Dozor a čistý kontext budiča proti falošnému T3 serveru.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeT3 } from "./fake_t3.mjs";
import { config, T3Client } from "../lib.mjs";
import { tick } from "../driver.mjs";
import { DONE_WORD } from "../supervise.mjs";

// Odovzdávka, akú zapíše kontext.sh (repo agent-rules, lib/kontext.mjs).
function handoff(dir, key, over = {}) {
  writeFileSync(join(dir, `1a2b3c4d-0000-4000-8000-${key.padEnd(12, "0").slice(0, 12)}.json`), JSON.stringify({ key, rezim: "pokracuj", dalej: "dokončiť úlohu 7", stav: "pamäť zapísaná", cwd: "/x", at: "2026-10-23T10:00:00Z", ...over }));
}
const KEY = "0123456789abcdef";

const MIN = 60_000;

async function setup(t, extraCfg = {}) {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  const root = mkdtempSync(join(tmpdir(), "agent-sup-"));
  const box = join(root, "box");
  for (const d of ["inbox", "outbox", "processed"]) mkdirSync(join(box, d), { recursive: true });
  const state = join(root, "state");
  mkdirSync(state);
  writeFileSync(join(state, "thread_id"), "thr-adam\n");
  const alertFile = join(root, "alerts.txt");
  const kontextDir = join(root, "kontext");
  mkdirSync(kontextDir);
  const cfg = {
    kontextDir,
    name: "adam", title: "Adam", box, state, t3Url: t3.url, pollMs: 10, replyCmd: "runtime/reply.sh",
    wakeMax: 3, wakeWindowMs: 60 * MIN, wakeDelayMs: MIN, wakeOnInterrupt: true, limitGraceMs: 2 * MIN,
    alertCmd: `cat >> '${alertFile}'`,
    // Testy píšu správy s aktuálnym časom, tiché okno dávky je vypnuté.
    batchWaitMs: 0,
    ...extraCfg,
  };
  const client = new T3Client({ url: t3.url, token: t3.token, timeoutMs: 3000 });
  t3.addThread("thr-adam");
  const put = (name, text) => writeFileSync(join(box, "inbox", name), text);
  const threadId = () => readFileSync(join(state, "thread_id"), "utf8").trim();
  const sent = (id) => t3.state.messages.filter((m) => m.threadId === id);
  return { t3, cfg, client, box, state, put, alertFile, threadId, sent, kontextDir };
}

// Beh vo vlákne, ktorý skončí podľa opts. Vráti čas konca.
async function runThenEnd(t3, cfg, client, opts) {
  const id = "thr-adam";
  await client.dispatch({ type: "message.dispatch", commandId: "c-" + Math.random(), messageId: "m", createdBy: "user", creationSource: "web", threadId: id, text: "práca", attachments: [], dispatchMode: { type: "queue_after_active" } });
  const end = Date.now();
  t3.finishRun(id, { completedAt: new Date(end).toISOString(), ...opts });
  return end;
}

test("pád behu (zabitý proces claude, transport_error): po odstupe raz zobudí, schránka čaká", async (t) => {
  const { t3, cfg, client, put, sent } = await setup(t);
  const end = await runThenEnd(t3, cfg, client, { status: "failed", errorClass: "transport_error", error: "Claude process exited" });
  put("cyril-20261018-120000-1.md", "správa");
  const early = await tick(cfg, client, { now: end + 10_000 });
  assert.equal(early.sent, 0);
  assert.match(early.reason, /spadol .*budím o/);
  assert.equal(sent("thr-adam").length, 1, "len pôvodná práca");
  const r = await tick(cfg, client, { now: end + MIN + 1 });
  assert.equal(r.action, "wake");
  const wake = sent("thr-adam").at(-1);
  assert.match(wake.text, /neskončil riadne \(stav failed, chyba: transport_error/);
  assert.match(wake.text, /Pokračuj v rozpracovanej práci podľa pamäte/);
  // Ďalší priechod ten istý pád nebudí znova, beh pokračovania beží.
  assert.match((await tick(cfg, client, { now: end + 2 * MIN })).reason, /beží/);
  // Po riadnom konci pokračovania ide schránka.
  t3.finishRun("thr-adam", { usedTokens: 1000 });
  assert.equal((await tick(cfg, client, { now: end + 3 * MIN })).sent, 1);
});

test("reštart T3 servera počas behu (cancelled) aj reštart budiča: beh sa obnoví", async (t) => {
  const { t3, cfg, client, sent } = await setup(t);
  await client.dispatch({ type: "message.dispatch", commandId: "c1", messageId: "m", createdBy: "user", creationSource: "web", threadId: "thr-adam", text: "práca", attachments: [], dispatchMode: { type: "queue_after_active" } });
  assert.equal((await tick(cfg, client)).sent, 0);
  t3.restartServer("thr-adam");
  const end = Date.parse(t3.state.threads.get("thr-adam").latestRunCompletedAt);
  // Nový proces budiča: nový klient, stav len z disku.
  const client2 = new T3Client({ url: t3.url, token: t3.token, timeoutMs: 3000 });
  assert.match((await tick(cfg, client2, { now: end + 1000 })).reason, /cancelled\), budím/);
  const r = await tick(cfg, client2, { now: end + MIN + 1 });
  assert.equal(r.action, "wake");
  assert.match(sent("thr-adam").at(-1).text, /stav cancelled/);
});

test("limit opakovaní: tri zobudenia za hodinu s rastúcim odstupom, štvrtý pád výstraha a ďalej nebudí", async (t) => {
  const { t3, cfg, client, sent, alertFile, state } = await setup(t);
  const iso = (ms) => new Date(ms).toISOString();
  let now = Date.now();
  await runThenEnd(t3, cfg, client, { status: "failed", errorClass: "provider_error", error: "boom", completedAt: iso(now) });
  const wakes = [];
  for (let i = 0; i < 3; i++) {
    const delay = cfg.wakeDelayMs * 2 ** i;
    assert.match((await tick(cfg, client, { now: now + delay - 1000 })).reason ?? "", /budím o/, `odstup ${i}`);
    now += delay + 1;
    const r = await tick(cfg, client, { now });
    assert.equal(r.action, "wake", `zobudenie ${i + 1}`);
    wakes.push(r);
    now += 1000;
    // Pokračovanie znova spadne.
    t3.finishRun("thr-adam", { status: "failed", errorClass: "provider_error", error: "znova", completedAt: iso(now) });
  }
  const halt = await tick(cfg, client, { now: now + 10 * MIN });
  assert.equal(halt.action, "halt");
  assert.equal(wakes.length, 3);
  const before = sent("thr-adam").length;
  assert.equal((await tick(cfg, client, { now: now + 20 * MIN })).sent, 0);
  assert.equal(sent("thr-adam").length, before, "po výstrahe nebudí");
  assert.match(readFileSync(alertFile, "utf8"), /Budič ďalej nebudí/);
  assert.match(readFileSync(join(state, "alerts.log"), "utf8"), /Budič ďalej nebudí/);
  // Riadny beh (napríklad operátor napísal do vlákna) dozor znova zapne.
  await runThenEnd(t3, cfg, client, { status: "completed", usedTokens: 10 });
  await tick(cfg, client, { now: now + 30 * MIN });
  assert.equal(JSON.parse(readFileSync(join(state, "supervise.json"), "utf8")).halted, false);
});

test("limit predplatného nebudí, čaká na reset, potom raz pokračuje mimo počtu pádov", async (t) => {
  const { t3, cfg, client, put, sent, state } = await setup(t);
  const reset = Date.now() + 60 * MIN;
  const end = await runThenEnd(t3, cfg, client, { status: "failed", errorClass: "usage_limit", error: "limit", resetAt: new Date(reset).toISOString() });
  put("cyril-20261018-120000-1.md", "správa");
  for (const at of [end + MIN, end + 30 * MIN, reset - 1]) {
    const r = await tick(cfg, client, { now: at });
    assert.equal(r.sent, 0);
    assert.match(r.reason, /limit predplatného do/);
  }
  assert.match((await tick(cfg, client, { now: reset + MIN })).reason, /čakám, či T3 pokračuje sám/);
  assert.equal(sent("thr-adam").length, 1);
  const r = await tick(cfg, client, { now: reset + 3 * MIN });
  assert.equal(r.action, "limit");
  assert.match(sent("thr-adam").at(-1).text, /Limit predplatného skončil/);
  assert.deepEqual(JSON.parse(readFileSync(join(state, "supervise.json"), "utf8")).wakes, []);
  assert.equal(existsSync(join(state, "alerts.log")), false);
});

test("Stop človeka (run_interrupt_request) nebudí, prerušenie bez žiadosti budí", async (t) => {
  const { t3, cfg, client, sent } = await setup(t);
  await client.dispatch({ type: "message.dispatch", commandId: "c1", messageId: "m", createdBy: "user", creationSource: "web", threadId: "thr-adam", text: "x", attachments: [], dispatchMode: { type: "queue_after_active" } });
  await client.dispatch({ type: "run.interrupt", commandId: "stop1", threadId: "thr-adam", runId: t3.state.threads.get("thr-adam").activeRunId, reason: "Stop" });
  const n = sent("thr-adam").length;
  assert.equal((await tick(cfg, client, { now: Date.now() + 10 * MIN })).reason, "prázdna schránka");
  assert.equal(sent("thr-adam").length, n);
  const end = await runThenEnd(t3, cfg, client, { status: "interrupted" });
  assert.equal((await tick(cfg, client, { now: end + 2 * MIN })).action, "wake");
});

const clears = (t3) => t3.state.commands.filter((c) => c.type === "message.dispatch" && /^\s*\/clear\b/.test(c.text));
const detaches = (t3) => t3.state.commands.filter((c) => c.type === "provider-session.detach");

test("holé HOTOVO-KONTEXT: len /clear v tom istom vlákne, žiadna správa, model sa nevolá, správa zo schránky ide až po prechode", async (t) => {
  const { t3, cfg, client, put, sent, threadId, box, state } = await setup(t);
  const end = await runThenEnd(t3, cfg, client, { status: "completed", usedTokens: 150001, reply: `Uložené, commit abc.\n\n${DONE_WORD}` });
  put("boris-20261018-120000-1.md", "disk plný");
  const c = await tick(cfg, client, { now: end + 1000 });
  assert.equal(c.action, "cleared");
  assert.equal(threadId(), "thr-adam", "vlákno ostáva");
  assert.equal(t3.state.launches.length, 0, "nové vlákno nevzniklo");
  assert.deepEqual(detaches(t3), [], "relácia sa pri /clear nezastavuje");
  assert.deepEqual(sent("thr-adam").map((m) => m.text), ["práca", "/clear"], "práca a /clear, nič viac");
  assert.equal(existsSync(join(state, "rotation.json")), false);
  // /clear vlákno spracúva, schránka čaká, potom ide doň.
  assert.match((await tick(cfg, client, { now: end + 2000 })).reason, /beží/);
  t3.finishRun("thr-adam", { reply: "", usedTokens: 20000 });
  const d = await tick(cfg, client, { now: end + 3000 });
  assert.equal(d.sent, 1);
  assert.match(sent("thr-adam").at(-1).text, /disk plný/);
  assert.deepEqual(readdirSync(join(box, "processed")), ["boris-20261018-120000-1.md"]);
  assert.equal(clears(t3).length, 1, "jeden /clear");
});

test("spanok s kľúčom: len /clear, odovzdávka ostane pre hook", async (t) => {
  const { t3, cfg, client, sent, kontextDir } = await setup(t);
  handoff(kontextDir, KEY, { rezim: "spanok", dalej: null });
  const end = await runThenEnd(t3, cfg, client, { status: "completed", reply: `Hotovo.\n${DONE_WORD} spanok ${KEY}\n` });
  assert.equal((await tick(cfg, client, { now: end + 1000 })).action, "cleared");
  assert.deepEqual(sent("thr-adam").map((m) => m.text), ["práca", "/clear"]);
  assert.equal(readdirSync(kontextDir).length, 1, "súbor odovzdávky ostal");
});

test("pokracuj s platným kľúčom: /clear a jedna správa s ďalším krokom, bez pokynu čítať pamäť", async (t) => {
  const { t3, cfg, client, sent, kontextDir, state } = await setup(t);
  handoff(kontextDir, KEY);
  const end = await runThenEnd(t3, cfg, client, { status: "completed", usedTokens: 150001, reply: `Hotovo.\n${DONE_WORD} pokracuj ${KEY}` });
  assert.equal((await tick(cfg, client, { now: end + 1000 })).action, "cleared");
  const msgs = sent("thr-adam").map((m) => m.text);
  assert.equal(msgs.length, 3);
  assert.equal(msgs[1], "/clear");
  assert.match(msgs[2], /^\[budič\] Kontext vyčistený\. Ďalší krok: dokončiť úlohu 7$/);
  assert.doesNotMatch(msgs[2], /PERSONA|CLAUDE\.md|pamäť|Si Adam/);
  assert.equal(existsSync(join(state, "rotation.json")), false);
  const file = readdirSync(kontextDir)[0];
  assert.equal(JSON.parse(readFileSync(join(kontextDir, file), "utf8")).consumed, true, "kľúč spotrebovaný");
});

test("pokracuj s kľúčom, ktorý nikto nezapísal: len /clear a výstraha", async (t) => {
  const { t3, cfg, client, sent, alertFile } = await setup(t);
  const end = await runThenEnd(t3, cfg, client, { status: "completed", reply: `Hotovo.\n${DONE_WORD} pokracuj ${KEY}` });
  assert.equal((await tick(cfg, client, { now: end + 1000 })).action, "cleared");
  assert.deepEqual(sent("thr-adam").map((m) => m.text), ["práca", "/clear"]);
  assert.match(readFileSync(alertFile, "utf8"), /pokracuj bez platného kľúča/);
});

test("pokracuj bez kľúča alebo odovzdávka bez ďalšieho kroku: len /clear a výstraha", async (t) => {
  const { t3, cfg, client, sent, alertFile, kontextDir } = await setup(t);
  let end = await runThenEnd(t3, cfg, client, { status: "completed", reply: `${DONE_WORD} pokracuj` });
  assert.equal((await tick(cfg, client, { now: end + 1000 })).action, "cleared");
  t3.finishRun("thr-adam", { reply: "", usedTokens: 1 });
  handoff(kontextDir, KEY, { rezim: "spanok", dalej: null });
  end = await runThenEnd(t3, cfg, client, { status: "completed", reply: `${DONE_WORD} pokracuj ${KEY}` });
  assert.equal((await tick(cfg, client, { now: end + 1000 })).action, "cleared");
  assert.equal(sent("thr-adam").filter((m) => m.text !== "/clear" && m.text !== "práca").length, 0);
  assert.equal(readFileSync(alertFile, "utf8").trim().split("\n").length, 2);
});

test("druhé použitie toho istého kľúča nič nespustí okrem /clear a výstrahy", async (t) => {
  const { t3, cfg, client, sent, alertFile, kontextDir } = await setup(t);
  handoff(kontextDir, KEY);
  let end = await runThenEnd(t3, cfg, client, { status: "completed", reply: `${DONE_WORD} pokracuj ${KEY}` });
  await tick(cfg, client, { now: end + 1000 });
  t3.finishRun("thr-adam", { reply: "", usedTokens: 1 });
  await tick(cfg, client, { now: end + 2000 });
  end = await runThenEnd(t3, cfg, client, { status: "completed", reply: `${DONE_WORD} pokracuj ${KEY}` });
  await tick(cfg, client, { now: end + 1000 });
  const steps = sent("thr-adam").map((m) => m.text).filter((x) => /Ďalší krok/.test(x));
  assert.equal(steps.length, 1, "správa s krokom len raz");
  assert.match(readFileSync(alertFile, "utf8"), /bez platného kľúča/);
});

test("citát pokracuj riadku uprostred textu nič nespustí", async (t) => {
  const { t3, cfg, client, sent, kontextDir } = await setup(t);
  handoff(kontextDir, KEY);
  const end = await runThenEnd(t3, cfg, client, { status: "completed", usedTokens: 300000, reply: `Riadok vyzerá takto:\n${DONE_WORD} pokracuj ${KEY}\nA to je všetko.` });
  assert.equal((await tick(cfg, client, { now: end })).reason, "prázdna schránka");
  assert.equal(sent("thr-adam").length, 1);
  assert.equal(JSON.parse(readFileSync(join(kontextDir, readdirSync(kontextDir)[0]), "utf8")).consumed, undefined);
});

test("riadok HOTOVO-KONTEXT s cudzím druhým slovom nič nespustí", async (t) => {
  const { t3, cfg, client, sent } = await setup(t);
  const end = await runThenEnd(t3, cfg, client, { status: "completed", reply: `${DONE_WORD} je slovo pre budič` });
  assert.equal((await tick(cfg, client, { now: end })).reason, "prázdna schránka");
  assert.equal(sent("thr-adam").length, 1);
});

test("reštart budiča počas /clear: rovnaké commandId, druhý /clear nevznikne", async (t) => {
  const { t3, cfg, client, threadId, state } = await setup(t);
  writeFileSync(join(state, "rotation.json"), JSON.stringify({ phase: "clear", oldThreadId: "thr-adam", fromRunId: "run-9", tokens: 170000, projectId: "p1", runtimeMode: "auto", interactionMode: "default" }));
  const r = await tick(cfg, client);
  assert.equal(r.action, "cleared");
  assert.equal(threadId(), "thr-adam");
  const ids = clears(t3).map((c) => c.commandId);
  writeFileSync(join(state, "rotation.json"), JSON.stringify({ phase: "clear", oldThreadId: "thr-adam", fromRunId: "run-9", tokens: 170000 }));
  await tick(cfg, new T3Client({ url: t3.url, token: t3.token, timeoutMs: 3000 }));
  assert.deepEqual([...new Set(clears(t3).map((c) => c.commandId))], ids, "to isté commandId");
  assert.equal(t3.state.launches.length, 0);
});

test("veľký kontext bez slova ani slovo uprostred textu čistý kontext nespustí", async (t) => {
  const { t3, cfg, client, sent } = await setup(t);
  const end = await runThenEnd(t3, cfg, client, { status: "completed", usedTokens: 300000, reply: `Budič čaká na ${DONE_WORD}, preto ho dávam.\nHotovo.` });
  assert.equal((await tick(cfg, client, { now: end })).reason, "prázdna schránka");
  assert.equal(sent("thr-adam").length, 1, "len pôvodná práca");
});

test("T3 odmietne /clear: náhradou nové vlákno s dátumom, reštart budiča nezaloží druhé", async (t) => {
  const { t3, cfg, client, threadId, put, sent, state, alertFile } = await setup(t);
  const end = await runThenEnd(t3, cfg, client, { status: "completed", usedTokens: 160000, reply: DONE_WORD });
  put("teo-20261018-120000-1.md", "počas prechodu");
  t3.state.rejectNext = 1;
  t3.state.dropLaunchAfterAccept = 1;
  await assert.rejects(tick(cfg, client, { now: end + 1000 }));
  assert.match(readFileSync(alertFile, "utf8"), /odmietol \/clear/);
  assert.equal(JSON.parse(readFileSync(join(state, "rotation.json"), "utf8")).phase, "launch");
  assert.equal(threadId(), "thr-adam");
  // Nový proces budiča.
  const client2 = new T3Client({ url: t3.url, token: t3.token, timeoutMs: 3000 });
  const r = await tick(cfg, client2, { now: end + 2000 });
  assert.equal(r.action, "rotated");
  assert.equal(t3.state.launchReceipts.size, 1, "jedno nové vlákno");
  assert.equal(threadId(), r.threadId);
  assert.equal(readFileSync(join(state, "retired_threads"), "utf8"), "thr-adam\n", "staré vlákno pre sledovač ostatných vlákien");
  const launch = t3.state.launches.at(-1);
  assert.match(launch.title, /^Adam \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.match(launch.initialMessage.text, /Si Adam\./);
  assert.match(launch.initialMessage.text, /nahradilo vlákno thr-adam, ktoré malo 160000 tokenov kontextu, na slovo HOTOVO-KONTEXT, lebo T3 odmietol \/clear/);
  assert.match(launch.initialMessage.text, /Nič nerozpracované, čakaj na ďalšiu správu\.$/);
  t3.finishRun(r.threadId, { reply: "Bežím." });
  assert.equal((await tick(cfg, client2, { now: end + 3000 })).sent, 1);
  assert.match(sent(r.threadId)[0].text, /počas prechodu/);
});

test("T3 odmietne /clear pri pokracuj: úvodná správa nového vlákna nesie stav a ďalší krok, pri spanku nie", async (t) => {
  const { t3, cfg, client, kontextDir } = await setup(t);
  handoff(kontextDir, KEY);
  const end = await runThenEnd(t3, cfg, client, { status: "completed", usedTokens: 160000, reply: `${DONE_WORD} pokracuj ${KEY}` });
  t3.state.rejectNext = 1;
  const r = await tick(cfg, client, { now: end + 1000 });
  assert.equal(r.action, "rotated");
  const text = t3.state.launches.at(-1).initialMessage.text;
  assert.match(text, /Si Adam\./);
  assert.match(text, /\nStav: pamäť zapísaná\n/);
  assert.match(text, /\nĎalší krok: dokončiť úlohu 7$/);
});

test("reštart budiča medzi zápisom thread_id a zmazaním rotation.json: prechod sa nezopakuje", async (t) => {
  const { t3, cfg, client, state } = await setup(t);
  t3.addThread("thr-new");
  writeFileSync(join(state, "thread_id"), "thr-new\n");
  writeFileSync(join(state, "rotation.json"), JSON.stringify({ phase: "launch", oldThreadId: "thr-adam", fromRunId: "run-1" }));
  assert.equal((await tick(cfg, client)).reason, "prázdna schránka");
  assert.equal(existsSync(join(state, "rotation.json")), false);
  assert.equal(t3.state.launches.length, 0);
});

test("po náhradnom prechode budič zastaví reláciu starého vlákna, nové vlákno a vlákno nechá", async (t) => {
  const { t3, cfg, client } = await setup(t);
  const end = await runThenEnd(t3, cfg, client, { status: "completed", usedTokens: 150001, reply: DONE_WORD });
  t3.state.rejectNext = 1;
  const r = await tick(cfg, client, { now: end + 1000 });
  assert.equal(r.action, "rotated");
  assert.deepEqual(detaches(t3).map((c) => [c.threadId, c.providerSessionId, c.reason]), [["thr-adam", "ps-thr-adam", "client-requested"]]);
  const old = t3.state.threads.get("thr-adam");
  assert.equal(old._providerSessions[0].status, "stopped");
  assert.equal(old.archived, false, "staré vlákno ostane na čítanie");
  assert.equal(t3.state.threads.get(r.threadId)._providerSessions[0].status, "ready");
  assert.equal(t3.state.commands.filter((c) => c.type === "thread.archive").length, 0);
});

test("zlyhanie zastavenia relácie prechod nezablokuje, ide do alerts.log", async (t) => {
  const { t3, cfg, client, state, threadId, put, sent } = await setup(t);
  const end = await runThenEnd(t3, cfg, client, { status: "completed", usedTokens: 150001, reply: DONE_WORD });
  t3.state.rejectNext = 1;
  t3.state.rejectDetach = 1;
  put("boris-20261018-120000-1.md", "po prechode");
  const r = await tick(cfg, client, { now: end + 1000 });
  assert.equal(r.action, "rotated");
  assert.equal(threadId(), r.threadId);
  assert.equal(existsSync(join(state, "rotation.json")), false);
  assert.match(readFileSync(join(state, "alerts.log"), "utf8"), /zastavenie relácie starého vlákna thr-adam zlyhalo/);
  t3.finishRun(r.threadId, { reply: "Bežím." });
  assert.equal((await tick(cfg, client, { now: end + 2000 })).sent, 1);
  assert.match(sent(r.threadId).at(-1).text, /po prechode/);
});

test("staré vlákno s bežiacim ťahom (písal doň človek): reláciu nezastaví, výstraha", async (t) => {
  const { t3, cfg, client, state, threadId } = await setup(t);
  await client.dispatch({ type: "message.dispatch", commandId: "c-human", messageId: "m", createdBy: "user", creationSource: "web", threadId: "thr-adam", text: "otázka", attachments: [], dispatchMode: { type: "queue_after_active" } });
  writeFileSync(join(state, "rotation.json"), JSON.stringify({ phase: "launch", oldThreadId: "thr-adam", fromRunId: "run-0", tokens: 1, projectId: "p1", runtimeMode: "auto", interactionMode: "default", launchCommandId: "rot-1", title: "Adam" }));
  const r = await tick(cfg, client);
  assert.equal(r.action, "rotated");
  assert.equal(threadId(), r.threadId);
  assert.deepEqual(detaches(t3), []);
  assert.match(readFileSync(join(state, "alerts.log"), "utf8"), /reláciu starého vlákna thr-adam nezastavujem, beží/);
});

test("reštart budiča po zápise thread_id: reláciu starého vlákna zastaví dodatočne", async (t) => {
  const { t3, cfg, client, state } = await setup(t);
  t3.addThread("thr-new");
  writeFileSync(join(state, "thread_id"), "thr-new\n");
  writeFileSync(join(state, "rotation.json"), JSON.stringify({ phase: "launch", oldThreadId: "thr-adam", fromRunId: "run-1" }));
  await tick(cfg, client);
  assert.deepEqual(detaches(t3).map((c) => c.threadId), ["thr-adam"]);
});

test("zadržaný front po reštarte T3: po riadnom behu budič pošle queue.resume", async (t) => {
  const { t3, cfg, client } = await setup(t);
  const end = await runThenEnd(t3, cfg, client, { status: "completed", usedTokens: 100 });
  t3.holdQueued("thr-adam");
  assert.equal((await tick(cfg, client, { now: end })).action, "resume-queue");
  assert.equal(t3.state.commands.at(-1).type, "queue.resume");
  assert.equal((await tick(cfg, client, { now: end + 1000 })).reason, "prázdna schránka");
});

test("config: meno agenta, cesty a predvolené hodnoty bez AGENT_NAME", () => {
  const h = config({ HOME: "/root", AGENT_NAME: "adam", AGENT_MODEL: "m" });
  assert.equal(h.name, "adam");
  assert.equal(h.title, "Adam");
  assert.equal(h.box, "/var/lib/adam");
  assert.equal(h.state, "/root/.local/state/adam");
  assert.equal(h.t3TokenFile, "/root/.config/adam/t3_token");
  assert.equal(h.workdir, "/root/agenti/adam");
  assert.equal(h.model, "m");
  const r = config({ HOME: "/root", AGENT_NAME: "boris", AGENT_MODEL: "x", T3_URL: "https://h:9/" });
  assert.equal(r.box, "/var/lib/boris");
  assert.equal(r.state, "/root/.local/state/boris");
  assert.equal(r.t3TokenFile, "/root/.config/boris/t3_token");
  assert.equal(r.workdir, "/root/agenti/boris");
  assert.equal(r.title, "Boris");
  assert.equal(r.t3Url, "https://h:9");
});

// Stojaci beh (úloha 418): beh 201 otvorila notifikácia, nič ďalej.
async function stalledSetup(t, items, extraCfg = {}) {
  const env = await setup(t, { stalledMs: 10 * MIN, ...extraCfg });
  await env.client.dispatch({ type: "message.dispatch", commandId: "c-work", messageId: "m-work", createdBy: "user", creationSource: "web", threadId: "thr-adam", text: "práca", attachments: [], dispatchMode: { type: "queue_after_active" } });
  const th = env.t3.state.threads.get("thr-adam");
  const runId = th.activeRunId;
  const at = Date.now() - 52 * MIN;
  th._turnItems.push(...items.map((i, n) => ({ id: `i${n}`, runId, updatedAt: new Date(at).toISOString(), ...i })));
  return { ...env, th, runId, at };
}

test("stojaci beh (len notifikácia, 52 min) sa preruší zámerom a vznikne výstraha", async (t) => {
  const { cfg, client, th, runId, alertFile } = await stalledSetup(t, [{ type: "notification", status: "completed" }]);
  const r = await tick(cfg, client, { now: Date.now() });
  assert.equal(r.action, "interrupt-stalled");
  assert.equal(r.runId, runId);
  assert.ok(th._turnItems.some((i) => i.type === "run_interrupt_request" && i.runId === runId), "zámer, nie pád");
  assert.match(readFileSync(alertFile, "utf8"), /prerušil/);
  const again = await tick(cfg, client, { now: Date.now() });
  assert.notEqual(again.action, "interrupt-stalled");
});

test("beh s položkou running (príkaz, sub-agent) sa nepreruší", async (t) => {
  const { cfg, client, th } = await stalledSetup(t, [{ type: "notification", status: "completed" }, { type: "command_execution", status: "running" }]);
  const r = await tick(cfg, client, { now: Date.now() });
  assert.notEqual(r.action, "interrupt-stalled");
  assert.ok(!th._turnItems.some((i) => i.type === "run_interrupt_request"));
});

test("beh s čerstvou položkou, s prahom 0 alebo čakajúci na schválenie sa nepreruší", async (t) => {
  const a = await stalledSetup(t, [{ type: "notification", status: "completed", updatedAt: new Date().toISOString() }]);
  assert.notEqual((await tick(a.cfg, a.client, { now: Date.now() })).action, "interrupt-stalled");
  const b = await stalledSetup(t, [{ type: "notification", status: "completed" }], { stalledMs: 0 });
  assert.notEqual((await tick(b.cfg, b.client, { now: Date.now() })).action, "interrupt-stalled");
  const c = await stalledSetup(t, [{ type: "notification", status: "completed" }]);
  c.th.pendingRuntimeRequest = { id: "req" };
  assert.notEqual((await tick(c.cfg, c.client, { now: Date.now() })).action, "interrupt-stalled");
});
