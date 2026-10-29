// secret_read.mjs: príkaz Bash, ktorý vypíše tajomstvo na obrazovku, a `claude setup-token`
// spustené priamo. Hook sa púšťa len vstupom na stdin, žiadny súbor sa nečíta
// ani nevytvára, `claude` sa nespúšťa nikdy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { secretOutput, secretReason } from "./secret_read.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "secret_read.mjs");

function run(command, tool_name = "Bash") {
  const out = execFileSync("node", [HOOK], { input: JSON.stringify({ tool_name, tool_input: { command } }) }).toString();
  return out ? JSON.parse(out).hookSpecificOutput : null;
}

test("replay chyby 23. 10. 2026: výpis tokenu a claude setup-token sa zamietne s postupom", () => {
  const cat = run("cat /root/.config/adam/claude_token");
  assert.equal(cat.permissionDecision, "deny");
  assert.match(cat.permissionDecisionReason, /úloha 449/);
  assert.match(cat.permissionDecisionReason, /Správny postup:.*setup_token\.sh.*test -f.*stat -c %a/);
  const st = run("claude setup-token");
  assert.equal(st.permissionDecision, "deny");
  assert.match(st.permissionDecisionReason, /Správny postup:.*\/root\/agentic-workflow\/setup_token\.sh/);
});

test("výpis súboru s tajomstvom v rôznych tvaroch a obaloch zamietne", () => {
  for (const cmd of [
    "cat ~/.config/adam/anything",
    "cat /root/.config/adam/t3.json",
    "cat /home/tasker-svc/.config/tasker/x",
    "cat $HOME/.config/adam/x",
    'cat "${HOME}/.config/adam/x"',
    "cat /opt/agentic-workflow/runtime.env",
    "cat /root/dan/runtime.env",
    "cat prod.env",
    "cat .env",
    "cat .env.local",
    "cat /tmp/api_token",
    "cat /tmp/my-secret.txt",
    "cat /tmp/credentials.json",
    "cat /tmp/key.pem",
    "cat /root/.ssh/id_ed25519",
    "cat ~/.ssh/id_rsa",
    "cat /root/.ssh/example-org-agent_adam",
    "head -c 50 /root/.config/adam/x",
    "head -n1 ~/.config/adam/x",
    "tail -n 3 /tmp/token",
    "tail -f /root/.config/adam/x",
    "less /tmp/token",
    "more /tmp/token",
    "bat /tmp/token",
    "tac /tmp/token",
    "nl /tmp/token",
    "xxd /tmp/token",
    "od -c /tmp/token",
    "strings /tmp/token",
    "base64 /tmp/token",
    "sed -n '1p' /tmp/token",
    "sed -n p ~/.config/adam/x",
    "sed 's/a/b/' /tmp/token",
    "grep . /tmp/token",
    "grep -n abc /root/.config/adam/x",
    "grep -rn abc /root/.config",
    "grep -e abc -e def /tmp/token",
    "egrep abc /tmp/token",
    "awk '{print}' /tmp/token",
    "awk -F: '{print $2}' /root/.config/adam/x",
    "cat < /tmp/token",
    "cat </tmp/token",
    "cat /tmp/a /tmp/token",
    "cat -n /tmp/token",
    "cat -- /tmp/token",
    "cat /tmp/token | tr a b",
    "cat /tmp/token | head -c 5",
    "cat /tmp/token 2>/dev/null",
    "cat /tmp/token 2>&1",
    "ls && cat /tmp/token",
    "ls; cat /tmp/token",
    "true || cat /tmp/token",
    "(cat /tmp/token)",
    "sh -c 'cat /tmp/token'",
    "bash -lc \"cat /root/.config/adam/x\"",
    "sudo cat /tmp/token",
    "sudo -u tasker-svc cat /tmp/token",
    "runuser -u tasker-svc -- cat /home/tasker-svc/.config/tasker/x",
    "env X=1 cat /tmp/token",
    "/bin/cat /tmp/token",
    "echo \"$(cat /tmp/token)\"",
    "echo x $(cat /root/.config/adam/x)",
    "printf '%s\\n' \"$(cat /tmp/token)\"",
    "cd /root/.config/adam && cat t3.json",
    "cd ~/.config/adam; head -c 5 x",
    "find /root/.config -type f -exec cat {} +",
    "find ~/.config/adam -name 'x*' -exec head -c 5 {} \\;",
    "python3 -c \"print(open('/root/.config/adam/x').read())\"",
    "python -c \"print(open('/tmp/token').read())\"",
    "python3 -c \"import pathlib; print(pathlib.Path('/tmp/api_token').read_text())\"",
    "node -e \"console.log(require('fs').readFileSync('/root/.config/adam/x','utf8'))\"",
    "node -p \"require('fs').readFileSync('/tmp/token','utf8')\"",
    "claude setup-token",
    "claude setup-token --foo",
    "/usr/local/bin/claude setup-token",
    "ls && claude setup-token",
    "sudo claude setup-token",
    "runuser -u tasker-svc -- claude setup-token",
    "sh -c 'claude setup-token'",
  ]) assert.ok(secretOutput(cmd), cmd);
});

