import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync as mkdtempRaw, mkdirSync, writeFileSync, existsSync, utimesSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "../morning.mjs";
import { config } from "../lib.mjs";

// Dočasné priečinky testu sa na konci zmažú (úloha 701).
const tmpDirs = [];
const mkdtempSync = (prefix) => { const d = mkdtempRaw(prefix); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

// Všetko v mkdtemp, cfg nesie len dočasné schránky, stub nahrádza tasker.
function boxes() {
  const root = mkdtempSync(join(tmpdir(), "adam-sweep-"));
  const mk = (n) => {
    const box = join(root, n);
    for (const d of ["inbox", "processed"]) mkdirSync(join(box, d), { recursive: true });
    return box;
  };
  return { adam: mk("adam"), boris: mk("boris") };
}

function put(box, name, text, ageH, now) {
  const p = join(box, "inbox", name);
  writeFileSync(p, text);
  const t = (now - ageH * 3600 * 1000) / 1000;
  utimesSync(p, t, t);
  return p;
}

const stub = () => "tasker ok";
const NOW = Date.now();

test("ranný súhrn odnesie každú držanú správu na vedomie, aj čerstvú, a vypíše ich", () => {
  const b = boxes();
  put(b.adam, "boris-tema-20261020-100000.md", "odpoveď: na vedomie\nid: x\nod: boris\nkomu: adam\ntéma: tema\n\nPrvý riadok obsahu\nDruhý\n", 30, NOW);
  put(b.boris, "adam-20261020-100000.md", "odpoveď: na vedomie\n\nHlásenie pre Borisa\n", 25, NOW);
  put(b.adam, "boris-20261023-100000.md", "odpoveď: na vedomie\n\nČerstvá\n", 2, NOW);
  put(b.adam, "boris-20261020-110000.md", "odpoveď: čakám\n\nStará, ale budí\n", 40, NOW);
  put(b.adam, "boris-20261020-120000.md", "Bez hlavičky\n", 40, NOW);
  const out = build({ sweepBoxes: [b.adam, b.boris] }, stub, NOW);
  assert.match(out, /Držané správy na vedomie, presunuté.*\(3\)/);
  assert.match(out, /- adam, od boris, téma tema: Prvý riadok obsahu \(.*processed\/boris-tema-20261020-100000\.md\)/);
  assert.match(out, /- boris, od adam, téma bez témy: Hlásenie pre Borisa/);
  assert.ok(existsSync(join(b.adam, "processed/boris-tema-20261020-100000.md")));
  assert.ok(!existsSync(join(b.adam, "inbox/boris-tema-20261020-100000.md")));
  assert.ok(existsSync(join(b.boris, "processed/adam-20261020-100000.md")));
  assert.ok(existsSync(join(b.adam, "processed/boris-20261023-100000.md")));
  assert.match(out, /Čerstvá/);
  for (const n of ["boris-20261020-110000.md", "boris-20261020-120000.md"]) {
    assert.ok(existsSync(join(b.adam, "inbox", n)), n);
  }
  assert.doesNotMatch(out, /budí|Bez hlavičky/);
});

test("bez držanej správy na vedomie súhrn časť nemá a budiaca ostane", () => {
  const b = boxes();
  put(b.adam, "boris-20261023-100000.md", "odpoveď: čakám\n\nBudí\n", 2, NOW);
  const out = build({ sweepBoxes: [b.adam, b.boris] }, stub, NOW);
  assert.doesNotMatch(out, /Držané správy/);
  assert.ok(existsSync(join(b.adam, "inbox/boris-20261023-100000.md")));
});

test("meno už v processed sa neprepíše a cfg bez sweepBoxes nič nerobí", () => {
  const b = boxes();
  writeFileSync(join(b.adam, "processed/boris-20261020-100000.md"), "stará kópia");
  put(b.adam, "boris-20261020-100000.md", "odpoveď: na vedomie\n\nNová\n", 30, NOW);
  assert.doesNotMatch(build({}, stub, NOW), /Držané správy/);
  const out = build({ sweepBoxes: [b.adam] }, stub, NOW);
  assert.match(out, /Nová/);
  assert.equal(readFileSync(join(b.adam, "processed/boris-20261020-100000.md"), "utf8"), "stará kópia");
});

test("config: schránky na odnos z AGENT_SWEEP_BOXES alebo z vlastnej schránky a trás odpovede", () => {
  assert.deepEqual(config({ AGENT_BOX: "/a/adam", AGENT_REPLY_ROUTE_boris: "/a/boris/inbox" }).sweepBoxes, ["/a/adam", "/a/boris"]);
  assert.deepEqual(config({ AGENT_BOX: "/a/adam", AGENT_SWEEP_BOXES: "/x:/y" }).sweepBoxes, ["/x", "/y"]);
});
