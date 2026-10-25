// Test D0141 (úloha 424): zamietnutie hooku nesie "Správny postup:". Helper
// lib/deny.mjs a Stop hooky tohto repa (no_operator_commands, objection_fix,
// reply_guard). Nevolá živý Tasker, schránky ani T3. Spustenie: node --test test/deny.test.mjs
import "../lib/git_isolate.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LABEL, withPostup, denyTool, blockStop, exitDeny } from "../lib/deny.mjs";
import { postupFor, POSTUPY } from "../hooks/reply_guard.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
// HOME v tmp: hook nesiahne na runtime.env skutočného agenta.
const HOME = mkdtempSync(join(tmpdir(), "deny-home-"));
test.after(() => rmSync(HOME, { recursive: true, force: true }));
const hook = (name, input, env = {}) =>
  spawnSync("node", [join(REPO, "hooks", name)], { input: JSON.stringify(input), encoding: "utf8", env: { PATH: process.env.PATH, HOME, REPLY_GUARD_NO_NET: "1", AR_ROZHODNUTIA: "", ...env } });
const postupOf = (text) => (text.match(/Správny postup: (.+)/) || [])[1] || "";

test("helper vyžaduje dôvod a konkrétny postup", () => {
  assert.throws(() => withPostup("dôvod", ""), /správny postup/);
  assert.throws(() => withPostup("dôvod", "   "), /správny postup/);
  assert.throws(() => withPostup("dôvod", "skús inak"), /správny postup/);
  assert.throws(() => withPostup("", "krok"), /dôvod/);
  assert.equal(withPostup("dôvod.", "`cmd`"), `dôvod.\n${LABEL} \`cmd\``);
  let out = "";
  denyTool("d", "p", { write: (s) => (out += s) });
  assert.equal(JSON.parse(out).hookSpecificOutput.permissionDecision, "deny");
  assert.match(JSON.parse(out).hookSpecificOutput.permissionDecisionReason, /\nSprávny postup: p$/);
  let line = "";
  blockStop("d", "p", (s) => (line = s));
  assert.match(JSON.parse(line).reason, /Správny postup: p$/);
  assert.throws(() => denyTool("d", "", { write() {} }));
  let code = null;
  exitDeny("d", "p", (c) => (code = c));
  assert.equal(code, 2);
});

test("Stop hooky nesú postup", () => {
  const waiting = hook("no_operator_commands.mjs", { last_assistant_message: "Čaká na teba:\n- zruš kartu" });
  assert.match(postupOf(JSON.parse(waiting.stdout).reason), /tasker task add/);
  const cmd = hook("no_operator_commands.mjs", { last_assistant_message: "Spusti:\n```sh\nnpm test\n```" });
  assert.match(postupOf(JSON.parse(cmd.stdout).reason), /Príkaz pre teba, lebo/);
  const dir = mkdtempSync(join(tmpdir(), "deny-"));
  try {
    const tr = join(dir, "t.jsonl");
    const ev = (type, content) => JSON.stringify({ type, message: { content } });
    writeFileSync(tr, [ev("user", "ahoj"), ev("assistant", [{ type: "text", text: "Máš pravdu, moja chyba." }])].join("\n"));
    const o = hook("objection_fix.mjs", { transcript_path: tr });
    assert.match(postupOf(JSON.parse(o.stdout).reason), /git commit/);
    const long = "Prvá veta tu je. ".repeat(10);
    const rg = hook("reply_guard.mjs", { last_assistant_message: long });
    assert.match(postupOf(JSON.parse(rg.stdout).reason), /docs\//);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reply_guard: každý dôvod má vlastný postup, nie náhradný", () => {
  const samples = [
    'odpoveď nezačína menom, napíš na prvý riadok samotné "Adam:"',
    "odpoveď má 9 viet prózy, strop je 6.",
    'veta so 40 slovami je súvetie, rozdeľ ju alebo zmaž: "x"',
    'položka zoznamu "x" má 2 viet, položka je jedna veta',
    'odklad overenia na nasadenie: "x". Overenie',
    "adresa http://127.0.0.1:1 je localhost servera",
    "zmienka úlohy Taskera bez odkazu, operátor ju má",
    '"Čaká na teba" bez odkazu na úlohu Taskera: "x".',
    'úloha 5 v "Čaká na teba" v Taskeri neexistuje.',
    'úloha 5 v "Čaká na teba" je v stave done, nie needs_human.',
    'Tasker neodpovedal, nepoznám stav úloh v "Čaká na teba".',
    'veta "x" hlási nové rozhodnutie operátora, ale',
    "adresa https://x.invalid dnes neodpovedá (kód 500).",
  ];
  const fallback = postupFor("neznámy dôvod");
  for (const s of samples) assert.notEqual(postupFor(s), fallback, s);
  assert.ok(POSTUPY.length >= samples.length - 2);
});

test("postup s adresou webu Taskera: z TASKER_WEB_URL, bez neho zástupný text", () => {
  const web = "https://host.example.ts.net:8801";
  assert.match(postupFor("zmienka úlohy Taskera bez odkazu, x", web), /\(tvar `\[úloha N\]\(https:\/\/host\.example\.ts\.net:8801\/tasks\/N\)`\)/);
  assert.match(postupFor("adresa http://127.0.0.1:1 je localhost servera", web), /: https:\/\/host\.example\.ts\.net:<port>$/);
  assert.match(postupFor("adresa http://127.0.0.1:1 je localhost servera", "http://127.0.0.1:8801"), /<host>\.<tailnet>\.ts\.net:<port>$/);
  assert.doesNotMatch(postupFor("zmienka úlohy Taskera bez odkazu, x", undefined), /\{(WEB|HOST)\}/);
});
