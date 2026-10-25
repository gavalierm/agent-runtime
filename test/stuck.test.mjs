// Dozor visiacej požiadavky na schválenie (stuck.mjs, úloha 562) proti falošnému
// T3 serveru. Správa do schránky ide falošným skriptom z cfg.stuckAskCmd, žiadny
// test nesiaha na živý T3, schránky ani bin/ask_agent.sh z repa pravidiel.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeT3 } from "./fake_t3.mjs";
import { config, stuckConfig, T3Client } from "../lib.mjs";
import { tick } from "../driver.mjs";
import { watchStep } from "../clear_watch.mjs";
import { stuckRecipient } from "../stuck.mjs";

const MIN = 60_000;
const LIVE_ASK = "/opt/agent-rules/bin/ask_agent.sh";
// Všetky živé schránky /var/lib/*/inbox: test do nich nesmie nič pridať.
const liveSnapshot = () => {
  const out = [];
  let names = [];
  try { names = readdirSync("/var/lib"); } catch { return out; }
  for (const n of names) {
    const d = join("/var/lib", n, "inbox");
    try { out.push(`${n}:${readdirSync(d).join(",")}`); } catch { /* schránka nie je */ }
  }
  return out;
};

const CMD = "rm -rf \"$(cat /tmp/x)\" && " + "x".repeat(300);

async function setup(t, extraCfg = {}) {
  const before = liveSnapshot();
  t.after(() => assert.deepEqual(liveSnapshot(), before, "živé schránky sa nezmenili"));
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  const root = mkdtempSync(join(tmpdir(), "agent-stuck-"));
  const box = join(root, "box");
  for (const d of ["inbox", "outbox", "processed"]) mkdirSync(join(box, d), { recursive: true });
  const state = join(root, "state");
  mkdirSync(state);
  writeFileSync(join(state, "thread_id"), "thr-adam\n");
  const kontextDir = join(root, "kontext");
  mkdirSync(kontextDir);
  // Falošný ask_agent: argumenty a stdin každého volania do jedného adresára.
  const calls = join(root, "calls");
  mkdirSync(calls);
  const ask = join(root, "fake_ask.sh");
  writeFileSync(ask, `#!/bin/bash\nf="${calls}/$(date +%s%N)-$$"\nprintf '%s\\n' "$*" > "$f.args"\ncat > "$f.body"\n[ -e "${root}/ask_fails" ] && exit 1\nexit 0\n`);
  chmodSync(ask, 0o755);
  const cfg = {
    name: "adam", title: "Adam", box, state, t3Url: t3.url, pollMs: 10, replyCmd: "runtime/reply.sh", kontextDir,
    wakeMax: 3, wakeWindowMs: 60 * MIN, wakeDelayMs: MIN, wakeOnInterrupt: true, limitGraceMs: 2 * MIN, batchWaitMs: 0,
    stuckMs: 10 * MIN, stuckAgent: "boris", stuckFallback: "cyril", stuckAskCmd: ask,
    ...extraCfg,
  };
  assert.notEqual(cfg.stuckAskCmd, LIVE_ASK, "test nesmie volať živý ask_agent.sh");
  const client = new T3Client({ url: t3.url, token: t3.token, timeoutMs: 3000 });
  const alerts = () => (existsSync(join(state, "alerts.log")) ? readFileSync(join(state, "alerts.log"), "utf8").split("\n").filter(Boolean) : []);
  const messages = () => readdirSync(calls).filter((f) => f.endsWith(".args")).sort().map((f) => ({
    args: readFileSync(join(calls, f), "utf8").trim(),
    body: readFileSync(join(calls, f.replace(/\.args$/, ".body")), "utf8"),
  }));
  return { t3, cfg, client, state, root, alerts, messages };
}

