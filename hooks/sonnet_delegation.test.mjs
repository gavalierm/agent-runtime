// sonnet_delegation.mjs: pripomienka po N zápisových krokoch Opusu bez sub-agenta implementator.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync as mkdtempRaw, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reminder, countWrites, bashWrites, N } from "./sonnet_delegation.mjs";

// Dočasné priečinky testu sa na konci zmažú (úloha 701).
const tmpDirs = [];
const mkdtempSync = (prefix) => { const d = mkdtempRaw(prefix); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "sonnet_delegation.mjs");

const user = { type: "user", isSidechain: false, message: { role: "user", content: "urob to" } };
const asst = (model, ...uses) => ({
  type: "assistant", isSidechain: false,
  message: { model, content: uses.map((u) => ({ type: "tool_use", id: `t${Math.random()}`, ...u })) },
});
const edit = { name: "Edit", input: { file_path: "/x" } };
const turn = (model, n, extra = []) => [user, ...Array.from({ length: n }, () => asst(model, edit)), ...extra];
const cur = { tool_name: "Edit", tool_input: { file_path: "/x" } };

test("Opus, 6 zápisov (5 v transkripte + aktuálne) bez Agenta: pripomienka", () => {
  const out = reminder(cur, turn("claude-opus-4-8", N - 1));
  assert.match(out.hookSpecificOutput.additionalContext, /6 zápisových krokov/);
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
});

test("dvanásty krok je znova pripomienka", () => {
  assert.ok(reminder(cur, turn("claude-opus-4-8", 2 * N - 1)));
});

test("Agent s model sonnet v ťahu: nič", () => {
  const e = turn("claude-opus-4-8", N - 1, [asst("claude-opus-4-8", { name: "Agent", input: { model: "sonnet" } })]);
  assert.equal(reminder(cur, e), null);
});

test("Agent implementator bez modelu v ťahu: nič, s modelom opus ho nepočíta", () => {
  const e = (input) => turn("claude-opus-4-8", N - 1, [asst("claude-opus-4-8", { name: "Agent", input })]);
  assert.equal(reminder(cur, e({ subagent_type: "implementator", prompt: "x" })), null);
  assert.equal(reminder(cur, e({ subagent_type: "implementator", model: "sonnet" })), null);
  assert.ok(reminder(cur, e({ subagent_type: "implementator", model: "opus" })));
  assert.ok(reminder(cur, e({ subagent_type: "Explore" })));
});

test("text pripomienky volá sub-agenta menom implementator", () => {
  const out = reminder(cur, turn("claude-opus-4-8", N - 1));
  assert.match(out.hookSpecificOutput.additionalContext, /sub-agentovi implementator/);
  assert.match(out.hookSpecificOutput.additionalContext, /subagent_type "implementator"/);
});

test("Sonnet, agent_id a 5 zápisov: nič", () => {
  assert.equal(reminder(cur, turn("claude-sonnet-5-5", N - 1)), null);
  assert.equal(reminder({ ...cur, agent_id: "a1" }, turn("claude-opus-4-8", N - 1)), null);
  assert.equal(reminder(cur, turn("claude-opus-4-8", N - 2)), null);
});

test("Bash ls sa nepočíta, zápisový Bash áno", () => {
  const e = [user, asst("claude-opus-4-8", { name: "Bash", input: { command: "ls" } })];
  assert.equal(countWrites(e, { tool_name: "Bash", tool_input: { command: "ls" } }), 0);
  assert.ok(bashWrites("sed -i 's/a/b/' f"));
  assert.ok(bashWrites("echo x > f"));
  assert.ok(bashWrites("git commit -m x -- f"));
  assert.ok(!bashWrites("ls 2>/dev/null"));
  assert.ok(!bashWrites("node a.mjs 2>&1 | tail"));
});

test("nový ťah (text používateľa) vynuluje počet, tool_result nie", () => {
  const result = { type: "user", isSidechain: false, message: { content: [{ type: "tool_result", content: "ok" }] } };
  const e = [...turn("claude-opus-4-8", 3), result, ...turn("claude-opus-4-8", 2).slice(1)];
  assert.equal(countWrites(e, null), 5);
  assert.equal(countWrites([...turn("claude-opus-4-8", 4), user], null), 0);
});

test("prúd: transkript a stdout hooku, chýbajúci transkript nič", () => {
  const dir = mkdtempSync(join(tmpdir(), "sd-"));
  const p = join(dir, "t.jsonl");
  writeFileSync(p, turn("claude-fable-1", N - 1).map((x) => JSON.stringify(x)).join("\n"));
  const run = (i) => execFileSync("node", [HOOK], { input: JSON.stringify(i) }).toString();
  assert.match(JSON.parse(run({ ...cur, transcript_path: p })).hookSpecificOutput.additionalContext, /fable/);
  assert.equal(run(cur), "");
  assert.equal(run({ ...cur, transcript_path: "/nonexistent" }), "");
});
