// Budič zapíše do Taskera trasu doručenej správy k úlohe (`tasker route`, úloha 486).
// Príkaz je falošný skript v tmp, žiadny test nesiaha na živý Tasker ani T3.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync as mkdtempRaw, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFakeT3 } from "./fake_t3.mjs";
import { T3Client } from "../lib.mjs";
import { tick, recordRoute } from "../driver.mjs";

// Dočasné priečinky testu sa na konci zmažú (úloha 701).
const tmpDirs = [];
const mkdtempSync = (prefix) => { const d = mkdtempRaw(prefix); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

async function setup(t, { routeCmd = true, topics = null } = {}) {
  const t3 = await startFakeT3();
  t.after(() => t3.close());
  const root = mkdtempSync(join(tmpdir(), "driver-route-"));
  const box = join(root, "box");
  for (const d of ["inbox", "outbox", "processed"]) mkdirSync(join(box, d), { recursive: true });
  const state = join(root, "state");
  mkdirSync(state);
  writeFileSync(join(state, "thread_id"), "thr-adam\n");
  const log = join(root, "route.log");
  const cmd = join(root, "fake-tk");
  writeFileSync(cmd, `#!/bin/bash\necho "$AGENT_NAME|$*" >> "${log}"\n`);
  chmodSync(cmd, 0o755);
  const cfg = { name: "adam", box, state, t3Url: t3.url, pollMs: 10, ...(routeCmd ? { routeCmd: cmd } : {}) };
  if (topics) {
    cfg.topicsFile = join(root, "topics.json");
    writeFileSync(cfg.topicsFile, JSON.stringify(topics));
  }
  const client = new T3Client({ url: t3.url, token: t3.token, timeoutMs: 3000 });
  let n = 0;
  const put = (name, text) => {
    const p = join(box, "inbox", name);
    writeFileSync(p, text);
    const d = new Date(Date.now() - 100000 + n++ * 1000);
    utimesSync(p, d, d);
  };
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  return { t3, cfg, client, put, calls };
}

test("trasa: správa k úlohe do hlavného vlákna zapíše vlákno, názov a spôsob", async (t) => {
  const { t3, cfg, client, put, calls } = await setup(t);
  t3.addThread("thr-adam", { title: "Adam (hlavné vlákno)" });
  put("tasker-20261024-120000-1.md", "odpoveď: nečakám\nTasker: úloha #7 pre teba.\n");
  put("cyril-adam_server-20261018-120000-1.md", "Ahoj");
  assert.equal((await tick(cfg, client)).sent, 2);
  assert.deepEqual(calls(), ["adam|route 7 --thread thr-adam --title Adam (hlavné vlákno) --via hlavné vlákno"]);
});

test("trasa: vlákno s #N v titulku a vlákno témy sa zapíšu so svojím spôsobom", async (t) => {
  const { t3, cfg, client, put, calls } = await setup(t, { topics: { projekt_a: { thread: "mcp:topic" } } });
  t3.addThread("thr-adam", { title: "Adam (hlavné vlákno)", projectId: "p1" });
  t3.addThread("mcp:topic", { title: "Projekt a téma", projectId: "p1" });
  t3.addThread("mcp:70", { title: "Tasker #70", projectId: "p1" });
  put("tasker-20261024-120000-1.md", "odpoveď: nečakám\nTasker: úloha #70 pre teba.\n");
  put("tasker-projekt_a-20261024-120001-2.md", "odpoveď: nečakám\nTasker: úloha #8 pre teba.\n");
  for (let i = 0; i < 3; i++) await tick(cfg, client);
  assert.deepEqual(calls().sort(), [
    "adam|route 70 --thread mcp:70 --title Tasker #70 --via vlákno úlohy",
    "adam|route 8 --thread mcp:topic --title Projekt a téma --via téma projekt_a",
  ]);
});

test("trasa: bez routeCmd v nastavení sa nič nezapíše, zlý príkaz doručenie nezdrží", async (t) => {
  const a = await setup(t, { routeCmd: false });
  a.t3.addThread("thr-adam", { title: "H" });
  a.put("tasker-20261024-120000-1.md", "odpoveď: nečakám\nTasker: úloha #7 pre teba.\n");
  assert.equal((await tick(a.cfg, a.client)).sent, 1);
  assert.deepEqual(a.calls(), []);
  assert.equal(recordRoute({ routeCmd: "/nonexistent/tk", name: "adam" }, 1, "x", null, null), false);
  assert.equal(recordRoute({ name: "adam" }, 1, "x", null, null), false);
});
