// sed_line.mjs: sed -i s číslom riadku bez výpisu toho riadka v tom istom príkaze.
// Hook sa púšťa len vstupom na stdin, sed sa nespúšťa nikdy, súbory sa nevytvárajú.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { lineEditsWithoutPrint, sedCommands } from "./sed_line.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "sed_line.mjs");

function run(command, tool_name = "Bash") {
  const out = execFileSync("node", [HOOK], { input: JSON.stringify({ tool_name, tool_input: { command } }) }).toString();
  return out ? JSON.parse(out).hookSpecificOutput : null;
}

test("replay chyby 22. 10. 2026: sed -i '6s|.*|...|' bez výpisu sa zamietne s postupom", () => {
  const cmd = "sed -i '6s|.*|  --ok: #3fb950;|' docs/tasker-navrh.html";
  assert.equal(lineEditsWithoutPrint(cmd).length, 1);
  const r = run(cmd);
  assert.equal(r.permissionDecision, "deny");
  assert.match(r.permissionDecisionReason, /6s/);
  assert.match(r.permissionDecisionReason, /Správny postup:.*sed -n '6p'.*podľa obsahu/);
});

test("číslo riadku, rozsah, krok a posledný riadok bez výpisu zamietne", () => {
  for (const cmd of [
    "sed -i '6d' f",
    "sed -i '6,9d' f",
    "sed -i '6~2d' f",
    "sed -i '$d' f",
    "sed -i '3a nový riadok' f",
    "sed -i '3i nový riadok' f",
    "sed -i '3c nový riadok' f",
    "sed -i '1,3s/a/b/' f",
    "sed -i '6!d' f",
    "sed -i '6{s/a/b/}' f",
    "sed -i -e '/x/d' -e '6s/a/b/' f",
    "sed -i '/x/d;6s/a/b/' f",
    "sed -i '6s/a/b/;7d' f",
    "sed -i.bak '6s/a/b/' f",
    "sed -i'' '6s/a/b/' f",
    "sed -i '' '6s/a/b/' f",
    "sed --in-place '6s/a/b/' f",
    "sed --in-place=.bak '6s/a/b/' f",
    "sed -Ei '6s/(a)/\\1/' f",
    "sed -ni '6d' f",
    "sed -i -E '6s/a/b/' f",
    "sed -i -e 6d f",
    "sed -i --expression='6d' f",
    'sed -i "${N}s|a|b|" f',
    'sed -i "${N},${M}d" f',
    'sed -i "$((N+1))d" f',
    "cd /tmp && sed -i '6d' f",
    "ls; sed -i '6d' f",
    "ls | sed -i '6d' f",
    "true || sed -i '6d' f",
    "sh -c \"sed -i '6d' f\"",
    "bash -lc \"sed -i '6d' f\"",
    "runuser -u tasker-svc -- sed -i '6d' f",
    "sudo -u tasker-svc sed -i '6d' f",
    "sudo sed -i '6d' f",
    "env X=1 sed -i '6d' f",
    "/usr/bin/sed -i '6d' f",
    "x=$(sed -i '6d' f)",
    "echo ok && sed -i '6d' a b",
    "sed -n '5p' f && sed -i '6d' f",
    "sed -n '6p' g && sed -i '6d' f",
    "sed -n '6,9p' f && sed -i '5,9d' f",
    "sed -i '6d' f && sed -n '6p' f",
    "sed -i '$d' f && sed -n '6p' f",
    "sed -n '6p' f ; sed -i '9d;6d' f",
  ]) assert.ok(lineEditsWithoutPrint(cmd).length, cmd);
});

