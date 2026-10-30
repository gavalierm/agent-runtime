import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync as mkdtempRaw, mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeT3 } from "./fake_t3.mjs";
import { T3Client, threadBusy } from "../lib.mjs";
import { tick } from "../driver.mjs";
import { rememberRoute } from "../route.mjs";

// Dočasné priečinky testu sa na konci zmažú (úloha 701).
const tmpDirs = [];
const mkdtempSync = (prefix) => { const d = mkdtempRaw(prefix); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function setup(t3) {
  const root = mkdtempSync(join(tmpdir(), "adam-driver-"));
  const box = join(root, "box");
  for (const d of ["inbox", "outbox", "processed"]) mkdirSync(join(box, d), { recursive: true });
  const state = join(root, "state");
  mkdirSync(state);
  writeFileSync(join(state, "thread_id"), "thr-adam\n");
  // heldWarmMs -Infinity: držané správy po behu nechodia sama, tieto testy skúšajú
  // triedenie a držanie. Doručenie po behu a po lehote je v driver_held.test.mjs.
  const cfg = { box, state, t3Url: t3.url, pollMs: 10, heldWarmMs: -Infinity };
  const client = new T3Client({ url: t3.url, token: t3.token, timeoutMs: 3000 });
  let n = 0;
  const put = (name, text) => {
    const p = join(box, "inbox", name);
    writeFileSync(p, text);
    const t = new Date(Date.now() - 100000 + n++ * 1000);
    utimesSync(p, t, t);
  };
  return { cfg, client, box, state, put };
}

test("voľné vlákno: správa ide cez message.dispatch a presunie sa do processed", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thr-adam");
  const { cfg, client, box, put } = setup(t3);
  put("cyril-adam_server-20261018-120000-1.md", "Ahoj Adam");
  const r = await tick(cfg, client);
  assert.equal(r.sent, 1);
  assert.equal(t3.state.messages.length, 1);
  const m = t3.state.messages[0];
  assert.equal(m.type, "message.dispatch");
  assert.equal(m.threadId, "thr-adam");
  assert.deepEqual(m.dispatchMode, { type: "queue_after_active" });
  assert.deepEqual(m.attachments, []);
  assert.match(m.text, /<schranka od="cyril" tema="adam_server" id="cyril-adam_server-20261018-120000-1.md">/);
  assert.match(m.text, /reply.sh cyril-adam_server-20261018-120000-1.md/);
  assert.match(m.text, /Ahoj Adam/);
  assert.deepEqual(readdirSync(join(box, "inbox")), []);
  assert.deepEqual(readdirSync(join(box, "processed")), ["cyril-adam_server-20261018-120000-1.md"]);
});

test("bežiace vlákno: správu nepošle, po skončení behu ju pošle raz", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thr-adam", { status: "running", activeRunId: "run-x" });
  const { cfg, client, box, put } = setup(t3);
  put("boris-20261018-120000-1.md", "disk plný");
  for (let i = 0; i < 3; i++) {
    const r = await tick(cfg, client);
    assert.equal(r.sent, 0);
    assert.match(r.reason, /beží run-x/);
  }
  assert.equal(t3.state.commands.length, 0);
  t3.finishRun("thr-adam");
  assert.equal((await tick(cfg, client)).sent, 1);
  // Správa spustila beh, ďalší priechod už nemá čo poslať.
  assert.equal((await tick(cfg, client)).sent, 0);
  assert.equal(t3.state.messages.length, 1);
  assert.equal(readdirSync(join(box, "processed")).length, 1);
});

test("viac správ počas behu ide po skončení jednou dávkou v poradí príchodu", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thr-adam", { status: "running", activeRunId: "run-x" });
  const { cfg, client, put } = setup(t3);
  put("teo-20261018-120000-1.md", "prvá");
  put("tasker-20261018-120001-2.md", "druhá");
  put("ranny-20261018-060000-3.md", "tretia");
  await tick(cfg, client);
  t3.finishRun("thr-adam");
  const r = await tick(cfg, client);
  assert.equal(r.sent, 3);
  const text = t3.state.messages[0].text;
  assert.ok(text.indexOf("prvá") < text.indexOf("druhá") && text.indexOf("druhá") < text.indexOf("tretia"));
  assert.match(text, /Schránka: 3 správy/);
  assert.match(text, /od="tasker" id="tasker-20261018-120001-2.md">\nodpoveď netreba/);
});

