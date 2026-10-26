// Ranný súhrn s --stdout (úloha 618, D0183): telo súhrnu ide na stdout, do schránky nič nepribudne,
// držaná správa na vedomie sa presunie do processed ako pri zápise do schránky. Všetko v mkdtemp,
// tasker je stub, cesty ukazujú len do dočasného priečinka.
import "../lib/git_isolate.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "morning.mjs");

function setup() {
  const root = mkdtempSync(join(tmpdir(), "adam-stdout-"));
  const box = join(root, "adam");
  for (const d of ["inbox", "processed"]) mkdirSync(join(box, d), { recursive: true });
  const bin = join(root, "tasker");
  writeFileSync(bin, "#!/bin/sh\necho 'tasker ok'\n");
  chmodSync(bin, 0o755);
  writeFileSync(join(box, "inbox", "boris-20261020-100000.md"), "odpoveď: na vedomie\n\nHlásenie pre Adama\n");
  const env = {
    PATH: process.env.PATH, HOME: root, AGENT_NAME: "adam", AGENT_BOX: box, AGENT_SWEEP_BOXES: box,
    TASKER_BIN: bin, TASKER_HOME: join(root, "th"), TASKER_DB: join(root, "none.db"),
    AGENT_T3_DB: join(root, "none-t3.db"), AGENT_RULES_REPO: join(root, "none-rules"), AGENT_WORK_REPOS: join(root, "none-repo"),
  };
  return { root, box, env };
}
const run = (env, ...args) => spawnSync(process.execPath, [SCRIPT, ...args], { env, encoding: "utf8", timeout: 60_000 });

test("--stdout vypíše súhrn bez hlavičky a nezapíše súbor do inbox", () => {
  const { box, env } = setup();
  const r = run(env, "--stdout");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^Ranný súhrn\./);
  assert.match(r.stdout, /tasker ok/);
  assert.doesNotMatch(r.stdout, /^odpoveď:|^id:|^od:/m);
  assert.match(r.stdout, /Držané správy na vedomie, presunuté do processed \(1\)/);
  assert.match(r.stdout, /Hlásenie pre Adama/);
  assert.deepEqual(readdirSync(join(box, "inbox")), []);
  assert.ok(existsSync(join(box, "processed", "boris-20261020-100000.md")));
});

test("bez --stdout zapíše správu ranny do inbox s nečakám a stdout je prázdny", () => {
  const { box, env } = setup();
  const r = run(env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
  const files = readdirSync(join(box, "inbox"));
  assert.equal(files.length, 1);
  assert.match(files[0], /^ranny-/);
});

test("neznámy argument skončí kódom 2 a nič nezapíše", () => {
  const { box, env } = setup();
  const r = run(env, "--stdot");
  assert.equal(r.status, 2);
  assert.match(r.stderr, /neznámy argument/);
  assert.deepEqual(readdirSync(join(box, "inbox")), ["boris-20261020-100000.md"]);
});
