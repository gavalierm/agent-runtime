// implementator_model.mjs: Agent so subagent_type implementator s iným modelom než Sonnet sa zamietne.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { badModel, noWorktree } from "./implementator_model.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "implementator_model.mjs");

const WT = { isolation: "worktree" };

// Hook sa púšťa len vstupom na stdin, sub-agent sa nespúšťa nikdy.
function run(tool_input, tool_name = "Agent") {
  const out = execFileSync("node", [HOOK], { input: JSON.stringify({ tool_name, tool_input }) }).toString();
  return out ? JSON.parse(out).hookSpecificOutput : null;
}

test("model opus pri implementatorovi: zamietnutie s postupom", () => {
  const r = run({ subagent_type: "implementator", model: "opus", isolation: "worktree", prompt: "x" });
  assert.equal(r.permissionDecision, "deny");
  assert.match(r.permissionDecisionReason, /Model: opus/);
  assert.match(r.permissionDecisionReason, /Správny postup:.*bez parametra `model`/);
});

test("zamietne aj starý názov nástroja Task a iné modely", () => {
  assert.match(run({ subagent_type: "implementator", model: "haiku", ...WT }, "Task").permissionDecisionReason, /Model: haiku/);
  assert.match(run({ subagent_type: "implementator", model: "claude-opus-4-8", ...WT }).permissionDecisionReason, /Model: claude-opus/);
  assert.match(run({ subagent_type: "implementator", model: "fable", ...WT }).permissionDecisionReason, /Model: fable/);
});

test("sonnet, id claude-sonnet a chýbajúci model prejdú (s worktree)", () => {
  assert.equal(badModel({ tool_name: "Agent", tool_input: { subagent_type: "implementator", model: "sonnet" } }), null);
  assert.equal(badModel({ tool_name: "Agent", tool_input: { subagent_type: "implementator", model: "claude-sonnet-5-5" } }), null);
  assert.equal(badModel({ tool_name: "Agent", tool_input: { subagent_type: "implementator" } }), null);
  assert.equal(run({ subagent_type: "implementator", ...WT }), null);
  assert.equal(run({ subagent_type: "implementator", model: "sonnet", ...WT }), null);
});

test("implementator bez isolation: zamietnutie s postupom (aj model sonnet)", () => {
  for (const ti of [{ subagent_type: "implementator" }, { subagent_type: "implementator", model: "sonnet" }, { subagent_type: "implementator", isolation: "none" }]) {
    const r = run(ti);
    assert.equal(r.permissionDecision, "deny");
    assert.match(r.permissionDecisionReason, /Správny postup:.*isolation: "worktree"/);
    assert.match(r.permissionDecisionReason, /jediný zapisovateľ/);
  }
  assert.ok(run({ subagent_type: "implementator" }, "Task"));
});

test("implementator s isolation worktree prejde, iný typ bez isolation tiež", () => {
  assert.equal(noWorktree({ tool_name: "Agent", tool_input: { subagent_type: "implementator", isolation: "worktree" } }), false);
  assert.equal(noWorktree({ tool_name: "Agent", tool_input: { subagent_type: "implementator" } }), true);
  assert.equal(noWorktree({ tool_name: "Agent", tool_input: { subagent_type: "Explore" } }), false);
  assert.equal(run({ subagent_type: "Explore" }), null);
});

test("iný typ sub-agenta alebo iný nástroj hook nezaujíma", () => {
  assert.equal(run({ subagent_type: "Explore", model: "opus" }), null);
  assert.equal(run({ model: "opus" }), null);
  assert.equal(run({ subagent_type: "implementator", model: "opus" }, "Bash"), null);
});

test("prázdny alebo pokazený vstup nič", () => {
  assert.equal(execFileSync("node", [HOOK], { input: "" }).toString(), "");
  assert.equal(execFileSync("node", [HOOK], { input: "{nie json" }).toString(), "");
});
