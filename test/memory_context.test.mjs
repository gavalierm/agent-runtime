// memory_context.mjs: index pamäte agenta v kontexte SessionStart.
// Fixtúra je dočasný priečinok v /tmp, žiadny živý systém.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "../hooks/memory_context.mjs");

function run({ persona = "# Xaver\n", memory = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "memctx-"));
  try {
    if (persona !== null) writeFileSync(join(dir, "PERSONA.md"), persona);
    if (memory !== null) {
      mkdirSync(join(dir, "memory"));
      writeFileSync(join(dir, "memory", "MEMORY.md"), memory);
    }
    const r = spawnSync("node", [HOOK], {
      input: JSON.stringify({ session_id: "test1234", cwd: dir }),
      env: { PATH: process.env.PATH, HOME: dir, CLAUDE_PROJECT_DIR: "" },
    });
    assert.equal(r.status, 0, r.stderr.toString());
    const out = r.stdout.toString();
    return out ? JSON.parse(out).hookSpecificOutput : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const mem = (n) => Array.from({ length: n }, (_, i) => `- položka ${i + 1}`).join("\n") + "\n";

test("s pamäťou vráti prvý riadok MEMORY.md v additionalContext", () => {
  const o = run({ memory: "# Pamäť\n- prvá\n" });
  assert.equal(o.hookEventName, "SessionStart");
  assert.match(o.additionalContext, /^Pamäť agenta \(memory\/MEMORY\.md, prvých 200 riadkov;/);
  assert.match(o.additionalContext, /# Pamäť\n- prvá/);
  assert.doesNotMatch(o.additionalContext, /zvyšok prečítaj/);
});

test("250 riadkov oreže na 200 a pridá riadok o zvyšku", () => {
  const c = run({ memory: mem(250) }).additionalContext;
  assert.match(c, /- položka 200\n/);
  assert.doesNotMatch(c, /- položka 201\b/);
  assert.match(c, /MEMORY\.md má 250 riadkov, zobrazených 200, zvyšok prečítaj zo súboru\./);
});

test("presne 200 riadkov nič neoreže", () => {
  const c = run({ memory: mem(200) }).additionalContext;
  assert.match(c, /- položka 200$/);
  assert.doesNotMatch(c, /zvyšok prečítaj/);
});

test("bez PERSONA.md mlčí", () => {
  assert.equal(run({ persona: null, memory: "# Pamäť\n" }), null);
});

test("bez MEMORY.md mlčí", () => {
  assert.equal(run({ memory: null }), null);
});
