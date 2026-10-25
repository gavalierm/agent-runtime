import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const RUNTIME = join(dirname(fileURLToPath(import.meta.url)), "..");
const NAME = "boris-adam_server-20261018-120000-1.md";

// Dočasná schránka a stav, env súbor na neexistujúci súbor: test nesiahne
// na /var/lib ani ~/.config skutočných agentov.
function prostredie() {
  const root = mkdtempSync(join(tmpdir(), "reply-rt-"));
  const box = join(root, "box");
  for (const d of ["inbox", "outbox", "processed"]) mkdirSync(join(box, d), { recursive: true });
  writeFileSync(join(box, "processed", NAME), `odpoveď: čakám\nid: ${NAME}\nod: boris\nkomu: adam\ntéma: adam_server\nPokyn\n`);
  const env = { ...process.env, AGENT_NAME: "adam", AGENT_BOX: box, AGENT_STATE: join(root, "state"), AGENT_ENV_FILE: join(root, "nie-je.env"), HOME: join(root, "home"), CLAUDE_CODE_SESSION_ID: "", CLAUDE_PID: "" };
  return { box, env };
}

function reply(env, args, input) {
  return spawnSync(join(RUNTIME, "reply.sh"), args, { env, input, encoding: "utf8" });
}

test("reply.sh: riadok Hotovo: je výsledok, odpoveď na vedomie bez prepínača prejde", () => {
  const { box, env } = prostredie();
  const r = reply(env, [NAME], "Hotovo: skúška\n");
  assert.equal(r.status, 0, r.stderr);
  const files = readdirSync(join(box, "outbox"));
  assert.equal(files.length, 1);
  assert.equal(readFileSync(join(box, "outbox", files[0]), "utf8").split("\n")[0], "odpoveď: na vedomie");
});

test("reply.sh: riadok Úloha bez prepínača je pokyn a zápis sa odmietne", () => {
  const { box, env } = prostredie();
  const r = reply(env, [NAME], "Úloha: x\n");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Úloha alebo Otázka\)/);
  assert.doesNotMatch(r.stderr, /Hotovo:/);
  assert.deepEqual(readdirSync(join(box, "outbox")), []);
});

test("reply.sh: riadok Úloha s --necakam prejde", () => {
  const { box, env } = prostredie();
  const r = reply(env, ["--necakam", NAME], "Úloha: x\n");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readdirSync(join(box, "outbox")).length, 1);
});
