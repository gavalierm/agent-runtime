import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deadCode, deadCodeProblems, parseAllow } from "./dead_code.mjs";

const repo = mkdtempSync(join(tmpdir(), "dead-"));
test.after(() => rmSync(repo, { recursive: true, force: true }));
const put = (rel, text = "x\n", mode = 0o644) => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
  chmodSync(join(repo, rel), mode);
};

put("hooks/used.mjs");
put("hooks/imported.mjs");
put("hooks/dead.mjs");
put("hooks/only_test.mjs");
put("hooks/only_readme.mjs");
put("hooks/entry.mjs", 'import "./imported.mjs";\n');
put("hooks/entry.test.mjs", 'import "./only_test.mjs";\n');
put("lib/kontext.mjs");
put("kontext.mjs");
put("lib/user.mjs", 'import "./kontext.mjs";\n');
put("bin/tk", "#!/bin/sh\n", 0o755);
put("bin/caller.sh", 'exec "$HERE/../bin/tk"\n');
put("brain/bin/pre-commit", "#!/bin/sh\n", 0o755);
put("brain/bin/check.sh", 'cp "$BRAIN/bin/pre-commit" x\n');
put("skills/a/scripts/run.sh");
put("skills/a/SKILL.md", "Spusti `scripts/run.sh`.\n");
put("skills/b/scripts/orphan.sh");
put("README.md", "hooks/only_readme.mjs a hooks/dead.mjs\n");
put("settings.json", '{"command": "node hooks/used.mjs"}\n');
put("test/helper.sh", "hooks/dead.mjs\n");
put("data/notes.txt", "hooks/dead.mjs\n");

test("mŕtvy je súbor bez zmienky mimo seba, testov a dokumentov", () => {
  const { dead } = deadCode(repo);
  assert.deepEqual(dead, [
    "bin/caller.sh", "brain/bin/check.sh", "hooks/dead.mjs", "hooks/entry.mjs", "hooks/only_readme.mjs",
    "hooks/only_test.mjs", "kontext.mjs", "lib/user.mjs", "skills/b/scripts/orphan.sh",
  ]);
});

test("rovnaké meno v koreni a v lib/ sa rozlíši podľa cesty a importu", () => {
  const { dead } = deadCode(repo);
  assert.ok(!dead.includes("lib/kontext.mjs"), "lib/kontext.mjs importuje lib/user.mjs");
  assert.ok(dead.includes("kontext.mjs"), "koreňový kontext.mjs nikto nevolá");
});

test("extensionless skript sa nájde podľa bin/<meno>, skill podľa SKILL.md", () => {
  const { dead } = deadCode(repo);
  assert.ok(!dead.includes("bin/tk"));
  assert.ok(!dead.includes("brain/bin/pre-commit"));
  assert.ok(!dead.includes("skills/a/scripts/run.sh"));
  assert.ok(!dead.includes("hooks/used.mjs"), "zmienka v settings.json stačí");
});

test("výnimky: dôvod je povinný, zbytočná výnimka a neznámy súbor sú chyby", () => {
  const all = ["bin/caller.sh", "brain/bin/check.sh", "hooks/only_readme.mjs", "hooks/only_test.mjs", "kontext.mjs", "lib/user.mjs", "skills/b/scripts/orphan.sh"];
  put("lib/dead_code_allow.txt", [
    "# komentár",
    "hooks/dead.mjs dôvod",
    "hooks/entry.mjs",
    "hooks/used.mjs dôvod",
    "hooks/nie_je.mjs dôvod",
    ...all.map((a) => `${a} dôvod`),
  ].join("\n") + "\n");
  const p = deadCodeProblems(repo);
  assert.deepEqual(parseAllow("# a\nx.mjs dôvod\ny.mjs\n").map((e) => [e.path, e.reason]), [["x.mjs", "dôvod"], ["y.mjs", ""]]);
  assert.ok(p.some((x) => /:3: výnimka hooks\/entry\.mjs nemá dôvod/.test(x)), p.join("\n"));
  assert.ok(p.some((x) => /hooks\/used\.mjs netreba/.test(x)), p.join("\n"));
  assert.ok(p.some((x) => /hooks\/nie_je\.mjs nie je súbor/.test(x)), p.join("\n"));
  assert.ok(p.some((x) => /^mŕtvy kód hooks\/entry\.mjs/.test(x)), "výnimka bez dôvodu súbor neskryje");
  assert.ok(!p.some((x) => x.startsWith("mŕtvy kód hooks/dead.mjs")));
});
