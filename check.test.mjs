#!/usr/bin/env node
// Test check.mjs v git worktree. Práca vo worktree je pravidlo kánonu
// (~/Work/CLAUDE.md, "Paralelná práca") a hook pre-commit spúšťa check.mjs
// v koreni worktree. Do 18. 10. 2026 tam check hlásil symlinky do
// hlavného checkoutu ako chybu a zamietol každý commit.
//
// Založí dočasný worktree zo stavu tohto checkoutu (aj necommitnuté zmeny
// sledovaných súborov, cez `git stash create`, ktorý nič nemení), spustí
// v ňom check.mjs a čaká kód 0. Worktree potom odstráni.
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

// Spustí check.mjs v dočasnom worktree; mutate(dir) upraví kópiu pred behom.
function runCheck(mutate) {
  const dir = join(mkdtempSync(join(tmpdir(), "check-wt-")), "wt");
  git("worktree", "add", "--detach", "--quiet", dir, rev);
  try {
    if (mutate) mutate(dir);
    const r = spawnSync("node", [join(dir, "check.mjs"), "--quiet"], { cwd: dir, encoding: "utf8" });
    return { code: r.status, out: r.stdout + r.stderr };
  } finally {
    git("worktree", "remove", "--force", dir);
    rmSync(dirname(dir), { recursive: true, force: true });
  }
}

const ok = runCheck();
if (ok.code !== 0) console.log(ok.out);
console.log(ok.code === 0 ? "check.mjs vo worktree: v poriadku" : `✗ check.mjs vo worktree skončil kódom ${ok.code}`);

const bad = runCheck((dir) => {
  const f = join(dir, "agents", "implementator.md");
  writeFileSync(f, readFileSync(f, "utf8").replace(/^model: sonnet\n/m, ""));
});
const failsAsExpected = bad.code === 1 && /agents\/implementator\.md nemá vo frontmatteri riadok `model: sonnet`/.test(bad.out);
if (!failsAsExpected) console.log(bad.out);
console.log(failsAsExpected ? "check.mjs na kópii bez model: sonnet zlyhá: v poriadku" : `✗ check.mjs na kópii bez model: sonnet skončil kódom ${bad.code}, čakal som 1 s hlásením`);
process.exit(ok.code === 0 && failsAsExpected ? 0 : 1);
