// no_model_wait.mjs: zamietne čakanie v popredí, pustí krátku pauzu
// a príkaz na pozadí.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { waitReason } from "./no_model_wait.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "no_model_wait.mjs");

function run(tool_input) {
  const out = execFileSync("node", [HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input }) }).toString();
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : "";
}

test("dnešné príkazy zo záznamu zamietne", () => {
  assert.ok(waitReason("sleep 45; ls /var/lib/adam/inbox"));
  assert.ok(waitReason("timeout 120 bash -c 'until [ ! -e /var/lib/adam/inbox/x ]; do sleep 2; done'"));
  assert.ok(waitReason("while true; do tasker list; sleep 5; done"));
  assert.ok(waitReason("sleep 2m"));
  assert.equal(run({ command: "sleep 45; ls" }), "deny");
});

test("krátku pauzu a bežný príkaz pustí", () => {
  assert.equal(waitReason("systemctl restart x && sleep 3 && systemctl is-active x"), null);
  assert.equal(waitReason("grep -n sleep runtime/driver.mjs"), null);
  assert.equal(run({ command: "sleep 5" }), "");
});

test("text v heredocu pustí, príkaz za ním posúdi", () => {
  assert.equal(waitReason("ask_agent.sh boris x <<'EOF'\nOver: sleep 45 vráti deny.\nEOF"), null);
  assert.equal(waitReason("python3 - <<'PY'\ntime.sleep(60)\nwhile x: sleep 1\nPY"), null);
  assert.ok(waitReason("cat <<EOF\ntext\nEOF\nsleep 60"));
});

test("text v úvodzovkách pustí, spúšťaný reťazec posúdi", () => {
  assert.equal(waitReason(`echo '{"tool_name":"Bash","tool_input":{"command":"sleep 45"}}' | node hook.mjs`), null);
  assert.equal(waitReason("tasker comment 13 --body '... sleep 45: hook ho zamietol ...'"), null);
  assert.equal(waitReason('tasker comment 13 --body "until x; do sleep 45; done"'), null);
  assert.ok(waitReason("sleep 45"));
  assert.ok(waitReason("bash -c 'sleep 45'"));
  assert.ok(waitReason('eval "sleep 45"'));
  assert.ok(waitReason("ssh host 'sleep 45'"));
  assert.ok(waitReason('x="$(sleep 45)"'));
  assert.ok(waitReason("echo 'a'; sleep 45"));
});

test("príkaz na pozadí pustí", () => {
  assert.equal(run({ command: "until [ -e f ]; do sleep 30; done", run_in_background: true }), "");
});

test("pokyn: na koniec behu wait --until a kontrola behov, blokér len na done úlohy (úlohy 582, 596)", async () => {
  const { POSTUP, MESSAGE } = await import("./no_model_wait.mjs");
  for (const t of [POSTUP, MESSAGE]) {
    assert.ok(t.includes("tasker wait"), "wait --until na koniec behu");
    assert.ok(t.includes("run list"), "kontrola behov po zobudení");
    assert.ok(t.includes("done"), "blokér čaká na done úlohy");
    assert.ok(!/jej behu zapíš|jej beh čakaj blokérom|na koniec[^.]*`tasker block/.test(t), "blokér na beh sa neradí");
  }
  assert.ok(POSTUP.indexOf("tasker wait") < POSTUP.indexOf("run_in_background"));
  assert.ok(MESSAGE.includes("úloha 596"));
});
