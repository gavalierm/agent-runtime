#!/usr/bin/env node
// Test lib/open_branches.mjs na dočasnom repe s bare origin. Replay chyby
// 19. 10. 2026: súbor zmenený otvorenou vetvou musí byť v mape, po
// zlúčení vetvy už nie.
import "./git_isolate.mjs";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openBranchFiles } from "./open_branches.mjs";

const root = mkdtempSync(join(tmpdir(), "open-branches-"));
const env = { ...process.env, GIT_CONFIG_PARAMETERS: "", GIT_CONFIG_COUNT: "0", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
delete env.GIT_DIR; delete env.GIT_INDEX_FILE; delete env.GIT_WORK_TREE;
const git = (cwd, ...a) => execFileSync("git", a, { cwd, env, stdio: "pipe" });
let fail = 0;
const ok = (c, m) => { console.log(`${c ? "ok  " : "FAIL"} ${m}`); if (!c) fail++; };
try {
  const origin = join(root, "origin.git"), repo = join(root, "repo");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, repo);
  writeFileSync(join(repo, "A.md"), "a\n"); writeFileSync(join(repo, "B.md"), "b\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "init"); git(repo, "push", "-q", "origin", "HEAD:main");
  git(repo, "checkout", "-qb", "refaktor");
  writeFileSync(join(repo, "A.md"), "a2\n");
  git(repo, "commit", "-qam", "vetva"); git(repo, "push", "-q", "origin", "refaktor"); git(repo, "checkout", "-q", "main");
  let m = openBranchFiles(repo);
  ok(m.get(join(repo, "A.md")) === "origin/refaktor", "súbor otvorenej vetvy je v mape s menom vetvy");
  ok(!m.has(join(repo, "B.md")), "súbor, ktorý vetva nemení, v mape nie je");
  git(repo, "merge", "-q", "--ff-only", "origin/refaktor"); git(repo, "push", "-q", "origin", "main"); git(repo, "fetch", "-q");
  m = openBranchFiles(repo);
  ok(m.size === 0, "po zlúčení vetvy je mapa prázdna");
  ok(openBranchFiles(root).size === 0, "mimo gitu prázdna mapa");
} finally {
  rmSync(root, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
