// Hook objection_fix.mjs ako proces: replay uznanej chyby bez chyba.sh (úloha 426,
// D0142), HOME v tmp, živý Tasker ani register chýb sa nepoužijú.
import "../lib/git_isolate.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "../hooks/objection_fix.mjs");
const dir = mkdtempSync(join(tmpdir(), "objection-"));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function hook(text, cmds) {
  const lines = [
    { type: "user", message: { content: "pokyn" } },
    { type: "assistant", message: { content: [{ type: "text", text }, ...cmds.map((command) => ({ type: "tool_use", name: "Bash", input: { command } }))] } },
  ];
  const p = join(dir, "t.jsonl");
  writeFileSync(p, lines.map((e) => JSON.stringify(e)).join("\n"));
  const r = spawnSync("node", [HOOK], { input: JSON.stringify({ transcript_path: p }), encoding: "utf8", env: { PATH: process.env.PATH, HOME: dir } });
  return r.stdout ? JSON.parse(r.stdout) : null;
}

test("replay 390 a 420: hook zastaví ťah, ktorý uzná chybu bez chyba.sh", () => {
  for (const t of ["Máš pravdu, úloha 390 ostala todo. Opravil som hook v 1a2b3c4.", "Moja chyba, úloha 420 ostala todo. Hook 1a2b3c4."]) {
    const o = hook(t, ["git add hooks/todo_after_comment.mjs && git commit -qm x -- hooks/todo_after_comment.mjs"]);
    assert.equal(o.decision, "block");
    assert.match(o.reason, /chyba\.sh/);
    assert.match(o.reason, /Správny postup: .*bin\/chyba\.sh --trieda/s);
  }
});

test("hook pustí ťah, ktorý uznal chybu, spustil chyba.sh a commitol opravu", () => {
  const o = hook("Máš pravdu. Opravil som hook v 1a2b3c4.", ["git add hooks/x.mjs && git commit -qm x -- hooks/x.mjs", "/opt/agentic-workflow/bin/chyba.sh --trieda t --subor hooks/x.mjs"]);
  assert.equal(o, null);
});

test("hook pustí ťah bez uznania chyby", () => {
  assert.equal(hook("Hotovo.", ["ls"]), null);
});
