#!/usr/bin/env node
// Test check.mjs v git worktree. Práca vo worktree je pravidlo kánonu
// (~/Work/CLAUDE.md, "Paralelná práca") a hook pre-commit spúšťa check.mjs
// v koreni worktree. Do 18. 10. 2026 tam check hlásil symlinky do
// hlavného checkoutu ako chybu a zamietol každý commit.
//
// Založí dočasný worktree zo stavu tohto checkoutu (aj necommitnuté zmeny
// sledovaných súborov, cez `git stash create`, ktorý nič nemení), spustí
// v ňom check.mjs a čaká, že nenahlási nič okrem vecí, ktoré dopĺňa dávka 1c
// (adaptéry prostredia env/, mapa repa v README.md). HOME a repá agentov
// (AR_AGENTS) ukazujú do prázdneho dočasného priečinka, živé klony sa nečítajú.
// Worktree potom odstráni.
//
// Druhý beh (úloha 602): v kópii bez `model: sonnet` v agents/implementator.md
// musí check.mjs zlyhať (kód 1, hlásenie o `model: sonnet`).

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const git = (...a) => execFileSync("git", a, { cwd: HERE, encoding: "utf8" }).trim();

const rev = git("stash", "create") || "HEAD";
const empty = mkdtempSync(join(tmpdir(), "check-home-"));
// Nálezy, ktoré zmizia s dávkou 1c: chýbajúce nastavenie prostredia a stará mapa v README.md.
const PENDING_1C = [/env\/(mac|server)\//, /zastaraný odkaz .*\/README\.md:\d+ /];

// Spustí check.mjs v dočasnom worktree; mutate(dir) upraví kópiu pred behom.
function runCheck(mutate) {
  const dir = join(mkdtempSync(join(tmpdir(), "check-wt-")), "wt");
  git("worktree", "add", "--detach", "--quiet", dir, rev);
  try {
    if (mutate) mutate(dir);
    const r = spawnSync("node", [join(dir, "check.mjs"), "--quiet"], { cwd: dir, encoding: "utf8", env: { ...process.env, HOME: empty, AR_AGENTS: empty, AGENT_BRAIN_GLOBAL: join(empty, "nie-je") } });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally {
    git("worktree", "remove", "--force", dir);
    rmSync(dirname(dir), { recursive: true, force: true });
  }
}

const ok = runCheck();
const unknown = ok.out.split("\n").filter((l) => /^\s+✗ /.test(l) && !PENDING_1C.some((re) => re.test(l)));
const okPass = (ok.code === 0 || ok.code === 1) && unknown.length === 0;
if (!okPass) console.log(ok.out);
console.log(okPass ? "check.mjs vo worktree: v poriadku (okrem vecí dávky 1c)" : `✗ check.mjs vo worktree skončil kódom ${ok.code}, nálezy mimo dávky 1c: ${unknown.length}`);

const bad = runCheck((dir) => {
  const f = join(dir, "agents", "implementator.md");
  writeFileSync(f, readFileSync(f, "utf8").replace(/^model: sonnet\n/m, ""));
});
const failsAsExpected = bad.code === 1 && /agents\/implementator\.md nemá vo frontmatteri riadok `model: sonnet`/.test(bad.out);
if (!failsAsExpected) console.log(bad.out);
console.log(failsAsExpected ? "check.mjs na kópii bez model: sonnet zlyhá: v poriadku" : `✗ check.mjs na kópii bez model: sonnet skončil kódom ${bad.code}, čakal som 1 s hlásením`);

// Hook bez riadku requires a nový súbor kódu, ktorý nikto nemenuje, musia zhodiť check.
const noRequires = runCheck((dir) => {
  const f = join(dir, "hooks", "guard.mjs");
  writeFileSync(f, readFileSync(f, "utf8").replace(/^\/\/ requires: .*\n/m, ""));
});
const requiresFails = noRequires.code === 1 && /hooks\/guard\.mjs: druhý riadok nie je `\/\/ requires:/.test(noRequires.out);
if (!requiresFails) console.log(noRequires.out);
console.log(requiresFails ? "check.mjs na hooku bez requires zlyhá: v poriadku" : "✗ check.mjs na hooku bez requires nezlyhal");

const dead = runCheck((dir) => writeFileSync(join(dir, "hooks", "nikto_nevola.mjs"), "#!/usr/bin/env node\n// requires: none\nconsole.log(1);\n"));
const deadFails = dead.code === 1 && /mŕtvy kód hooks\/nikto_nevola\.mjs/.test(dead.out);
if (!deadFails) console.log(dead.out);
console.log(deadFails ? "check.mjs na nemenovanom súbore zlyhá: v poriadku" : "✗ check.mjs na mŕtvom súbore nezlyhal");
rmSync(empty, { recursive: true, force: true });
process.exit(okPass && failsAsExpected && requiresFails && deadFails ? 0 : 1);
