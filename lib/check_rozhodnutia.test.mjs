// Test, že check.mjs volá kontrolu záznamov rozhodnutí a že zrušené záznamy
// idú do kontroly zrušených tvrdení. Beží nad test/fixtures/rozhodnutia-*,
// ROZHODNUTIA_DIR ukáže check.mjs na fixtúru, živý register sa nečíta.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { retiredClaims, stalePaths } from "./doc_paths.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const fx = (n) => join(REPO, "test", "fixtures", n, "decisions");
const run = (n) => spawnSync("node", [join(REPO, "check.mjs"), "--quiet"], { encoding: "utf8", env: { ...process.env, ROZHODNUTIA_DIR: fx(n) } });

test("dva platné záznamy s rovnakým kľúčom: check.mjs kód 1 a dôvod menuje kľúč aj oba záznamy", () => {
  const r = run("rozhodnutia-dva-kluce");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /rozhodnutia: kľúč server\.t3\.sandbox má viac platných záznamov: D0001, D0002/);
});

test("moc mimo rozsahu: check.mjs kód 1", () => {
  const r = run("rozhodnutia-moc-mimo");
  assert.equal(r.status, 1);
  assert.match(r.stdout, /D0001\.md: moc pracovny-agent nestačí na rozsah pravidla/);
});

// Celý check.mjs číta aj živé klony agentov, ich chyby s rozhodnutiami
// nesúvisia. Test preto overuje len riadky rozhodnutia:.
test("čistá fixtúra: check.mjs nehlási nič o rozhodnutiach", () => {
  const r = run("rozhodnutia-ciste");
  assert.doesNotMatch(r.stdout, /rozhodnutia:|D\d{4}\.md:/, r.stdout);
});

test("zrušený záznam so vzorom zastaví vetu v dokumente, platný nie", () => {
  const d = mkdtempSync(join(tmpdir(), "zrus-"));
  try {
    const f = join(d, "PERSONA.md");
    writeFileSync(f, "Pravidlo: sandbox Chromu je vypnutý.\n");
    const claims = retiredClaims(join(d, "nie-je.txt"), fx("rozhodnutia-zrusene"));
    const p = stalePaths([f], [d], d, claims);
    assert.equal(p.length, 1);
    assert.match(p[0], /PERSONA\.md:1 zrušené tvrdenie, D0001 Sandbox Chromu ostáva zapnutý/);
    assert.deepEqual(stalePaths([f], [d], d, retiredClaims(join(d, "nie-je.txt"), fx("rozhodnutia-ciste"))), []);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("vzor zo záznamu v stave platí zastaví vetu v dokumente (replay S2, úloha 404)", () => {
  const d = mkdtempSync(join(tmpdir(), "zrus-"));
  try {
    const dir = join(d, "decisions");
    mkdirSync(dir);
    writeFileSync(join(dir, "D0001.md"), readFileSync(join(fx("rozhodnutia-zrusene"), "D0001.md"), "utf8")
      .replace("stav: zrušené", "stav: platí").replace("sandbox Chromu je vypnutý", "bez mockupu"));
    const f = join(d, "MEMORY.md");
    writeFileSync(f, "- Zmeny idú na dev bez mockupu.\n");
    const p = stalePaths([f], [d], d, retiredClaims(join(d, "nie-je.txt"), dir));
    assert.equal(p.length, 1);
    assert.match(p[0], /MEMORY\.md:1 zrušené tvrdenie, D0001/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