test("pád spojenia po prijatí: opakovanie s tým istým commandId nevytvorí druhú správu", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thr-adam");
  const { cfg, client, box, state, put } = setup(t3);
  put("cyril-20261018-120000-1.md", "raz");
  t3.state.dropAfterAccept = 1;
  await assert.rejects(tick(cfg, client));
  assert.ok(existsSync(join(state, "inflight.json")));
  assert.equal(readdirSync(join(box, "inbox")).length, 1);
  // Server už správu prijal a beh skončil, budič pošle tú istú dávku znova.
  t3.finishRun("thr-adam");
  put("cyril-20261018-120500-2.md", "neskoršia");
  const r = await tick(cfg, client);
  assert.deepEqual(r.files, ["cyril-20261018-120000-1.md"]);
  assert.equal(t3.state.commands.length, 2);
  assert.equal(t3.state.commands[0].commandId, t3.state.commands[1].commandId);
  assert.equal(t3.state.messages.length, 1);
  assert.ok(!existsSync(join(state, "inflight.json")));
  // Neskoršia správa ide v ďalšej dávke.
  t3.finishRun("thr-adam");
  assert.deepEqual((await tick(cfg, client)).files, ["cyril-20261018-120500-2.md"]);
  assert.equal(t3.state.messages.length, 2);
});

test("odmietnutie serverom: ďalší pokus má nové commandId a správa príde raz", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thr-adam");
  const { cfg, client, state, put } = setup(t3);
  put("cyril-20261018-120000-1.md", "x");
  t3.state.rejectNext = 1;
  await assert.rejects(tick(cfg, client), (e) => e.rejected === true);
  assert.equal(JSON.parse(readFileSync(join(state, "inflight.json"), "utf8")).attempt, 2);
  assert.equal((await tick(cfg, client)).sent, 1);
  assert.notEqual(t3.state.commands[0].commandId, t3.state.commands[1].commandId);
  assert.equal(t3.state.messages.length, 1);
});

test("bez thread_id a s dočasnými súbormi nepošle nič", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thr-adam");
  const { cfg, client, box, state, put } = setup(t3);
  put(".cyril-20261018-1.md.tmp", "rozpísané");
  put("Zle meno.md", "x");
  assert.equal((await tick(cfg, client)).reason, "prázdna schránka");
  writeFileSync(join(box, "inbox", "cyril-20261018-120000-1.md"), "x");
  writeFileSync(join(state, "thread_id"), "");
  assert.match((await tick(cfg, client)).reason, /chýba .*thread_id/);
  assert.equal(t3.state.commands.length, 0);
});

test("threadBusy: schválenie, limit predplatného, archív", () => {
  const base = { id: "a", status: "idle", activeRunId: null, archived: false };
  assert.equal(threadBusy(base), null);
  assert.equal(threadBusy(null), "vlákno neexistuje");
  assert.match(threadBusy({ ...base, archived: true }), /archivované/);
  assert.match(threadBusy({ ...base, pendingRuntimeRequest: { id: "r" } }), /schválenie/);
  assert.match(threadBusy({ ...base, activityRunStatus: "preparing" }), /preparing/);
  const now = Date.parse("2026-10-18T12:00:00Z");
  const limited = { ...base, status: "failed", lastErrorClass: "usage_limit", usageLimitResetAt: "2026-10-18T13:00:00Z" };
  assert.match(threadBusy(limited, now), /limit/);
  assert.equal(threadBusy(limited, Date.parse("2026-10-18T13:00:01Z")), null);
  assert.equal(threadBusy({ ...base, status: "failed", lastErrorClass: "other" }), null);
});