test("po výpise toho istého riadka toho istého súboru príkaz prejde", () => {
  for (const cmd of [
    "sed -n '6p' f && sed -i '6s|.*|x|' f",
    "sed -n '6p' f; sed -i '6d' f",
    "sed -n '6p' f\nsed -i '6d' f",
    "sed -n 6p f && sed -i 6d f",
    "sed -n '6,9p' f && sed -i '6,9d' f",
    "sed -n '5,10p' f && sed -i '6,9d' f",
    "sed -n '6,9p' f && sed -i '7d' f",
    "sed -n '6p;9p' f && sed -i '9d' f",
    "sed -n '6,9p' f && sed -i '6,/x/d' f",
    "sed -n '$p' f && sed -i '$d' f",
    "sed -n '6~2p' f && sed -i '6~2d' f",
    "sed -n p f && sed -i '6d' f",
    'sed -n "${N}p" f && sed -i "${N}s|a|b|" f',
    "sed -n '6p' ./f && sed -i '6d' f",
    "awk 'NR==6' f && sed -i '6d' f",
    "awk 'NR==6 {print}' f && sed -i '6d' f",
    "awk 'NR==6,NR==9' f && sed -i '7d' f",
    "awk 'NR>=6 && NR<=9' f && sed -i '6,9d' f",
    "cd /root/x && sed -n '6p' f && sed -i '6d' f",
    "sed -n '6p' a b && sed -i '6d' a",
    "sed -n '6p' a && sed -n '6p' b && sed -i '6d' a b",
    "sed -n '6{p;q}' f && sed -i '6d' f",
    "sh -c \"sed -n '6p' f && sed -i '6d' f\"",
    "X=$(sed -n '6p' f) && sed -i '6d' f",
    "sed -n '6p' f && sed -i '6d' f && sed -n '6p' f",
    "sed -n '6p' f | cat && sed -i '6d' f",
  ]) assert.deepEqual(lineEditsWithoutPrint(cmd), [], cmd);
});

test("adresa podľa obsahu, sed bez -i, skript zo súboru a text o sed prejdú", () => {
  for (const cmd of [
    "sed -i 's|starý|nový|' f",
    "sed -i 's|starý|nový|g' f",
    "sed -i '/vzor/d' f",
    "sed -i '/vzor/s|a|b|' f",
    "sed -i '/a/,/b/d' f",
    "sed -i '/a/,6d' f",
    "sed -i '0,/x/s//y/' f",
    "sed -i '\\|vzor|d' f",
    "sed -i -f skript.sed f",
    "sed -i 'y/abc/xyz/' f",
    "sed -n '6p' f",
    "sed -n '6,9p' f",
    "sed '6s|a|b|' f",
    "sed '6d' f > g",
    "sed -n '6p' f | head",
    "sed -n -e '6p' -e '7p' f",
    "echo \"sed -i '6d' f\"",
    "echo sed -i 6d f",
    "grep -n 'sed -i 6d' f",
    "grep sed -i 6d f",
    "# sed -i '6d' f",
    "ls # sed -i '6d' f",
    "git commit -m \"oprava sed -i '6d'\"",
    "cat <<'EOF'\nsed -i '6d' f\nEOF",
    "cat <<EOF > skript.sh\nsed -i '6d' f\nEOF",
    "python3 -c \"print('sed -i 6d')\"",
    "sed --version",
    "sed -i",
    "sed -i '6d'",
    "",
  ]) assert.deepEqual(lineEditsWithoutPrint(cmd), [], cmd);
});

test("parser skriptu sed zná bloky a text príkazov", () => {
  assert.deepEqual(sedCommands("6s|a;b|c;d|;7d").map((c) => [c.addr?.text, c.cmd]), [["6", "s"], ["7", "d"]]);
  assert.deepEqual(sedCommands("3a text; 5d\n7d").map((c) => [c.addr?.text, c.cmd]), [["3", "a"], ["7", "d"]]);
  assert.deepEqual(sedCommands("6{p;q}").map((c) => [c.addr?.text, c.cmd]), [["6", "p"], ["6", "q"]]);
  assert.deepEqual(sedCommands("/x/d;s/a/b/").map((c) => [c.addr?.kind, c.cmd]), [["re", "d"], [undefined, "s"]]);
});

test("iný nástroj než Bash hook pustí ticho", () => {
  assert.equal(run("sed -i '6d' f", "Write"), null);
  assert.equal(run("sed -i 's/a/b/' f"), null);
});
