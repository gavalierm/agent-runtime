// compact_block.mjs: PreCompact skončí kódom 2 pre auto aj manual, iná udalosť prejde.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verdict } from "./compact_block.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "compact_block.mjs");
const run = (input) => spawnSync("node", [HOOK], { input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8" });

test("replay: automatická kompakcia sa zablokuje kódom 2 s postupom", () => {
  const r = run({ hook_event_name: "PreCompact", trigger: "auto", custom_instructions: null, session_id: "x", transcript_path: "/tmp/x.jsonl" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^automatická kompakcia: Kompakcia kontextu je zakázaný stav \(D0190/);
  assert.match(r.stderr, /Správny postup: po hotovom celku .*kontext\.sh spanok/);
});

test("/compact sa zablokuje tiež", () => {
  const r = run({ hook_event_name: "PreCompact", trigger: "manual", custom_instructions: "zhrň" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^\/compact: /);
});

test("iná udalosť a prázdny vstup prejdú", () => {
  assert.equal(verdict({ hook_event_name: "Stop" }), null);
  assert.equal(verdict(null), null);
  for (const input of [{ hook_event_name: "UserPromptSubmit", prompt: "x" }, ""]) {
    const r = run(input);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, "");
  }
});
