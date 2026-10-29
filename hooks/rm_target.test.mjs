// rm_target.mjs: zamietne rm s cieľom z $(...), spätného apostrofu alebo z nestráženej premennej.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { badRmTarget } from "./rm_target.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "rm_target.mjs");

// Hook sa púšťa len vstupom na stdin, rm sa nespúšťa nikdy.
function run(command, tool_name = "Bash") {
  const out = execFileSync("node", [HOOK], { input: JSON.stringify({ tool_name, tool_input: { command } }) }).toString();
  return out ? JSON.parse(out).hookSpecificOutput : null;
}

test("replay behu 118: rm s $(cat ...) sa zamietne s postupom", () => {
  const cmd = 'rm -rf "$(cat /tmp/dan-e2e-dir)" /tmp/dan-e2e-dir';
  assert.ok(badRmTarget(cmd));
  const r = run(cmd);
  assert.equal(r.permissionDecision, "deny");
  assert.match(r.permissionDecisionReason, /dangerousRemoval/);
  assert.match(r.permissionDecisionReason, /Správny postup:.*\$\{VAR:\?\}/);
});

test("nebezpečný cieľ v rôznych tvaroch a obaloch zamietne", () => {
  for (const cmd of [
    "rm -rf $(cat /tmp/x)",
    "rm -rf `cat /tmp/x`",
    'rm -rf "`cat /tmp/x`"',
    "rm -rf $DIR",
    'rm -rf "$DIR"',
    'rm -rf "${DIR}"',
    'rm -rf "${DIR:-/tmp/x}"',
    'rm -rf "$DIR/sub"',
    "rm -f -- $F",
    "rm /tmp/ok $F",
    "ls && rm -rf $D",
    "ls; rm -rf $D",
    "ls | rm $D",
    "true || rm -rf $D",
    "(cd /tmp && rm -rf $D)",
    "if true; then rm -rf $D; fi",
    "sudo rm -rf $D",
    "sudo -u tasker-svc rm -rf $D",
    "runuser -u tasker-svc -- rm -rf $D",
    "env X=1 rm -rf $D",
    "/bin/rm -rf $D",
    "echo x | xargs rm -rf $D",
    "ls | xargs -n1 rm $(pwd)/x",
    "bash -c 'rm -rf $D'",
    'bash -lc "rm -rf \\$D"',
    "sh -c 'ls; rm -rf $(cat f)'",
    "su - x -c 'rm -rf $D'",
    "runuser -u x -- bash -c 'rm -rf `cat f`'",
    "X=1 rm -rf $D",
    "timeout 5 rm -rf $D",
    "rm -rf $D 2>/dev/null",
  ]) assert.ok(badRmTarget(cmd), cmd);
});

test("strážená premenná, doslovná cesta a text o rm pustí", () => {
  for (const cmd of [
    'rm -rf "${T:?}"',
    'rm -rf "${T:?}/sub" /tmp/x',
    'rm -rf "${T:?cesta chýba}"',
    "rm -rf /tmp/x",
    "rm -f /tmp/a /tmp/b",
    "rm -rf 'a$b'",
    "rm -rf /tmp/\\$x",
    "rm -rf /tmp/x 2>/dev/null",
    "sudo rm -rf /tmp/x",
    "echo x | xargs rm -f",
    "grep rm $F",
    "grep -r 'rm -rf $D' .",
    'echo "rm -rf $D"',
    "echo rm $D",
    "ls $(cat x)",
    "cat <<EOF > f.sh\nrm -rf $D\nEOF",
    "cat <<'EOF'\nrm -rf $(cat x)\nEOF",
    'git commit -m "oprava rm $(x)"',
    "bash -c 'ls $D'",
    "bash script.sh $D",
    "form $D",
    "",
  ]) assert.equal(badRmTarget(cmd), null, cmd);
});

test("iný nástroj než Bash hook pustí ticho", () => {
  assert.equal(run('rm -rf "$(cat x)"', "Write"), null);
  assert.equal(run("rm -rf /tmp/x"), null);
});
