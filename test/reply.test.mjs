import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync as mkdtempRaw, mkdirSync, writeFileSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

// Dočasné priečinky testu sa na konci zmažú (úloha 701).
const tmpDirs = [];
const mkdtempSync = (prefix) => { const d = mkdtempRaw(prefix); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

const RUNTIME = join(dirname(fileURLToPath(import.meta.url)), "..");
// Povinné riadky tela odpovede.
const TRI = "Výsledok: v\nDôkaz: d\nOtvorené: nič\n";
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
  const r = reply(env, [NAME], "Hotovo: skúška\n" + TRI);
  assert.equal(r.status, 0, r.stderr);
  const files = readdirSync(join(box, "outbox"));
  assert.equal(files.length, 1);
  assert.equal(readFileSync(join(box, "outbox", files[0]), "utf8").split("\n")[0], "odpoveď: na vedomie");
});

test("reply.sh: neexistujúca pôvodná správa je kód 1 a nič sa nezapíše (úloha 709, nález 2 úlohy 710)", () => {
  const { box, env } = prostredie();
  const r = reply(env, ["boris-agentic_brain-20261031-000000-1.md"], "Hotovo: x\n" + TRI);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Pôvodná správa boris-agentic_brain-20261031-000000-1\.md nie je v \S+\/processed ani inbox, odpovedať sa dá len na prijatú správu\./);
  assert.deepEqual(readdirSync(join(box, "outbox")), []);
  // Správa bez hlavičky `téma:` ostáva: téma sa odvodí z mena, súbor existuje.
  writeFileSync(join(box, "processed", "boris-siet-20261031-000000-2.md"), "odpoveď: čakám\nPokyn\n");
  const ok = reply(env, ["boris-siet-20261031-000000-2.md"], "Hotovo: x\n" + TRI);
  assert.equal(ok.status, 0, ok.stderr);
  const files = readdirSync(join(box, "outbox"));
  assert.equal(files.length, 1);
  assert.match(readFileSync(join(box, "outbox", files[0]), "utf8"), /\ntéma: siet\n/);
});

test("reply.sh: riadok Úloha bez prepínača je pokyn a zápis sa odmietne", () => {
  const { box, env } = prostredie();
  const r = reply(env, [NAME], "Úloha: x\n" + TRI);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Úloha alebo Otázka\)/);
  assert.doesNotMatch(r.stderr, /Hotovo:/);
  assert.deepEqual(readdirSync(join(box, "outbox")), []);
});

test("reply.sh: riadok Úloha s --necakam prejde", () => {
  const { box, env } = prostredie();
  const r = reply(env, ["--necakam", NAME], "Úloha: x\n" + TRI);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readdirSync(join(box, "outbox")).length, 1);
});

for (const chyba of ["Výsledok", "Dôkaz", "Otvorené"]) {
  test(`reply.sh: telo bez riadka ${chyba} sa odmietne vo všetkých režimoch`, () => {
    const { box, env } = prostredie();
    const telo = TRI.split("\n").filter((l) => l && !l.startsWith(chyba + ":")).join("\n") + "\n";
    for (const mod of [[], ["--cakam"], ["--necakam"], ["--vedomie"]]) {
      const r = reply(env, [...mod, NAME], telo);
      assert.equal(r.status, 1, `${mod.join(" ")}: ${r.stderr}`);
      assert.match(r.stderr, new RegExp(`neprázdny riadok: ${chyba}\\.`));
      assert.match(r.stderr, /^Správny postup: /m);
      assert.match(r.stderr, /^Výsledok: .+\nDôkaz: .+\nOtvorené: nič$/m);
    }
    assert.deepEqual(readdirSync(join(box, "outbox")), []);
  });
}

test("reply.sh: riadok s prázdnou hodnotou za dvojbodkou sa odmietne", () => {
  const { box, env } = prostredie();
  const r = reply(env, [NAME], "Výsledok: v\nDôkaz:   \nOtvorené: nič\n");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /neprázdny riadok: Dôkaz\./);
  assert.deepEqual(readdirSync(join(box, "outbox")), []);
});

test("reply.sh: riadok musí začínať názvom, riadok v strede vety nestačí", () => {
  const { env } = prostredie();
  const r = reply(env, [NAME], "Mám Výsledok: v\nDôkaz: d\nOtvorené: nič\n");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /neprázdny riadok: Výsledok\./);
});

test("reply.sh: tri riadky v inom poradí a so zvyškom tela prejdú vo všetkých režimoch", () => {
  const { box, env } = prostredie();
  for (const mod of [[], ["--cakam"], ["--necakam"], ["--vedomie"]]) {
    const r = reply(env, [...mod, NAME], "Úvod\nOtvorené: nič\nVýsledok: hotové\nDôkaz: `ls` vypíše súbor\n");
    assert.equal(r.status, 0, `${mod.join(" ")}: ${r.stderr}`);
  }
  assert.equal(readdirSync(join(box, "outbox")).length, 4);
});

test("reply.sh: prázdne telo hlási prázdnu odpoveď, nie chýbajúce riadky", () => {
  const { env } = prostredie();
  const r = reply(env, [NAME], "");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Prázdna odpoveď/);
});
