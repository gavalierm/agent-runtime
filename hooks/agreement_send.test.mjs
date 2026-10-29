// agreement_send.mjs: správa so značkou "za <operátor>" po súhlase s jedným úkonom sa zamietne.
// Stav ide do dočasného priečinka a ask_agent.sh sa nevolá: hook príkaz len číta ako text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sendCall, verdict } from "./agreement_send.mjs";
import { stateFile } from "./agreement_scope.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
const STATE = mkdtempSync(join(tmpdir(), "agreement-send-"));
process.env.AGREEMENT_SCOPE_STATE = STATE;
process.on("exit", () => rmSync(STATE, { recursive: true, force: true }));
const env = { ...process.env, AGREEMENT_SCOPE_STATE: STATE };

const prompt = (text, session_id) =>
  execFileSync("node", [join(DIR, "agreement_scope.mjs")], { input: JSON.stringify({ prompt: text, session_id }), env }).toString();
const pre = (command, session_id) => {
  const out = execFileSync("node", [join(DIR, "agreement_send.mjs")], {
    input: JSON.stringify({ tool_name: "Bash", session_id, tool_input: { command } }),
    env,
  }).toString();
  return out ? JSON.parse(out).hookSpecificOutput : null;
};

const MSG = `/opt/agentic-workflow/bin/ask_agent.sh boris issue <<'EOF'
[Cyril za Oskara] Založ žiadosť o zmenu a cez Rona vypni službu.
EOF`;

test("replay Cyrilho prípadu: Ano, zaloz issue a správa s dvoma úkonmi je zamietnutá", () => {
  prompt("Ano, zaloz issue", "s610");
  const out = pre(MSG, "s610");
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /len s úkonom "zaloz issue"/);
  assert.ok(out.permissionDecisionReason.includes("Správny postup:"));
  assert.ok(existsSync(stateFile("s610")));
});

test("s AGREEMENT_SCOPE_CHECKED=1 správa prejde a stav sa zmaže", () => {
  prompt("Ano, zaloz issue", "s610x");
  assert.equal(pre(`AGREEMENT_SCOPE_CHECKED=1 ${MSG}`, "s610x"), null);
  assert.equal(existsSync(stateFile("s610x")), false);
  assert.equal(pre(MSG, "s610x"), null);
});

test("holé súhlasím nič nezamietne", () => {
  prompt("súhlasím", "s610h");
  assert.equal(pre(MSG, "s610h"), null);
});

test("reply.sh so značkou sa zamietne, správa bez značky a iné príkazy prejdú", () => {
  prompt("ok, posli to Ronovi", "s610r");
  assert.equal(pre("AGENT_NAME=cyril /opt/agentic-workflow/reply.sh 12 <<'EOF'\n[Cyril za Oskara] hotovo\nEOF", "s610r").permissionDecision, "deny");
  assert.equal(pre("/opt/agentic-workflow/bin/ask_agent.sh boris t <<'EOF'\nbez značky\nEOF", "s610r"), null);
  assert.equal(pre('echo "[Cyril za Oskara] ask_agent.sh"', "s610r"), null);
  assert.equal(pre("ls /tmp", "s610r"), null);
});

test("iná relácia stav nemá", () => {
  prompt("ok, zaloz issue", "s610A");
  assert.equal(pre(MSG, "s610B"), null);
});

test("ďalšia správa operátora stav zruší, takže správa prejde", () => {
  prompt("ok, zaloz issue", "s610n");
  prompt("a ešte raz všetko", "s610n");
  assert.equal(pre(MSG, "s610n"), null);
});

test("sendCall a verdict ako funkcie", () => {
  assert.deepEqual(sendCall("sh ask_agent.sh a b"), { checked: false });
  assert.equal(sendCall("grep ask_agent.sh x"), null);
  assert.equal(verdict(MSG, null), null);
});
