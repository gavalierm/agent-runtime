// subagent_foreground.mjs: zamietne príkaz na pozadí sub-agenta, hlavné vlákno pustí.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "subagent_foreground.mjs");

function run(input) {
  const out = execFileSync("node", [HOOK], { input: JSON.stringify(input) }).toString();
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : "";
}

test("replay 24. 10. 2026: npm test na pozadí sub-agenta úlohy 497 zamietne", () => {
  assert.equal(run({ agent_id: "a243054f", agent_type: "general-purpose", tool_name: "Bash", tool_input: { command: "npm test", run_in_background: true } }), "deny");
  assert.equal(run({ agent_id: "a1", tool_name: "Monitor", tool_input: {} }), "deny");
});

test("hlavné vlákno a príkaz v popredí pustí", () => {
  assert.equal(run({ tool_name: "Bash", tool_input: { command: "npm test", run_in_background: true } }), "");
  assert.equal(run({ agent_id: "a1", tool_name: "Bash", tool_input: { command: "timeout 300 npm test" } }), "");
});
