// Test strážcu D0141 (úloha 424) a shellového helpera lib/deny.sh: lib/deny_check.mjs
// zlyhá na hooku, ktorý zamieta mimo lib/deny.mjs a deny.sh. Helper deny.mjs
// a hooky tohto repa testuje test/deny.test.mjs. Nevolá živý Tasker, schránky
// ani T3. Spustenie: node --test test/deny_check.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { denyProblems } from "../lib/deny_check.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

test("shell: deny_postup s prázdnym postupom vráti 2, s postupom vypíše riadok", () => {
  const run = (call) => spawnSync("bash", ["-c", `source ${join(REPO, "lib", "deny.sh")}; ${call}`], { encoding: "utf8" });
  const bad = run('deny_postup "dôvod" ""');
  assert.equal(bad.status, 2);
  const good = run('deny_postup "dôvod" "git rebase origin/main"');
  assert.equal(good.status, 0);
  assert.match(good.stderr, /^dôvod\nSprávny postup: git rebase origin\/main\n$/);
});

test("strážca: repo je čisté", () => {
  assert.deepEqual(denyProblems(REPO), []);
});

test("strážca padne na hooku so surovým zamietnutím (replay pôvodného tasker_root.mjs)", () => {
  const dir = mkdtempSync(join(tmpdir(), "deny-fixture-"));
  try {
    mkdirSync(join(dir, "hooks")); mkdirSync(join(dir, "lib")); mkdirSync(join(dir, ".githooks"));
    // Pôvodné vyvolanie zamietnutia z tasker_root.mjs pred úlohou 424.
    writeFileSync(join(dir, "hooks", "stary.mjs"), `process.stdout.write(\n  JSON.stringify({\n    hookSpecificOutput: {\n      hookEventName: "PreToolUse",\n      permissionDecision: "deny",\n      permissionDecisionReason: \`\${MESSAGE} (\${why})\`,\n    },\n  }),\n);\n`);
    writeFileSync(join(dir, "hooks", "stop.mjs"), 'console.log(JSON.stringify({ decision: "block", reason }));\n');
    writeFileSync(join(dir, "hooks", "exit.mjs"), "if (v) { process.stderr.write(v); process.exit(2); }\n");
    writeFileSync(join(dir, "hooks", "komentar.mjs"), '// permissionDecision: "deny" len v komentári\nexport {};\n');
    writeFileSync(join(dir, "hooks", "ask.mjs"), "const o = { permissionDecision: decision };\n");
    writeFileSync(join(dir, "lib", "x_guard.sh"), 'rc=0\necho "Commit odmietnutý: x" >&2\nrc=1\nexit $rc\n');
    writeFileSync(join(dir, "lib", "y_guard.sh"), 'source "$here/deny.sh"\nrc=0\ndeny_postup "dôvod" ""\nrc=1\nexit $rc\n');
    writeFileSync(join(dir, ".githooks", "pre-commit"), 'node check.mjs || { echo "odmietnuté" >&2; exit 1; }\n');
    const p = denyProblems(dir);
    for (const want of ["hooks/stary.mjs:5:", "hooks/stop.mjs:1:", "hooks/exit.mjs:1:", "lib/x_guard.sh:2:", "lib/x_guard.sh: odmieta", "lib/y_guard.sh:3: deny_postup bez", ".githooks/pre-commit:1:"])
      assert.ok(p.some((l) => l.startsWith(want)), `${want} chýba v:\n${p.join("\n")}`);
    assert.ok(!p.some((l) => l.includes("komentar.mjs") || l.includes("ask.mjs")));
    // Po oprave (zamietnutie cez helper) strážca mlčí.
    writeFileSync(join(dir, "hooks", "stary.mjs"), 'import { denyTool } from "../lib/deny.mjs";\ndenyTool(reason, postup);\n');
    for (const f of ["stop", "exit"]) rmSync(join(dir, "hooks", f + ".mjs"));
    writeFileSync(join(dir, "lib", "x_guard.sh"), 'source "$here/deny.sh"\nrc=0\ndeny_postup "d" "krok"\nrc=1\nexit $rc\n');
    writeFileSync(join(dir, "lib", "y_guard.sh"), 'source "$here/deny.sh"\ndeny_postup "d" "krok"\nrc=1\n');
    writeFileSync(join(dir, ".githooks", "pre-commit"), 'source lib/deny.sh\nnode check.mjs || { deny_postup "d" "krok"; exit 1; }\n');
    assert.deepEqual(denyProblems(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