// Chyba 18. 10. 2026: druhá odpoveď Borisa mala to isté meno ako prvá,
// commandId z mien súborov sa zhodlo, T3 ju zahodil a budič ju presunul
// do processed ako poslanú.
test("nová správa s menom už doručenej správy príde do vlákna", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thr-adam");
  const { cfg, client, box, put } = setup(t3);
  put("boris-adam-pravidla-20261018-175451.md", "prvá odpoveď");
  assert.equal((await tick(cfg, client)).sent, 1);
  t3.finishRun("thr-adam");
  put("boris-adam-pravidla-20261018-175451.md", "druhá odpoveď");
  assert.equal((await tick(cfg, client)).sent, 1);
  assert.equal(t3.state.messages.length, 2);
  assert.match(t3.state.messages[1].text, /druhá odpoveď/);
  assert.equal(readdirSync(join(box, "processed")).length, 2, "prvá ostala v processed");
});

// Budenie podľa prvého riadku správy (README.md, časť Budenie).
const H = 3600 * 1000;

test("na vedomie sama sa nepošle a ostane v inboxe, s budiacou ide pod nadpisom", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thr-adam");
  const { cfg, client, box, put } = setup(t3);
  put("boris-adam-x-20261019-100000-1.md", "odpoveď: na vedomie\nHotovo, otvorené nič.\n");
  let r = await tick(cfg, client);
  assert.equal(r.sent, 0);
  assert.match(r.reason, /držím 1 na vedomie/);
  assert.equal(r.held, 1);
  assert.deepEqual(readdirSync(join(box, "inbox")), ["boris-adam-x-20261019-100000-1.md"]);
  put("boris-pravidla-20261019-100100-2.md", "odpoveď: čakám\nPotrebujem rozhodnutie.\n");
  r = await tick(cfg, client);
  assert.equal(r.sent, 2);
  assert.equal(r.held, 1);
  const text = t3.state.messages[0].text;
  assert.match(text, /<schranka od="boris" tema="pravidla" id="boris-pravidla-20261019-100100-2.md" odpoveď="čakám">\nodpoveď: reply.sh boris-pravidla-20261019-100100-2.md <<'EOF' \.\.\. EOF \(odosielateľ na ňu čaká\)\n\nPotrebujem rozhodnutie\./);
  assert.match(text, /Na vedomie, 1 správa bez budenia\.[\s\S]*<schranka od="boris" id="boris-adam-x-20261019-100000-1.md" odpoveď="na vedomie">\nodpoveď sa nepíše\n\nHotovo, otvorené nič\./);
  assert.ok(text.indexOf("Potrebujem") < text.indexOf("Na vedomie"), "budiaca správa je prvá");
  assert.doesNotMatch(text, /^odpoveď: na vedomie$/m, "riadok hlavičky nie je v tele");
  assert.doesNotMatch(text, /Schránka: 2/);
  assert.deepEqual(readdirSync(join(box, "inbox")), []);
  assert.equal(readdirSync(join(box, "processed")).length, 2);
});

test("na vedomie na kľúč, na ktorý agent čaká, zobudí; po vlastnej odpovedi na vedomie už nie", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thr-adam");
  const { cfg, client, put } = setup(t3);
  const cfgH = { ...cfg, name: "adam" };
  rememberRoute(cfgH, { name: "adam-disk-20261019-100000-1.md", thread: null, peer: "boris", mode: "čakám" });
  const D = "adam-disk-20261019-100000-1.md";
  put("boris-adam-disk-20261019-100000-1.md", `odpoveď: na vedomie\nk správe: čakám\nid: boris-adam-disk-20261019-100000-1.md\nk: ${D}\nUvoľnené 20 GB.\n`);
  assert.equal((await tick(cfgH, client)).sent, 1);
  t3.finishRun("thr-adam");
  rememberRoute(cfgH, { name: D, thread: null, mode: "na vedomie" });
  put("boris-adam-boris-adam-disk-20261019-100000-1.md", `odpoveď: na vedomie\nk správe: čakám\nid: boris-adam-boris-adam-disk-20261019-100000-1.md\nk: ${D}\nEšte poznámka.\n`);
  const r = await tick(cfgH, client);
  assert.equal(r.sent, 0);
  assert.equal(r.held, 1);
});

