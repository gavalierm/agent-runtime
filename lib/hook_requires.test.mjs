import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRequires, requiresProblems } from "./hook_requires.mjs";

const repo = mkdtempSync(join(tmpdir(), "requires-"));
test.after(() => rmSync(repo, { recursive: true, force: true }));
mkdirSync(join(repo, "hooks"));
const put = (name, text) => writeFileSync(join(repo, "hooks", name), text);

test("parseRequires číta len druhý riadok", () => {
  assert.deepEqual(parseRequires("#!/usr/bin/env node\n// requires: tasker, t3\n"), ["tasker", "t3"]);
  assert.deepEqual(parseRequires("// a\n// requires: none\n"), ["none"]);
  assert.equal(parseRequires("// requires: none\n// a\n"), null);
  assert.equal(parseRequires(""), null);
});

test("hook bez riadku, s cudzou hodnotou alebo s none a inou hodnotou je chyba", () => {
  put("ok.mjs", "#!/usr/bin/env node\n// requires: inbox\n");
  put("viac.mjs", "#!/usr/bin/env node\n// requires: mac, tasker\n");
  put("bez.mjs", "#!/usr/bin/env node\n// popis\n");
  put("cudzia.mjs", "#!/usr/bin/env node\n// requires: server\n");
  put("zmes.mjs", "#!/usr/bin/env node\n// requires: none, t3\n");
  put("ok.test.mjs", "nič\n");
  put("ok.replay.mjs", "nič\n");
  const p = requiresProblems(repo);
  assert.equal(p.length, 3, p.join("\n"));
  assert.ok(p.some((x) => x.startsWith("hooks/bez.mjs")));
  assert.ok(p.some((x) => x.startsWith("hooks/cudzia.mjs")));
  assert.ok(p.some((x) => x.startsWith("hooks/zmes.mjs")));
});

test("repo bez hooks/ nemá čo kontrolovať", () => {
  assert.deepEqual(requiresProblems(join(repo, "nie-je")), []);
});