// Vlákno s požiadavkou starou ageMin minút a s detailom, aký nesie T3.
function pend(t3, id, { ageMin, reqId = `req-${id}`, now, title = `Titulok ${id}` } = {}) {
  const th = t3.state.threads.get(id) ?? t3.addThread(id, { title });
  th.title = title;
  th.status = "running";
  th.activeRunId = "run-x";
  th.pendingRuntimeRequest = { id: reqId, kind: "command", createdAt: new Date(now - ageMin * MIN).toISOString(), blocking: true };
  th._turnItems = [
    { type: "command_execution", status: "running", runId: "run-x", nativeItemRef: { nativeId: `toolu_${reqId}` }, input: CMD },
    { type: "approval_request", status: "pending", runId: "run-x", requestId: reqId, requestKind: "command", nativeItemRef: { nativeId: `toolu_${reqId}` },
      prompt: "Zoznam súborov", reason: "Dangerous rm operation not ruled out", fullAccessOverride: "provider_check" },
  ];
  return th;
}

test("hlavné vlákno: požiadavka nad 10 min dá jednu výstrahu a jednu správu, druhý priechod nič", async (t) => {
  const { t3, cfg, client, alerts, messages } = await setup(t);
  const now = Date.now();
  pend(t3, "thr-adam", { ageMin: 11, now });
  await tick(cfg, client, { now });
  assert.equal(alerts().length, 1);
  assert.match(alerts()[0], /thr-adam/);
  assert.match(alerts()[0], /11 min/);
  const m = messages();
  assert.equal(m.length, 1);
  assert.equal(m[0].args, "--hlavne boris");
  assert.match(m[0].body, /thr-adam \(Titulok thr-adam\)/);
  assert.match(m[0].body, /agent: adam/);
  assert.match(m[0].body, /vek: 11 min/);
  assert.match(m[0].body, /dôvod: Dangerous rm operation not ruled out/);
  assert.match(m[0].body, /príkaz: rm -rf "\$\(cat \/tmp\/x\)" && x+\n/);
  assert.ok(m[0].body.match(/príkaz: (.*)\n/)[1].length <= 200, "príkaz najviac 200 znakov");
  assert.match(m[0].body, /PushNotification/);
  assert.match(m[0].body, /schváli v T3/);
  await tick(cfg, client, { now: now + 30_000 });
  await tick(cfg, client, { now: now + 5 * MIN });
  assert.equal(alerts().length, 1, "ohlásené raz");
  assert.equal(messages().length, 1, "správa raz");
});

test("požiadavka mladšia než 10 min nedá nič, po prekročení prahu áno", async (t) => {
  const { t3, cfg, client, alerts, messages } = await setup(t);
  const now = Date.now();
  pend(t3, "thr-adam", { ageMin: 9, now });
  await tick(cfg, client, { now });
  assert.equal(alerts().length, 0);
  assert.equal(messages().length, 0);
  await tick(cfg, client, { now: now + 2 * MIN });
  assert.equal(alerts().length, 1);
  assert.equal(messages().length, 1);
});

test("nové id požiadavky v tom istom vlákne sa ohlási znova", async (t) => {
  const { t3, cfg, client, alerts, messages } = await setup(t);
  const now = Date.now();
  pend(t3, "thr-adam", { ageMin: 12, now, reqId: "req-1" });
  await tick(cfg, client, { now });
  pend(t3, "thr-adam", { ageMin: 12, now, reqId: "req-2" });
  await tick(cfg, client, { now });
  assert.equal(alerts().length, 2);
  assert.equal(messages().length, 2);
});

test("visí vlákno samotného príjemcu: správa ide na záložného", async (t) => {
  const { t3, cfg, client, messages } = await setup(t, { name: "boris" });
  assert.equal(stuckRecipient(cfg), "cyril");
  assert.equal(stuckRecipient({ ...cfg, name: "cyril" }), "boris");
  assert.equal(stuckRecipient({ ...cfg, name: "boris", stuckFallback: "" }), "");
  assert.equal(stuckRecipient({ ...cfg, name: "boris", stuckFallback: "boris" }), "");
  const now = Date.now();
  pend(t3, "thr-adam", { ageMin: 15, now });
  await tick(cfg, client, { now });
  assert.deepEqual(messages().map((m) => m.args), ["--hlavne cyril"]);
});

