// public_check.mjs — kontrola pred commitom a pushom do verejného repa.
// Zlyhá kódom 1, keď súbor v gite (obsah alebo cesta) nesie meno človeka,
// agenta, stroja, účtu alebo adresu zo vzorov v lib/public_check.txt.
//
//   node lib/public_check.mjs                 súbory repa (git ls-files)
//   node lib/public_check.mjs --commits <rozsah>   meno autora a správa commitov
//                                              v rozsahu (napr. origin/main..HEAD)
//
// Vzory sú v base64, zoznam mená nešíri. Výnimka je len samotný zoznam.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.PUBLIC_CHECK_ROOT || join(HERE, "..");
const LIST = process.env.PUBLIC_CHECK_LIST || join(HERE, "public_check.txt");

export function loadPatterns(file = LIST) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => new RegExp(Buffer.from(l.trim(), "base64").toString("utf8"), "i"));
}

// Vráti zoznam nálezov "miesto:riadok" bez výpisu nájdeného mena.
export function scanText(label, text, patterns) {
  const out = [];
  text.split("\n").forEach((line, i) => {
    if (patterns.some((p) => p.test(line))) out.push(`${label}:${i + 1}`);
  });
  return out;
}

export function scanRepo(root = ROOT, patterns = loadPatterns()) {
  const files = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const out = [];
  for (const f of files) {
    if (f === "lib/public_check.txt") continue;
    if (patterns.some((p) => p.test(f))) out.push(`${f}: názov súboru`);
    let text;
    try { text = readFileSync(join(root, f), "utf8"); } catch { continue; }
    out.push(...scanText(f, text, patterns));
  }
  return out;
}

export function scanCommits(range, root = ROOT, patterns = loadPatterns()) {
  const log = execFileSync("git", ["-C", root, "log", "--format=%H%x00%an%x00%cn%x00%B%x01", range], { encoding: "utf8" });
  const out = [];
  for (const rec of log.split("\x01").map((r) => r.replace(/^\n/, "")).filter(Boolean)) {
    const [hash, an, cn, body] = rec.split("\0");
    if (patterns.some((p) => p.test(an))) out.push(`${hash.slice(0, 7)}: meno autora`);
    if (patterns.some((p) => p.test(cn))) out.push(`${hash.slice(0, 7)}: meno committera`);
    out.push(...scanText(`${hash.slice(0, 7)} (správa)`, body, patterns));
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--commits");
  const hits = i >= 0 ? scanCommits(args[i + 1]) : scanRepo();
  if (hits.length) {
    console.error("public_check: nález mena alebo adresy, ktoré do verejného repa nepatria:");
    for (const h of hits) console.error(`  ${h}`);
    console.error("Oprav miesto (nahraď rolou alebo zástupným menom) a zopakuj. Vzory sú v lib/public_check.txt (base64).");
    process.exit(1);
  }
  console.log(i >= 0 ? "public_check: commity v poriadku" : "public_check: súbory v poriadku");
}
