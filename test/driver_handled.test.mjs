import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync as mkdtempRaw, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classify } from "../driver.mjs";

// Dočasné priečinky testu sa na konci zmažú (úloha 701).
const tmpDirs = [];
const mkdtempSync = (prefix) => { const d = mkdtempRaw(prefix); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

// Správa Taskera, na ktorej úlohe agent po jej zápise sám zapísal nečinnú
// udalosť, nebudí (chyba 24. 10. 2026, úloha 499). Všetko beží nad dočasnými
// cestami, vymyslená úloha 7001 a vymyslený agent adam, nič zo servera.
const TASK = 7001;
const NAME = "tasker-20261024-203933-4242.md";
const MTIME = Date.parse("2026-10-24T20:39:33Z");

function setup({ events = [], withDb = true, mode = "nečakám" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "adam-handled-"));
  const box = join(root, "box");
  mkdirSync(join(box, "inbox"), { recursive: true });
  const file = join(box, "inbox", NAME);
  writeFileSync(file, `odpoveď: ${mode}\nid: ${NAME}\nod: tasker\nkomu: adam\ntéma: \nTasker: úloha #${TASK}, komentár operátora po needs_human\n`);
  utimesSync(file, MTIME / 1000, MTIME / 1000);
  const taskerDb = join(root, "tasker.db");
  if (withDb) {
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const db = new DatabaseSync(taskerDb);
    db.exec("CREATE TABLE events (id INTEGER PRIMARY KEY, task_id INTEGER, run_id INTEGER, at INTEGER NOT NULL, actor TEXT NOT NULL, kind TEXT NOT NULL, from_status TEXT, to_status TEXT, detail TEXT, quiet INTEGER NOT NULL DEFAULT 0)");
    const ins = db.prepare("INSERT INTO events(task_id, at, actor, kind, quiet) VALUES (?,?,?,?,?)");
    for (const e of events) ins.run(e.task ?? TASK, e.at, e.actor ?? "human:adam", e.kind ?? "comment", e.quiet ?? 0);
    db.close();
  }
  return { cfg: { name: "adam", box, state: join(root, "state"), taskerDb } };
}

test("udalosť agenta po mtime správy: nebudí", () => {
  const { cfg } = setup({ events: [{ at: MTIME + 60_000 }] });
  assert.equal(classify(cfg, NAME).wake, false);
});

test("udalosť agenta pred mtime správy: budí", () => {
  const { cfg } = setup({ events: [{ at: MTIME - 60_000 }] });
  assert.equal(classify(cfg, NAME).wake, true);
});

test("udalosť iného aktéra po mtime: budí", () => {
  const { cfg } = setup({ events: [{ at: MTIME + 60_000, actor: "human:operator" }, { at: MTIME + 61_000, actor: "tasker" }] });
  assert.equal(classify(cfg, NAME).wake, true);
});

test("tichá udalosť agenta (work, delivered) po mtime: budí", () => {
  const { cfg } = setup({ events: [{ at: MTIME + 60_000, kind: "work", quiet: 1 }, { at: MTIME + 61_000, kind: "delivered", quiet: 1 }] });
  assert.equal(classify(cfg, NAME).wake, true);
});

test("udalosť agenta po mtime na inej úlohe: budí", () => {
  const { cfg } = setup({ events: [{ at: MTIME + 60_000, task: 7002 }] });
  assert.equal(classify(cfg, NAME).wake, true);
});

test("bez databázy, bez cesty k nej a bez mena agenta: budí", () => {
  const { cfg } = setup({ withDb: false });
  assert.equal(classify(cfg, NAME).wake, true, "súbor databázy chýba");
  const ok = setup({ events: [{ at: MTIME + 60_000 }] }).cfg;
  assert.equal(classify({ ...ok, taskerDb: undefined }, NAME).wake, true, "bez cfg.taskerDb");
  assert.equal(classify({ ...ok, name: undefined }, NAME).wake, true, "bez cfg.name");
  writeFileSync(join(cfg.box, "..", "zla.db"), "toto nie je sqlite");
  assert.equal(classify({ ...ok, taskerDb: join(cfg.box, "..", "zla.db") }, NAME).wake, true, "nečitateľná databáza");
});

test("správa, ktorá nie je od Taskera, ani s udalosťou agenta nie je dotknutá", () => {
  const { cfg } = setup({ events: [{ at: MTIME + 60_000 }] });
  const other = "boris-20261024-203933-1.md";
  writeFileSync(join(cfg.box, "inbox", other), `odpoveď: čakám\nTasker: úloha #${TASK}, text\n`);
  assert.equal(classify(cfg, other).wake, true);
});

test("replay 24. 10. 2026: komentár operátora 20:39:33Z (udalosť 2847), komentár agenta 20:40:26Z (2851, quiet 0): nebudí", () => {
  const at = (s) => Date.parse(`2026-10-24T${s}Z`);
  const { cfg } = setup({ events: [
    { at: at("20:39:33"), actor: "human:operator", kind: "comment" },
    { at: at("20:40:20"), actor: "human:adam", kind: "work", quiet: 1 },
    { at: at("20:40:26"), actor: "human:adam", kind: "comment" },
  ] });
  assert.equal(classify(cfg, NAME).wake, false);
});
