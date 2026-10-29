// Súbory repa, ktoré mení otvorená vetva na origin (nezlúčená do main).
// check.mjs zastaraný odkaz v takom súbore hlási poznámkou s menom vetvy,
// nie chybou. Oprava na main by narazila na zábranu
// lib/open_branch_guard.sh, zmena čaká na zlúčenie vetvy.
//
// Chyba 19. 10. 2026: vetva refaktoru pravidiel v repe agenta opravila 24
// zastaraných odkazov, ale čakala na nasadenie Macu. check.mjs na serveri
// čítal main toho repa a hook pre-commit odmietal každý commit.
//
// Čerpá z lokálnych refs origin/*, nesťahuje. Fetch robí štart relácie.

import { execFileSync } from "node:child_process";

const git = (dir, ...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

// Mapa absolútna cesta -> meno vetvy. Prázdna mimo gitu alebo bez origin/main.
export function openBranchFiles(dir, main = "main") {
  const out = new Map();
  let top, branches;
  try {
    top = git(dir, "rev-parse", "--show-toplevel");
    git(dir, "rev-parse", "--verify", "-q", `origin/${main}`);
    branches = git(dir, "for-each-ref", "--format=%(refname:short)", "refs/remotes/origin").split("\n").filter((b) => b && b !== `origin/${main}` && b !== "origin/HEAD" && b !== "origin");
  } catch {
    return out;
  }
  for (const b of branches) {
    let files;
    try {
      if (git(dir, "rev-list", "--count", `origin/${main}..${b}`) === "0") continue;
      files = git(dir, "diff", "--name-only", `origin/${main}...${b}`).split("\n").filter(Boolean);
    } catch {
      continue;
    }
    for (const f of files) if (!out.has(`${top}/${f}`)) out.set(`${top}/${f}`, b);
  }
  return out;
}