test("bez záznamu sent rozhodne riadok k správe, správa bez riadku a tasker-* budia", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thr-adam");
  const { cfg, client, put } = setup(t3);
  put("boris-adam-a-20261019-100000-1.md", "odpoveď: na vedomie\nk správe: čakám\nHotovo.\n");
  assert.deepEqual((await tick(cfg, client)).files, ["boris-adam-a-20261019-100000-1.md"]);
  t3.finishRun("thr-adam");
  put("boris-adam-b-20261019-100000-2.md", "odpoveď: na vedomie\nk správe: nečakám\nHotovo.\n");
  assert.equal((await tick(cfg, client)).held, 1);
  put("tasker-20261019-100100-3.md", "Tasker: úloha #9 čaká na človeka.\n");
  let r = await tick(cfg, client);
  assert.equal(r.sent, 2);
  assert.match(t3.state.messages[1].text, /<schranka od="tasker" id="tasker-20261019-100100-3.md">\nodpoveď netreba/);
  t3.finishRun("thr-adam");
  put("cyril-20261019-100200-4.md", "Bez riadku.\n");
  r = await tick(cfg, client);
  assert.equal(r.sent, 1);
  assert.match(t3.state.messages[2].text, /<schranka od="cyril" id="cyril-20261019-100200-4.md">\nodpoveď: reply.sh cyril-20261019-100200-4.md <<'EOF' \.\.\. EOF\n/);
});

test("držaná správa na vedomie sama neodíde ani po dlhom čase, ide s budiacou dávkou", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thr-adam");
  const { cfg, client, box, put } = setup(t3);
  put("pravidla-20261019-100000-1.md", "odpoveď: na vedomie\n[pravidlá] Zmena pravidiel a..b.\n");
  const now = Date.now();
  let r = await tick(cfg, client, { now });
  assert.equal(r.held, 1);
  r = await tick(cfg, client, { now: now + 10 * H });
  assert.equal(r.sent, 0, "po 10 h sama neodíde");
  assert.match(r.reason, /držím 1 na vedomie/);
  assert.equal(readdirSync(join(box, "inbox")).length, 1);
  put("cyril-20261019-100100-2.md", "odpoveď: čakám\nBudiaca.\n");
  r = await tick(cfg, client, { now: now + 10 * H + 100_000 });
  assert.equal(r.sent, 2);
  assert.match(t3.state.messages[0].text, /Zmena pravidiel a\.\.b/);
  assert.match(t3.state.messages[0].text, /Budiaca\./);
  assert.deepEqual(readdirSync(join(box, "inbox")), []);
});

test("tiché okno: správy tesne za sebou idú jednou dávkou, najviac po maximálnom okne", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thr-adam");
  const { cfg, client, box } = setup(t3);
  const now = Date.now();
  const at = (name, text, ms) => {
    const p = join(box, "inbox", name);
    writeFileSync(p, text);
    utimesSync(p, new Date(now - ms), new Date(now - ms));
  };
  at("cyril-a-20261019-100000-1.md", "odpoveď: čakám\nprvá\n", 10_000);
  let r = await tick(cfg, client, { now });
  assert.equal(r.sent, 0);
  assert.match(r.reason, /tiché okno, 1 správ/);
  at("cyril-b-20261019-100010-2.md", "odpoveď: čakám\ndruhá\n", 1_000);
  r = await tick(cfg, client, { now: now + 20_000 });
  assert.equal(r.sent, 0, "posledná správa je mladšia ako 30 s");
  r = await tick(cfg, client, { now: now + 31_000 });
  assert.equal(r.sent, 2);
  assert.match(t3.state.messages[0].text, /Schránka: 2 správy/);
  // Maximálne okno: správy chodia stále, dávka odíde aj tak.
  t3.finishRun("thr-adam");
  at("cyril-c-20261019-100100-3.md", "odpoveď: čakám\ntretia\n", 125_000);
  at("cyril-d-20261019-100200-4.md", "odpoveď: čakám\nštvrtá\n", 5_000);
  r = await tick(cfg, client, { now });
  assert.equal(r.sent, 2);
  // Držaná správa tiché okno nespúšťa.
  t3.finishRun("thr-adam");
  at("boris-adam-e-20261019-100300-5.md", "odpoveď: na vedomie\npiata\n", 1_000);
  r = await tick(cfg, client, { now });
  assert.equal(r.sent, 0);
  assert.match(r.reason, /držím 1/);
});

