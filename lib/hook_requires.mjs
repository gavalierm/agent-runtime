// Každý hook v hooks/ nesie druhý riadok `// requires: <hodnota>`: čo potrebuje
// prostredie, aby hook mal zmysel. Hodnoty: none, tasker (volá tk alebo
// tasker, číta databázu Taskera alebo stráži jeho príkazy), t3 (klient T3 alebo
// id vlákna T3), inbox (schránky v /var/lib), mac (hook len pre Mac). Viac
// hodnôt sa píše cez čiarku, none je vždy samo.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const VALUES = ["none", "tasker", "t3", "inbox", "mac"];

export const isHook = (name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs") && !name.endsWith(".replay.mjs");

// Hodnoty z druhého riadku textu, alebo null, keď riadok nie je tvaru `// requires: ...`.
export function parseRequires(text) {
  const m = /^\/\/ requires: (.+)$/.exec(text.split("\n")[1] ?? "");
  return m ? m[1].split(",").map((v) => v.trim()) : null;
}

export function requiresProblems(repo) {
  const dir = join(repo, "hooks");
  if (!existsSync(dir)) return [];
  const problems = [];
  for (const name of readdirSync(dir).filter(isHook).sort()) {
    const values = parseRequires(readFileSync(join(dir, name), "utf8"));
    if (!values) problems.push(`hooks/${name}: druhý riadok nie je \`// requires: ${VALUES.join("|")}\``);
    else if (values.some((v) => !VALUES.includes(v)) || (values.includes("none") && values.length > 1))
      problems.push(`hooks/${name}: requires má hodnotu mimo ${VALUES.join("|")} alebo none spolu s inou: ${values.join(", ")}`);
  }
  return problems;
}
