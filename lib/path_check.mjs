// path_check.mjs — kontrola odkazov na cesty v repe.
// Prejde všetky *.md (okrem node_modules), nájde cesty v spätných apostrofoch
// s prefixom bin/ lib/ hooks/ skills/ roles/ env/ global/ rozhodnutia/ artifacts/
// runtime/ a zlyhá kódom 1, keď cesta v repe nie je a nie je uvedená v README.md
// v sekcii "## Čo v repe nie je" (riadok tabuľky alebo odrážka, ktorá začína
// touto cestou v apostrofoch). Zástupný vzor s "xxx" (rozhodnutia/D0xxx.md) prejde.
//
//   node lib/path_check.mjs                          repo, v ktorom skript leží
//   PATH_CHECK_ROOT=<koreň repa> node lib/path_check.mjs   iné repo (playbook ho volá z klonu agent-runtime)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.PATH_CHECK_ROOT || join(HERE, "..");
const PREFIXES = "bin|lib|hooks|skills|roles|env|global|rozhodnutia|artifacts|runtime";
const PATH_RE = new RegExp("`((?:" + PREFIXES + ")/[A-Za-z0-9_./-]+)`", "g");
const SECTION = "## Čo v repe nie je";

export function listMarkdown(root = ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".md")) out.push(relative(root, p));
    }
  };
  walk(root);
  return out.sort();
}

export function findPaths(text) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(PATH_RE)) out.push({ line: i + 1, path: m[1] });
  });
  return out;
}

// Cesty uvedené v README.md v sekcii "## Čo v repe nie je".
export function declaredMissing(readme) {
  const set = new Set();
  let inside = false;
  for (const line of readme.split("\n")) {
    if (line.startsWith("## ")) { inside = line.trim() === SECTION; continue; }
    if (!inside) continue;
    const m = line.match(/^\s*(?:\||[-*])\s*`([^`]+)`/);
    if (m) set.add(m[1]);
  }
  return set;
}

export function checkPaths(root = ROOT) {
  const readmeFile = join(root, "README.md");
  const declared = existsSync(readmeFile) ? declaredMissing(readFileSync(readmeFile, "utf8")) : new Set();
  const out = [];
  for (const f of listMarkdown(root)) {
    for (const { line, path } of findPaths(readFileSync(join(root, f), "utf8"))) {
      if (path.includes("xxx")) continue;
      if (existsSync(join(root, path))) continue;
      if (declared.has(path)) continue;
      out.push(`${f}:${line} ${path}`);
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const hits = checkPaths();
  if (hits.length) {
    console.error("path_check: cesty v texte, ktoré v repe nie sú a README.md ich v sekcii \"Čo v repe nie je\" neuvádza:");
    for (const h of hits) console.error(`  ${h}`);
    console.error(`Spolu ${new Set(hits.map((h) => h.split(" ")[1])).size} ciest. Pridaj súbor do repa, alebo ho zapíš do README.md.`);
    process.exit(1);
  }
  console.log("path_check: cesty v poriadku");
}
