// Strop počtu slov globálnych pravidiel (rozhodnutie z 18. 10. 2026, strop
// RULES.md). Slovo počíta ako `wc -w`. Strop je v
// lib/global_word_cap.txt a smie len klesať: pracovná kópia nesmie mať
// vyšší strop ako HEAD a žiadny commit v histórii súboru ho nezvýšil.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CAP_FILE = "lib/global_word_cap.txt";
export const RULES = "RULES.md";

export const words = (text) => text.split(/\s+/).filter(Boolean).length;

const git = (repo, ...a) => execFileSync("git", a, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

export function wordCapProblems(repo) {
  const problems = [];
  const capPath = join(repo, CAP_FILE);
  if (!existsSync(capPath)) return [`${CAP_FILE} chýba, strop slov ${RULES} sa nedá overiť`];
  const cap = Number.parseInt(readFileSync(capPath, "utf8"), 10);
  if (!Number.isInteger(cap)) return [`${CAP_FILE} nemá celé číslo`];
  const n = words(readFileSync(join(repo, RULES), "utf8"));
  if (n > cap) problems.push(`${RULES} má ${n} slov, strop je ${cap} (${CAP_FILE}), skráť pravidlá, strop sa nezvyšuje`);
  let history = [];
  try {
    // Od najnovšieho po najstarší commit súboru.
    history = git(repo, "log", "--format=%H", "--", CAP_FILE).split("\n").filter(Boolean)
      .map((h) => ({ h, cap: Number.parseInt(git(repo, "show", `${h}:${CAP_FILE}`), 10) }));
  } catch {
    return problems;
  }
  if (history.length && cap > history[0].cap)
    problems.push(`strop v ${CAP_FILE} stúpol z ${history[0].cap} na ${cap}, smie len klesať`);
  for (let i = 0; i + 1 < history.length; i++)
    if (history[i].cap > history[i + 1].cap)
      problems.push(`commit ${history[i].h.slice(0, 7)} zvýšil strop v ${CAP_FILE} z ${history[i + 1].cap} na ${history[i].cap}, smie len klesať`);
  return problems;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const p = wordCapProblems(process.cwd());
  for (const x of p) console.log(`✗ ${x}`);
  process.exit(p.length ? 1 : 0);
}