test("ls, stat, test, wc, súčty, priradenie, source, grep -c a ďalšie neutajené použitie pustí", () => {
  for (const cmd of [
    "ls /root/.config/adam",
    "ls -la ~/.config/adam/token",
    "stat -c %a /root/.config/adam/x",
    "test -f /root/.config/adam/x",
    "[ -f /root/.config/adam/x ] && echo je",
    "[[ -s /tmp/token ]]",
    "chmod 600 /root/.config/adam/x",
    "chown root:root /tmp/token",
    "wc -c /tmp/token",
    "wc -l /root/.config/adam/x",
    "md5sum /tmp/token",
    "sha256sum /root/.config/adam/x",
    "file /tmp/token",
    "source /root/.config/adam/env.sh",
    ". /root/.config/adam/env.sh",
    "T=$(cat /root/.config/adam/x)",
    'T=$(cat ~/.config/adam/x) && curl -H "Authorization: Bearer $T" https://x',
    'curl -H "Authorization: Bearer $(cat /root/.config/adam/x)" https://x',
    "export T=$(cat /tmp/token)",
    "X=`cat /tmp/token`",
    "read -r T < /root/.config/adam/x",
    "while read -r l; do :; done < /tmp/token",
    "grep -c abc /tmp/token",
    "grep -l abc /root/.config/adam/x",
    "grep -q abc /tmp/token",
    "grep -rl abc /root/.config",
    "grep -L abc /tmp/token",
    "grep --count abc /tmp/token",
    "cat /tmp/token | wc -c",
    "cat /tmp/token | sha256sum",
    "cat /tmp/token | curl -d @- https://x",
    "cat /tmp/token > /tmp/copy",
    "cat /tmp/token >> /tmp/copy",
    "cat /root/.config/adam/x &> /dev/null",
    "cat /root/.ssh/id_ed25519.pub",
    "cat ~/.ssh/known_hosts",
    "cat ~/.ssh/config",
    "cat /root/.claude/settings.json",
    "cat settings.json",
    "cat /root/adam/hooks/secret_read.mjs",
    "cat hooks/secret_read.test.mjs",
    "cat design-tokens.css",
    "cat docs/token-audit.html",
    "cat memory/token_notes.md",
    ".env.example",
    "cat .env.example",
    "cat package.json",
    "cat /etc/hosts",
    "head -n 3 /root/adam/PERSONA.md",
    "grep token /root/adam/PERSONA.md",
    "grep -rn secret /root/adam/hooks",
    "grep -e token -e secret /root/adam/PERSONA.md",
    "sed -n '1p' /root/adam/PERSONA.md",
    "sed -i 's/a/b/' /tmp/token",
    "sed -i '' 's/a/b/' /root/.config/adam/x",
    "awk '{print}' /root/adam/PERSONA.md",
    "awk '/token/ {print}' /root/adam/PERSONA.md",
    "cp /root/.config/adam/x /tmp/x",
    "mv /tmp/token /tmp/token2",
    "rm /tmp/token",
    "echo /root/.config/adam/x",
    "echo cat /root/.config/adam/x",
    "echo 'cat /root/.config/adam/x'",
    "echo \"claude setup-token\"",
    "echo claude setup-token",
    "grep -rn 'claude setup-token' /root/adam",
    'git commit -m "výpis cat /root/.config/adam/x a claude setup-token"',
    "cat <<'EOF'\ncat /root/.config/adam/x\nclaude setup-token\nEOF",
    "# cat /root/.config/adam/x",
    "ls # cat /tmp/token",
    "/opt/agentic-workflow/setup_token.sh start",
    "setup_token.sh finish",
    "bash /opt/agentic-workflow/setup_token.sh start",
    "claude --version",
    "claude -p 'ahoj'",
    "python3 script.py",
    "python3 -c \"print('ahoj')\"",
    "python3 -c \"import json; print(json.load(open('/root/adam/package.json')))\"",
    "node -e \"console.log(1)\"",
    "node -e \"require('fs').readFileSync('/root/adam/package.json')\"",
    "find /root/adam -name '*.mjs' -exec cat {} +",
    "find /root/.config -type f",
    "find /root/.config -type f -exec chmod 600 {} +",
    "cd /root/adam && cat PERSONA.md",
    "cat $(ls /root/adam/*.md)",
    "",
  ]) assert.equal(secretOutput(cmd), null, cmd);
});

test("secretReason: pravidlá mien a ciest", () => {
  assert.ok(secretReason("/home/x/.config/y/z"));
  assert.ok(secretReason("~/.config/adam/anything"));
  assert.ok(secretReason("runtime.env"));
  assert.ok(secretReason("/a/b.env"));
  assert.ok(secretReason("/a/.envrc"));
  assert.ok(secretReason("id_ed25519"));
  assert.ok(secretReason("/a/id_rsa"));
  assert.ok(secretReason("/a/cert.pem"));
  assert.ok(secretReason("/a/Credentials"));
  assert.equal(secretReason("id_ed25519.pub"), null);
  assert.equal(secretReason("id_rsa.pub"), null);
  assert.equal(secretReason("/root/.claude/settings.json"), null);
  assert.equal(secretReason("/root/adam/hooks/secret_read.mjs"), null);
  assert.equal(secretReason("/a/.env.sample"), null);
  assert.equal(secretReason("/root/.configuration/x"), null);
  assert.equal(secretReason("/root/adam/.config.json"), null);
});

test("iný nástroj než Bash hook pustí ticho", () => {
  assert.equal(run("cat /root/.config/adam/x", "Write"), null);
  assert.equal(run("ls /root/.config/adam"), null);
});
