// Test lib/path_check.mjs v dočasnom priečinku. Spustenie:
// node --test test/path_check.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPaths, declaredMissing, findPaths } from "../lib/path_check.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "path_check.mjs");
const repo = (files) => {
  const dir = mkdtempSync(join(tmpdir(), "pathc-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
};

test("findPaths nájde len cesty s prefixom v apostrofoch a číslo riadka", () => {
  const r = findPaths("a\nvidz `bin/x.sh` a `lib/y.mjs`, nie `foo/z` ani bin/w.sh\n");
  assert.deepEqual(r, [{ line: 2, path: "bin/x.sh" }, { line: 2, path: "lib/y.mjs" }]);
});

test("declaredMissing berie riadky tabuľky a odrážky len z jednej sekcie", () => {
  const md = "## Iné\n| `bin/a` | x |\n## Čo v repe nie je\n| cesta | popis |\n|---|---|\n| `bin/b.sh` | x |\n- `lib/c.mjs` x\ntext `hooks/d`\n## Ďalej\n| `bin/e` | x |\n";
  assert.deepEqual([...declaredMissing(md)].sort(), ["bin/b.sh", "lib/c.mjs"]);
});

test("chýbajúca cesta zlyhá, existujúca, zástupný vzor a zapísaná prejdú", () => {
  const dir = repo({
    "bin/je.sh": "",
    "PLAYBOOK.md": "ok `bin/je.sh`\nchýba `bin/nie.sh`\nvzor `rozhodnutia/D0xxx.md`\nzapísaná `lib/mimo.mjs`\n",
    "README.md": "## Čo v repe nie je\n| `lib/mimo.mjs` | x | y |\n",
  });
  try {
    assert.deepEqual(checkPaths(dir), ["PLAYBOOK.md:2 bin/nie.sh"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("node_modules sa nepreberá a cesta mimo sekcie README nestačí", () => {
  const dir = repo({
    "node_modules/p/README.md": "`bin/cudzie.sh`\n",
    "README.md": "| `bin/a.sh` | x |\n## Čo v repe nie je\n",
  });
  try {
    assert.deepEqual(checkPaths(dir), ["README.md:1 bin/a.sh"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skript skončí kódom 1 s riadkom súbor:riadok cesta a kódom 0 na čistom repe", () => {
  const bad = repo({ "A.md": "x\n`skills/chyba/SKILL.md`\n" });
  const good = repo({ "skills/chyba/SKILL.md": "", "A.md": "`skills/chyba/SKILL.md`\n" });
  try {
    const r = spawnSync("node", [SCRIPT], { env: { ...process.env, PATH_CHECK_ROOT: bad }, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /A\.md:2 skills\/chyba\/SKILL\.md/);
    const g = spawnSync("node", [SCRIPT], { env: { ...process.env, PATH_CHECK_ROOT: good }, encoding: "utf8" });
    assert.equal(g.status, 0);
  } finally { rmSync(bad, { recursive: true, force: true }); rmSync(good, { recursive: true, force: true }); }
});
