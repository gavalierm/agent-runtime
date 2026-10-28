// identity.mjs: identita a pravidlá roly z riadku "Role:" v PERSONA.md.
// Fixtúra je dočasný priečinok, žiadny živý systém.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "../hooks/identity.mjs");

// Klon repa pravidiel vo fixtúre: roly a README mimo roles/ (únik cez slug s cestou).
const RULES = mkdtempSync(join(tmpdir(), "identity-rules-"));
mkdirSync(join(RULES, "roles"));
for (const [slug, title] of [["spravca-servera", "správca servera"], ["zastupca-operatora", "zástupca operátora"], ["spravca-agentov", "správca agentov"]])
  writeFileSync(join(RULES, "roles", `${slug}.md`), `# Pravidlá roly: ${title}\n\nText roly.\n`);
writeFileSync(join(RULES, "README.md"), "# mapa repa\n");
const HOME = mkdtempSync(join(tmpdir(), "identity-home-"));
test.after(() => { rmSync(RULES, { recursive: true, force: true }); rmSync(HOME, { recursive: true, force: true }); });

function run(persona, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "identity-"));
  try {
    if (persona !== null) writeFileSync(join(dir, "PERSONA.md"), persona);
    const out = execFileSync("node", [HOOK], {
      input: JSON.stringify({ session_id: "test1234", cwd: dir }),
      env: { PATH: process.env.PATH, HOME, CLAUDE_PROJECT_DIR: "", AGENT_RULES_REPO: RULES, AGENT_THREADS: "", ...extraEnv },
    }).toString();
    return out ? JSON.parse(out).hookSpecificOutput.additionalContext : "";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("bez riadku Role vloží len identitu", () => {
  const c = run("# Xaver\n\nText.\n");
  assert.match(c, /Si Xaver/);
  assert.doesNotMatch(c, /Pravidlá roly/);
});

test("jedna rola vloží jej súbor", () => {
  const c = run("# Xaver\n\nRole: spravca-servera\n");
  assert.match(c, /# Pravidlá roly: správca servera/);
  assert.doesNotMatch(c, /# Pravidlá roly: správca agentov/);
});

test("dve roly vložia oba súbory", () => {
  const c = run("# Xaver\n\nRole: zastupca-operatora, spravca-agentov\n");
  assert.match(c, /# Pravidlá roly: zástupca operátora/);
  assert.match(c, /# Pravidlá roly: správca agentov/);
});

test("neznámy slug dá upozornenie a hook nepadne", () => {
  const c = run("# Xaver\n\nRole: spravca-servera, nic-take\n");
  assert.match(c, /# Pravidlá roly: správca servera/);
  assert.match(c, /Upozornenie: PERSONA.md uvádza rolu `nic-take`/);
});

test("slug s cestou neunikne z roles", () => {
  const c = run("# Xaver\n\nRole: ../README\n");
  assert.match(c, /Upozornenie/);
  assert.doesNotMatch(c, /mapa repa/);
});

test("bez PERSONA.md hook mlčí", () => {
  assert.equal(run(null), "");
});

test("klon pravidiel z AGENT_RULES_REPO, nie z umiestnenia hooku", () => {
  const c = run("# Xaver\n\nRole: spravca-servera\n", { AGENT_RULES_REPO: join(RULES, "neexistuje") });
  assert.match(c, /Upozornenie: PERSONA.md uvádza rolu `spravca-servera`/);
});

test("klon pravidiel z runtime.env agenta (AGENT_RULES_REPO)", () => {
  mkdirSync(join(HOME, ".config/xaver"), { recursive: true });
  const other = mkdtempSync(join(tmpdir(), "identity-other-"));
  try {
    mkdirSync(join(other, "roles"));
    writeFileSync(join(other, "roles", "spravca-servera.md"), "# Pravidlá roly: z runtime.env\n");
    writeFileSync(join(HOME, ".config/xaver/runtime.env"), `AGENT_RULES_REPO=${other}\n`);
    const c = run("# Xaver\n\nRole: spravca-servera\n", { AGENT_RULES_REPO: "", AGENT_NAME: "xaver" });
    assert.match(c, /# Pravidlá roly: z runtime\.env/);
  } finally { rmSync(other, { recursive: true, force: true }); }
});

// Vlákno témy (úloha 636): klon projektu bez PERSONA.md, vlákno relácie je
// v topics.json agenta, identita je persona agenta a téma je v riadku.
test("vlákno témy bez PERSONA.md dostane identitu agenta témy", () => {
  const lib = mkdtempSync(join(tmpdir(), "identity-lib-"));
  const homes = mkdtempSync(join(tmpdir(), "identity-homes-"));
  try {
    mkdirSync(join(lib, "xaver"));
    writeFileSync(join(lib, "xaver", "topics.json"), JSON.stringify({ web: { thread: "mcp:abc", at: "2026-10-28T00:00:00Z" } }));
    mkdirSync(join(homes, "xaver"));
    writeFileSync(join(homes, "xaver", "PERSONA.md"), "# Xaver\n\nRole: spravca-servera\n");
    const c = run(null, { AGENT_THREADS: "mcp:abc", AGENT_TOPICS_DIR: lib, AGENT_HOMES_DIR: homes });
    assert.match(c, /Si Xaver podľa .*xaver\/PERSONA\.md/);
    assert.match(c, /vlákno témy web/);
    assert.match(c, /# Pravidlá roly: správca servera/);
    assert.equal(run(null, { AGENT_THREADS: "mcp:ine", AGENT_TOPICS_DIR: lib, AGENT_HOMES_DIR: homes }), "");
  } finally {
    rmSync(lib, { recursive: true, force: true });
    rmSync(homes, { recursive: true, force: true });
  }
});
