// agent_defs.mjs: agents/implementator.md bez `model: sonnet` zlyhá.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { agentDefProblems, frontmatter, FILE } from "./agent_defs.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");

function copy(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "agdef-"));
  mkdirSync(join(dir, "agents"));
  if (mutate !== null) writeFileSync(join(dir, FILE), mutate);
  return dir;
}

test("skutočná definícia v repe prejde", () => {
  assert.deepEqual(agentDefProblems(REPO), []);
});

test("kópia bez riadku model: sonnet zlyhá", async () => {
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(join(REPO, FILE), "utf8");
  for (const bad of [
    text.replace(/^model: sonnet\n/m, ""),
    text.replace(/^model: sonnet$/m, "model: opus"),
    text.replace(/^model: sonnet$/m, "model: inherit"),
    text.replace(/^model: sonnet$/m, "# model: sonnet"),
  ]) {
    const dir = copy(bad);
    try {
      const p = agentDefProblems(dir);
      assert.equal(p.length, 1);
      assert.match(p[0], /model: sonnet/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});

test("`model: sonnet` v tele súboru, nie vo frontmatteri, nestačí", () => {
  const dir = copy("---\nname: implementator\n---\nmodel: sonnet\n");
  try { assert.equal(agentDefProblems(dir).length, 1); } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("chýbajúci súbor a chýbajúci frontmatter zlyhajú", () => {
  const a = copy(null), b = copy("model: sonnet\n");
  try {
    assert.match(agentDefProblems(a)[0], /chýba/);
    assert.match(agentDefProblems(b)[0], /frontmatter/);
  } finally { rmSync(a, { recursive: true, force: true }); rmSync(b, { recursive: true, force: true }); }
});
