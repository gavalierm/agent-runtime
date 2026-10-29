// agent_defs.mjs — kontrola definícií sub-agentov v agents/ (úloha Taskera 602).
// Sub-agent `implementator` beží na Sonnete: súbor agents/implementator.md musí
// existovať a mať vo frontmatteri riadok `model: sonnet`. Bez neho by implementáciu
// robil model rodiča (Opus alebo Fable), global §6 by sa obišlo bez hlásenia.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const FILE = "agents/implementator.md";

// Frontmatter súboru: riadky medzi prvými dvoma `---`, alebo null.
export function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  return m ? m[1] : null;
}

export function agentDefProblems(repo) {
  const path = join(repo, FILE);
  if (!existsSync(path)) return [`${FILE} chýba, implementáciu s testami nemá kto dostať na Sonnete (global §6)`];
  const fm = frontmatter(readFileSync(path, "utf8"));
  if (fm === null) return [`${FILE} nemá frontmatter`];
  if (!/^model:\s*sonnet\s*$/m.test(fm)) return [`${FILE} nemá vo frontmatteri riadok \`model: sonnet\`, sub-agent by bežal na modeli rodiča`];
  return [];
}
