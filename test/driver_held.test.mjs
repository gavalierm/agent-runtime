import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeT3 } from "./fake_t3.mjs";
import { T3Client, inboxConfig } from "../lib.mjs";
import { heldDue, tick } from "../driver.mjs";
import { rememberRoute } from "../route.mjs";
import { sweepHeld } from "../morning.mjs";

// Doručenie správ na vedomie po behu alebo po lehote (úloha 518). Všetko
// v mkdtemp a vo falošnom T3, cfg nesie len dočasné cesty.
const H = 3600 * 1000;
const MIN = 60 * 1000;
const HELD = "odpoveď: na vedomie\nHotovo, otvorené nič.\n";

function setup(t3) {
  const root = mkdtempSync(join(tmpdir(), "adam-held-"));
  const box = join(root, "box");
  for (const d of ["inbox", "outbox", "processed"]) mkdirSync(join(box, d), { recursive: true });
  const state = join(root, "state");
  mkdirSync(state);
  writeFileSync(join(state, "thread_id"), "thr-adam\n");
  const cfg = { box, state, t3Url: t3.url, pollMs: 10, name: "adam" };
  // Nič z cfg nesmie ukazovať na živý systém.
  for (const v of [cfg.box, cfg.state]) assert.ok(v.startsWith(tmpdir()), `cesta mimo tmp: ${v}`);
  assert.match(cfg.t3Url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(cfg.taskerDb, undefined);
  const client = new T3Client({ url: t3.url, token: t3.token, timeoutMs: 3000 });
  const put = (name, text, ageMs, now) => {
    const p = join(box, "inbox", name);
    writeFileSync(p, text);
    const t = new Date(now - ageMs);
    utimesSync(p, t, t);
  };
  return { cfg, client, box, state, put };
}

const ago = (now, ms) => new Date(now - ms).toISOString();

test("1: držaná správa 25 h stará, vlákno voľné, beh skončil pred 5 h: odíde po lehote", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  const now = Date.now();
  t3.addThread("thr-adam", { latestRunCompletedAt: ago(now, 5 * H) });
  const { cfg, client, box, put } = setup(t3);
  put("boris-adam-x-20261019-100000-1.md", HELD, 25 * H, now);
  const r = await tick(cfg, client, { now });
  assert.equal(r.sent, 1);
  assert.equal(r.held, 1);
  assert.equal(t3.state.messages.length, 1);
  assert.match(t3.state.messages[0].text, /Na vedomie, 1 správa bez budenia\./);
  assert.match(t3.state.messages[0].text, /Hotovo, otvorené nič\./);
  assert.deepEqual(readdirSync(join(box, "inbox")), []);
  assert.deepEqual(readdirSync(join(box, "processed")), ["boris-adam-x-20261019-100000-1.md"]);
  // 6: ranná poistka po doručení nemá čo presunúť.
  assert.deepEqual(sweepHeld({ sweepBoxes: [box] }, now + 30 * H), []);
});

test("2: držaná správa 1 h stará, beh skončil pred 2 min: odíde v teplom vlákne", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  const now = Date.now();
  t3.addThread("thr-adam", { latestRunCompletedAt: ago(now, 2 * MIN) });
  const { cfg, client, box, put } = setup(t3);
  put("boris-adam-x-20261019-100000-1.md", HELD, 1 * H, now);
  const r = await tick(cfg, client, { now });
  assert.equal(r.sent, 1);
  assert.match(t3.state.messages[0].text, /Na vedomie, 1 správa bez budenia\./);
  assert.deepEqual(readdirSync(join(box, "inbox")), []);
  assert.equal(readdirSync(join(box, "processed")).length, 1);
});

test("3: držaná správa 1 h stará, beh skončil pred 2 h: ostane držaná", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  const now = Date.now();
  t3.addThread("thr-adam", { latestRunCompletedAt: ago(now, 2 * H) });
  const { cfg, client, box, put } = setup(t3);
  put("boris-adam-x-20261019-100000-1.md", HELD, 1 * H, now);
  const r = await tick(cfg, client, { now });
  assert.equal(r.sent, 0);
  assert.match(r.reason, /držím 1 na vedomie/);
  assert.equal(t3.state.messages.length, 0);
  assert.equal(readdirSync(join(box, "inbox")).length, 1);
});

test("3b: bez času posledného behu alebo s neplatným časom vlákno nie je teplé", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  const now = Date.now();
  t3.addThread("thr-adam", { latestRunCompletedAt: "nie je čas" });
  const { cfg, client, put } = setup(t3);
  put("boris-adam-x-20261019-100000-1.md", HELD, 1 * H, now);
  assert.equal((await tick(cfg, client, { now })).sent, 0);
  t3.state.threads.get("thr-adam").latestRunCompletedAt = null;
  assert.equal((await tick(cfg, client, { now })).sent, 0);
});

test("4: teplé vlákno, ale beží beh: neodíde, po skončení behu odíde", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  const now = Date.now();
  t3.addThread("thr-adam", { status: "running", activeRunId: "run-x", latestRunCompletedAt: ago(now, 2 * MIN) });
  const { cfg, client, box, put } = setup(t3);
  put("boris-adam-x-20261019-100000-1.md", HELD, 1 * H, now);
  const r = await tick(cfg, client, { now });
  assert.equal(r.sent, 0);
  assert.equal(t3.state.messages.length, 0);
  assert.equal(readdirSync(join(box, "inbox")).length, 1);
});