test("zlyhaná správa sa zopakuje, výstraha ide raz, po úspechu už nič", async (t) => {
  const { t3, cfg, client, root, alerts, messages } = await setup(t);
  writeFileSync(join(root, "ask_fails"), "");
  const now = Date.now();
  pend(t3, "thr-adam", { ageMin: 20, now });
  await tick(cfg, client, { now });
  await tick(cfg, client, { now });
  assert.equal(alerts().length, 1, "výstraha raz");
  assert.equal(messages().length, 2, "správa sa skúša znova");
  rmSync(join(root, "ask_fails"), { force: true });
  await tick(cfg, client, { now });
  assert.equal(messages().length, 3);
  await tick(cfg, client, { now });
  assert.equal(messages().length, 3, "po úspechu nič");
  assert.equal(alerts().length, 1);
});

test("bez príjemcu alebo bez skriptu ostane len výstraha", async (t) => {
  const a = await setup(t, { stuckAgent: "" });
  const now = Date.now();
  pend(a.t3, "thr-adam", { ageMin: 30, now });
  await tick(a.cfg, a.client, { now });
  assert.equal(a.alerts().length, 1);
  assert.equal(a.messages().length, 0);
  const b = await setup(t, { stuckAskCmd: undefined });
  pend(b.t3, "thr-adam", { ageMin: 30, now });
  await tick(b.cfg, b.client, { now });
  assert.equal(b.alerts().length, 1);
  assert.equal(b.messages().length, 0);
});

test("požiadavka bez createdAt (vek neznámy) nedá nič", async (t) => {
  const { t3, cfg, client, alerts, messages } = await setup(t);
  const th = t3.addThread("thr-adam");
  th.pendingRuntimeRequest = { id: "req" };
  await tick(cfg, client, { now: Date.now() });
  assert.equal(alerts().length, 0);
  assert.equal(messages().length, 0);
});

test("vlákno témy: sledovač ohlási raz, vlákno agenta (thread_id) nechá jeho budiču", async (t) => {
  const { t3, cfg, client, alerts, messages } = await setup(t);
  t3.addThread("thr-adam");
  t3.addThread("thr-tema");
  // Prvý priechod bez stavu len zapíše východisko.
  assert.equal((await watchStep(cfg, client))[0].action, "baseline");
  const now = Date.now();
  pend(t3, "thr-tema", { ageMin: 11, now, title: "Téma 7" });
  pend(t3, "thr-adam", { ageMin: 11, now });
  const r = await watchStep(cfg, client, { now });
  assert.deepEqual(r.filter((a) => a.action === "stuck-request").map((a) => a.threadId), ["thr-tema"]);
  assert.equal(alerts().length, 1);
  const m = messages();
  assert.equal(m.length, 1);
  assert.match(m[0].body, /thr-tema \(Téma 7\)/);
  assert.match(m[0].body, /agent: vlákno mimo hlavných vlákien agentov/);
  await watchStep(cfg, client, { now: now + MIN });
  assert.equal(alerts().length, 1);
  assert.equal(messages().length, 1);
});

test("požiadavka mladšia než 10 min vo vlákne témy nedá nič", async (t) => {
  const { t3, cfg, client, alerts, messages } = await setup(t);
  t3.addThread("thr-adam");
  t3.addThread("thr-tema");
  await watchStep(cfg, client);
  const now = Date.now();
  pend(t3, "thr-tema", { ageMin: 3, now });
  await watchStep(cfg, client, { now });
  assert.equal(alerts().length, 0);
  assert.equal(messages().length, 0);
});

test("config(): predvolby a prepis z prostredia, stuckConfig", () => {
  const d = config({ AGENT_NAME: "adam" });
  assert.equal(d.stuckMs, 600_000);
  assert.equal(d.stuckAgent, "", "bez runtime.env nikto");
  assert.equal(d.stuckFallback, "");
  assert.equal(d.stuckAskCmd, LIVE_ASK);
  const o = config({ AGENT_NAME: "adam", STUCK_ALERT_S: "120", STUCK_ALERT_AGENT: "boris", STUCK_ALERT_FALLBACK: "cyril", STUCK_ASK_CMD: "/x/ask" });
  assert.deepEqual([o.stuckMs, o.stuckAgent, o.stuckFallback, o.stuckAskCmd], [120_000, "boris", "cyril", "/x/ask"]);
    assert.equal(stuckConfig({}).stuckMs, 600_000);
  assert.equal(stuckConfig({ STUCK_ALERT_S: "0" }).stuckMs, 0);
});
