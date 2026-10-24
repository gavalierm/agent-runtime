import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "mac_wake.sh");

// Webhook nahrádza príkaz, ktorý zapíše riadok do súboru, živý Mac sa nevolá.
function run(dir, ok = true) {
  const calls = join(dir, "calls");
  const env = { ...process.env, MAC_WAKE_AGENT: "carol", MAC_WAKE_INBOX: join(dir, "in"), MAC_WAKE_STATE: join(dir, "st", "n"),
    MAC_WAKE_CMD: ok ? `echo x >> ${calls}` : "false" };
  spawnSync("sh", [SCRIPT], { env });
  return existsSync(calls) ? readFileSync(calls, "utf8").split("\n").filter(Boolean).length : 0;
}

test("mac_wake: len nová správa čakám, opakovanie po zlyhaní, stav bez vybavených", () => {
  const dir = mkdtempSync(join(tmpdir(), "mac-wake-"));
  mkdirSync(join(dir, "in"));
  const msg = (n, h) => writeFileSync(join(dir, "in", n), `odpoveď: ${h}\ntext\n`);
  msg("a.md", "na vedomie");
  assert.equal(run(dir), 0);
  msg("b.md", "čakám");
  assert.equal(run(dir), 1);
  assert.equal(run(dir), 1, "tá istá správa druhý raz nebudí");
  msg("c.md", "čakám");
  assert.equal(run(dir, false), 1);
  assert.equal(run(dir), 2, "po zlyhaní budí znova");
  rmSync(join(dir, "in", "b.md"));
  msg("d.md", "čakám");
  assert.equal(run(dir), 3);
  assert.deepEqual(readFileSync(join(dir, "st", "n"), "utf8").trim().split("\n"), ["c.md", "d.md"]);
  rmSync(dir, { recursive: true });
});

test("mac_wake: predvolený príkaz drží úvodzovky okolo URL", () => {
  const src = readFileSync(SCRIPT, "utf8");
  const def = src.match(/^DEFAULT_CMD=(.*)$/m)[1];
  const r = spawnSync("sh", ["-c", `AG=carol; DEFAULT_CMD=${def}; printf %s "$DEFAULT_CMD"`]);
  assert.equal(r.stdout.toString(), `runuser -u carol -- sh -c 'curl -s -S -f -m 10 -X POST -o /dev/null "$(cat /home/carol/mac_webhook_url)"'`);
});
