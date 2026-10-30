// context_warning.mjs: pod hranicou mlčí, nad ňou mimo T3 oznámenie,
// vo vlákne T3 pokyn ukončiť odpoveď riadkom z kontext.sh.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "context_warning.mjs");

function run(tokens, env) {
  const dir = mkdtempSync(join(tmpdir(), "ctxw-"));
  const tr = join(dir, "t.jsonl");
  writeFileSync(tr, JSON.stringify({ message: { usage: { input_tokens: 10, cache_read_input_tokens: tokens } } }) + "\n");
  const clean = { ...process.env };
  delete clean.T3CODE_HOME;
  const out = execFileSync("node", [HOOK], { input: JSON.stringify({ transcript_path: tr }), env: { ...clean, ...env } }).toString();
  return out ? JSON.parse(out).hookSpecificOutput.additionalContext : "";
}

test("pod hranicou mlčí", () => {
  assert.equal(run(70_000, {}), "");
});

test("mimo T3 oznámenie na riadku za menom, bez slova pre budič", () => {
  const c = run(150_000, {});
  assert.match(c, /Za riadkom s menom daj samostatný riadok "Kontext: 150 tisíc tokenov/);
  assert.doesNotMatch(c, /Odpoveď začni/);
  assert.doesNotMatch(c, /HOTOVO-KONTEXT/);
});

test("vo vlákne T3 uložiť, commitnúť a ukončiť odpoveď riadkom z kontext.sh (spanok predvolene)", () => {
  const c = run(150_000, { T3CODE_HOME: "/x" });
  assert.match(c, /logický celok práce hotový/);
  assert.match(c, /commitni, pushni/);
  assert.match(c, /kontext\.sh spanok --stav/);
  assert.match(c, /samostatný posledný riadok odpovede/);
  assert.match(c, /pokracuj --dalej/);
  assert.doesNotMatch(c, /Kontext: /);
});
