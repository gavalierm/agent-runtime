// shell_cmd.mjs: rozbor príkazu Bash na jednoduché príkazy (základ hookov sed_line a secret_read).
// Nič sa nespúšťa, len sa čítajú reťazce.
// Spustenie: node --test lib/shell_cmd.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { simpleCommands, stripComments, substitutions } from "./shell_cmd.mjs";

const heads = (cmd) => simpleCommands(cmd).map((c) => c.head);

test("predpony, shell -c a nové riadky sa rozbalia v poradí vykonania", () => {
  assert.deepEqual(heads("sudo -u x cat f; env A=1 head f | runuser -u y -- tail f"), ["cat", "head", "tail"]);
  assert.deepEqual(heads("sh -c 'ls && cat f'"), ["ls", "cat"]);
  assert.deepEqual(heads("bash -lc \"a; b\" && c"), ["a", "b", "c"]);
  assert.deepEqual(heads("su - x -c 'cat f'"), ["cat"]);
  assert.deepEqual(heads("/bin/cat f\nls"), ["cat", "ls"]);
});

test("text, komentár a heredoc nie sú príkazy", () => {
  assert.deepEqual(heads("echo 'cat f' # cat g"), ["echo"]);
  assert.deepEqual(heads("cat <<'EOF'\nrm x\nEOF\nls"), ["cat", "ls"]);
  assert.equal(stripComments("ls # x\nls '#y' # z"), "ls \nls '#y' ");
  assert.deepEqual(heads("echo a#b"), ["echo"]);
});

test("substitúcie sú captured, v echo nie", () => {
  const c = simpleCommands("X=$(cat f) && echo \"$(head g)\" && ls $(tail h)");
  assert.deepEqual(c.map((x) => [x.head, x.captured]), [["cat", true], ["head", false], ["echo", false], ["tail", true], ["ls", false]]);
  assert.deepEqual(substitutions("a $(b $(c)) `d`"), ["b $(c)", "d"]);
});

test("presmerovania a rúra", () => {
  const [a, b] = simpleCommands("cat f 2>&1 | wc -c");
  assert.deepEqual([a.head, a.args.map((x) => x.val), a.pipeNext, b.head], ["cat", ["f"], "wc", "wc"]);
  const [c] = simpleCommands("cat f > g");
  assert.equal(c.stdoutFile, true);
  assert.deepEqual(c.args.map((x) => x.val), ["f"]);
  const [d] = simpleCommands("cat < f");
  assert.deepEqual([d.stdin, d.stdoutFile], [["f"], false]);
  assert.equal(simpleCommands("cat f || ls")[0].pipeNext, null);
});