test("dve vlákna: držanie platí na vlákno z trasy", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thr-adam");
  t3.addThread("thr-tema");
  const { cfg, client, put } = setup(t3);
  const cfgH = { ...cfg, name: "adam" };
  rememberRoute(cfgH, { name: "adam-tema-20261019-100000-1.md", thread: "thr-tema", peer: "boris", mode: "nečakám" });
  put("boris-adam-tema-20261019-100000-1.md", "odpoveď: na vedomie\nk správe: nečakám\nid: boris-adam-tema-20261019-100000-1.md\nk: adam-tema-20261019-100000-1.md\nhotovo v téme\n");
  put("boris-adam-ine-20261019-100100-2.md", "odpoveď: na vedomie\nhlásenie pre hlavné\n");
  let r = await tick(cfgH, client);
  assert.equal(r.sent, 0);
  assert.equal(r.held, 2);
  // Budiaca správa do hlavného vynesie len držanú správu hlavného vlákna.
  put("cyril-20261019-100200-3.md", "odpoveď: čakám\npre hlavné\n");
  r = await tick(cfgH, client);
  assert.equal(r.sent, 2);
  assert.equal(r.held, 1);
  assert.equal(t3.state.messages[0].threadId, "thr-adam");
  assert.match(t3.state.messages[0].text, /hlásenie pre hlavné/);
  assert.doesNotMatch(t3.state.messages[0].text, /hotovo v téme/);
  // Držaná správa témy sama neodíde ani po dlhom čase.
  r = await tick(cfgH, client, { now: Date.now() + 5 * H });
  assert.equal(r.sent, 0);
  assert.equal(t3.state.messages.length, 1);
});

test("rozpracovaná dávka pre zaneprázdnené vlákno X nezdrží správu pre voľné vlákno Y (úloha 419)", async (t) => {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  t3.addThread("thr-adam");
  t3.addThread("thr-x");
  t3.addThread("thr-y");
  const { cfg, client, box, state, put } = setup(t3);
  const cfgH = { ...cfg, name: "adam" };
  rememberRoute(cfgH, { name: "adam-x-20261019-100000-1.md", thread: "thr-x", peer: "boris", mode: "čakám" });
  rememberRoute(cfgH, { name: "adam-y-20261019-100000-2.md", thread: "thr-y", peer: "boris", mode: "čakám" });
  put("cyril-20261018-120000-1.md", "odpoveď: čakám\nk: adam-x-20261019-100000-1.md\npre X\n");
  put("cyril-20261018-120001-2.md", "odpoveď: čakám\nk: adam-y-20261019-100000-2.md\npre Y\n");
  // X je zaneprázdnené a prijme prvú dávku, ktorá zostane v inflight.json.
  await client.dispatch({ type: "message.dispatch", commandId: "c-x", messageId: "m-x", createdBy: "user", creationSource: "web", threadId: "thr-x", text: "práca", attachments: [], dispatchMode: { type: "queue_after_active" } });
  writeFileSync(join(state, "inflight.json"), JSON.stringify({ files: ["cyril-20261018-120000-1.md"], held: [], attempt: 2, batch: "b1", threadId: "thr-x", notes: {} }));
  const before = readFileSync(join(state, "inflight.json"), "utf8");
  const r = await tick(cfgH, client);
  assert.equal(r.sent, 1);
  assert.equal(r.threadId, "thr-y");
  assert.deepEqual(t3.state.messages.filter((m) => m.threadId === "thr-y").length, 1);
  assert.equal(readFileSync(join(state, "inflight.json"), "utf8"), before, "dávka X ostala");
  assert.ok(existsSync(join(box, "inbox", "cyril-20261018-120000-1.md")));
  assert.ok(existsSync(join(box, "processed", "cyril-20261018-120001-2.md")));
  // Ďalší priechod: X stále zaneprázdnené, nič sa neposiela.
  assert.equal((await tick(cfgH, client)).sent, 0);
  // X sa uvoľní, jeho dávka odíde a súbor zmizne.
  t3.finishRun("thr-x");
  assert.equal((await tick(cfgH, client)).threadId, "thr-x");
  assert.ok(!existsSync(join(state, "inflight.json")));
});