test("5: budiaca správa v inom vlákne má prednosť pred držanou v teplom vlákne", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  const now = Date.now();
  t3.addThread("thr-adam");
  t3.addThread("thr-tema", { latestRunCompletedAt: ago(now, 2 * MIN) });
  const { cfg, client, box, put } = setup(t3);
  rememberRoute(cfg, { name: "adam-tema-20261019-100000-1.md", thread: "thr-tema", peer: "boris", mode: "nečakám" });
  // Držaná správa témy je staršia, jej skupina je v schránke prvá.
  put("boris-adam-tema-20261019-100000-1.md", "odpoveď: na vedomie\nk správe: nečakám\nid: boris-adam-tema-20261019-100000-1.md\nk: adam-tema-20261019-100000-1.md\nhotovo v téme\n", 2 * H, now);
  put("cyril-20261019-100200-3.md", "odpoveď: čakám\npre hlavné\n", 1 * H, now);
  let r = await tick(cfg, client, { now });
  assert.equal(r.sent, 1);
  assert.equal(t3.state.messages.length, 1);
  assert.equal(t3.state.messages[0].threadId, "thr-adam");
  assert.match(t3.state.messages[0].text, /pre hlavné/);
  // Hlavné vlákno beží, držaná správa témy odíde v ďalšom priechode.
  r = await tick(cfg, client, { now: now + 1000 });
  assert.equal(r.sent, 1);
  assert.equal(t3.state.messages[1].threadId, "thr-tema");
  assert.match(t3.state.messages[1].text, /hotovo v téme/);
  assert.deepEqual(readdirSync(join(box, "inbox")), []);
});

test("dávka len z držaných má strop 10 správ", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  const now = Date.now();
  t3.addThread("thr-adam", { latestRunCompletedAt: ago(now, 1 * MIN) });
  const { cfg, client, box, put } = setup(t3);
  for (let i = 1; i <= 12; i++) put(`boris-adam-x-20261019-1000${String(i).padStart(2, "0")}-${i}.md`, HELD, 1 * H - i * 1000, now);
  const r = await tick(cfg, client, { now });
  assert.equal(r.sent, 10);
  assert.equal(readdirSync(join(box, "inbox")).length, 2);
  assert.ok(!existsSync(join(cfg.state, "inflight.json")));
});

// Úloha 559 (replay 547): po čistom kontexte je /clear posledný beh vlákna,
// jeho koniec je čerstvý, ale kontext v cache nie je.
function lastRun(text) {
  return {
    latestRunId: "run-z",
    _runs: [{ id: "run-z", status: "completed", userMessageId: "msg-z", completedAt: null }],
    _messages: [{ id: "msg-z", role: "user", runId: "run-z", text }],
  };
}

test("559: beh skončil pred 1 min a bol to /clear: držaná správa nejde sama", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  const now = Date.now();
  t3.addThread("thr-adam", { latestRunCompletedAt: ago(now, 1 * MIN), ...lastRun("/clear") });
  const { cfg, client, put } = setup(t3);
  put("boris-adam-x-20261019-100001-1.md", HELD, 20 * MIN, now);
  const r = await tick(cfg, client, { now });
  assert.equal(r.sent, 0);
  assert.equal(t3.state.messages.length, 0);
  // Po lehote cfg.heldMaxMs (24 h) odíde aj po /clear.
  put("boris-adam-x-20261019-100001-1.md", HELD, 25 * H, now);
  assert.equal((await tick(cfg, client, { now })).sent, 1);
});

test("559: ten istý beh bez /clear: držaná správa odíde sama", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  const now = Date.now();
  t3.addThread("thr-adam", { latestRunCompletedAt: ago(now, 1 * MIN), ...lastRun("Hotovo, pokračuj.") });
  const { cfg, client, put } = setup(t3);
  put("boris-adam-x-20261019-100001-1.md", HELD, 20 * MIN, now);
  const r = await tick(cfg, client, { now });
  assert.equal(r.sent, 1);
  assert.match(t3.state.messages[0].text, /Na vedomie, 1 správa bez budenia\./);
});

test("lehota držanej správy je predvolene 24 h: 13 h na studenom vlákne nie, 25 h áno", () => {
  const cfg = inboxConfig({});
  assert.equal(cfg.heldMaxMs, 24 * H);
  const now = Date.now();
  const g = (ageMs) => ({ held: [{ mtime: now - ageMs }], thread: { latestRunCompletedAt: ago(now, 30 * H) } });
  assert.equal(heldDue(cfg, g(13 * H), now), false);
  assert.equal(heldDue(cfg, g(25 * H), now), true);
});

test("sweepHeld presunie aj čerstvú správu na vedomie a nechá budiacu", () => {
  const root = mkdtempSync(join(tmpdir(), "adam-sweep-fresh-"));
  const box = join(root, "box");
  for (const d of ["inbox", "processed"]) mkdirSync(join(box, d), { recursive: true });
  const now = Date.now();
  const put = (n, text) => { const p = join(box, "inbox", n); writeFileSync(p, text); const s = (now - 60 * 1000) / 1000; utimesSync(p, s, s); };
  put("boris-20261019-100000-1.md", HELD);
  put("boris-20261019-100001-2.md", "odpoveď: čakám\nBudí.\n");
  const out = sweepHeld({ sweepBoxes: [box] }, now);
  assert.equal(out.length, 1);
  assert.deepEqual(readdirSync(join(box, "processed")), ["boris-20261019-100000-1.md"]);
  assert.deepEqual(readdirSync(join(box, "inbox")), ["boris-20261019-100001-2.md"]);
});
