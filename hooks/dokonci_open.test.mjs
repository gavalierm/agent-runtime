// dokonci_open.mjs: Stop s otvoreným ledgerom skillu dokonci v behu Taskera
// zastaví (úloha 623, behy 126 a 127), uzavretý ledger a beh bez Taskera
// nechá. Dočasné priečinky v /tmp, žiadny živý Tasker.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "dokonci_open.mjs");
const TMPS = [];
after(() => { for (const t of TMPS) rmSync(t, { recursive: true, force: true }); });

const tmp = () => { const t = mkdtempSync(join(tmpdir(), "dokonci-open-")); TMPS.push(t); return t; };
const L = (typ, ...kv) => [`@${typ}`, "2026-10-27T01:00:00+00:00", ...kv].join("\t") + "\n";
const START = L("start", "uloha=90623");

// Hook ako proces. TASKER_TASK_ID a DOKONCI_LEDGER_DIR sa berú z `env`, nič z okolia testu.
function run(input, env = {}) {
  const clean = { ...process.env };
  delete clean.TASKER_TASK_ID;
  delete clean.DOKONCI_LEDGER_DIR;
  const r = spawnSync("node", [HOOK], { input: JSON.stringify(input), env: { ...clean, ...env }, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

function ledgerIn(content, task = 90623) {
  const dir = tmp();
  writeFileSync(join(dir, `dokonci-${task}.md`), content);
  return dir;
}

function repoWithScratch(content) {
  const repo = tmp();
  spawnSync("git", ["init", "-q", repo]);
  mkdirSync(join(repo, ".scratch"));
  mkdirSync(join(repo, "src", "hlboko"), { recursive: true });
  writeFileSync(join(repo, ".scratch", "dokonci-90623.md"), content);
  return repo;
}

test("bez TASKER_TASK_ID hook mlčí", () => {
  const dir = ledgerIn(START);
  assert.equal(run({ cwd: "/tmp" }, { DOKONCI_LEDGER_DIR: dir }), null);
});

test("stop_hook_active mlčí", () => {
  const dir = ledgerIn(START);
  assert.equal(run({ cwd: "/tmp", stop_hook_active: true }, { TASKER_TASK_ID: "90623", DOKONCI_LEDGER_DIR: dir }), null);
});

test("ledger len so @start blokuje, dôvod nesie cestu a dokonci.sh koniec", () => {
  const dir = ledgerIn(START);
  const r = run({ cwd: "/tmp" }, { TASKER_TASK_ID: "90623", DOKONCI_LEDGER_DIR: dir });
  assert.equal(r.decision, "block");
  assert.ok(r.reason.includes(join(dir, "dokonci-90623.md")));
  assert.ok(r.reason.includes("dokonci.sh koniec 90623"));
  assert.ok(r.reason.includes("dokonci.sh otazka 90623 --summary"));
  assert.ok(r.reason.includes("run_in_background false"));
  assert.match(r.reason, /Správny postup:/);
});

test("ledger so @koniec mlčí", () => {
  const dir = ledgerIn(START + L("dokaz", "kod=0") + L("koniec", "vysledok=x"));
  assert.equal(run({ cwd: "/tmp" }, { TASKER_TASK_ID: "90623", DOKONCI_LEDGER_DIR: dir }), null);
});

test("ledger s @otazka mlčí", () => {
  const dir = ledgerIn(START + L("otazka", "summary=A alebo B?"));
  assert.equal(run({ cwd: "/tmp" }, { TASKER_TASK_ID: "90623", DOKONCI_LEDGER_DIR: dir }), null);
});

test("dve relácie (@start @koniec @start) blokujú", () => {
  const dir = ledgerIn(START + L("koniec", "vysledok=x") + START);
  const r = run({ cwd: "/tmp" }, { TASKER_TASK_ID: "90623", DOKONCI_LEDGER_DIR: dir });
  assert.equal(r.decision, "block");
});

test("dve relácie (@start @otazka @start @koniec) mlčia", () => {
  const dir = ledgerIn(START + L("otazka", "summary=x?") + START + L("koniec", "vysledok=x"));
  assert.equal(run({ cwd: "/tmp" }, { TASKER_TASK_ID: "90623", DOKONCI_LEDGER_DIR: dir }), null);
});

test("ledger chýba: mlčí; ledger inej úlohy sa nepočíta", () => {
  const dir = tmp();
  assert.equal(run({ cwd: "/tmp" }, { TASKER_TASK_ID: "90623", DOKONCI_LEDGER_DIR: dir }), null);
  const other = ledgerIn(START, 624);
  assert.equal(run({ cwd: "/tmp" }, { TASKER_TASK_ID: "90623", DOKONCI_LEDGER_DIR: other }), null);
});

test("DOKONCI_LEDGER_DIR má prednosť pred .scratch repa", () => {
  const repo = repoWithScratch(START); // otvorený
  const dir = ledgerIn(START + L("koniec", "vysledok=x")); // uzavretý
  assert.equal(run({ cwd: repo }, { TASKER_TASK_ID: "90623", DOKONCI_LEDGER_DIR: dir }), null);
});

test("ledger v .scratch git toplevelu, keď cwd je podpriečinok repa", () => {
  const repo = repoWithScratch(START);
  const r = run({ cwd: join(repo, "src", "hlboko") }, { TASKER_TASK_ID: "90623" });
  assert.equal(r.decision, "block");
  assert.ok(r.reason.includes(join(repo, ".scratch", "dokonci-90623.md")));
});

test("pokazený vstup nezhodí hook", () => {
  const r = spawnSync("node", [HOOK], { input: "nie json", encoding: "utf8", env: { ...process.env, TASKER_TASK_ID: "" } });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
