// public_check.mjs — kontrola pred commitom a pushom do verejného repa.
// Zlyhá kódom 1, keď súbor v gite (obsah alebo cesta) nesie meno človeka,
// agenta, stroja, účtu alebo adresu zo vzorov v lib/public_check.txt.
//
//   node lib/public_check.mjs                 súbory repa (git ls-files)
//   node lib/public_check.mjs --commits <rozsah>   meno autora a správa commitov
//                                              v rozsahu (napr. origin/main..HEAD)
//   node lib/public_check.mjs --blobs <rev-list argumenty>  obsah súborov zmenených v commitoch
//                                              rozsahu (nie pracovný strom), hook pre-push;
//                                              nález ako <commit7>:<cesta>:<riadok>
//   node lib/public_check.mjs --commit-msg <súbor> meno autora a committera chystaného
//                                              commitu (git var) a správa zo súboru, hook
//                                              commit-msg (28. 10. 2026: meno agenta a stroja
//                                              cez -c user.name prešiel až do pre-push)
//
// Vzory sú v base64, zoznam mená nešíri. Výnimka je len samotný zoznam.
// Skript slúži každému verejnému repu. Predvolene kontroluje repo, v ktorom
// leží, a berie jeho lib/public_check.txt. Iné verejné repo (bez vlastného
// kódu) ho volá z klonu tohto repa a odovzdá koreň a zoznam vzorov:
//   PUBLIC_CHECK_ROOT=<koreň repa> PUBLIC_CHECK_LIST=<súbor vzorov> node lib/public_check.mjs
// Riadok zoznamu so znakom + na začiatku je povolený odkaz (regulárny výraz
// v base64), jeho zhoda sa pred hľadaním mien z riadku vyreže.
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
    .filter((l) => l.trim() && !l.startsWith("#") && !l.startsWith("+"))
    .map((l) => new RegExp(Buffer.from(l.trim(), "base64").toString("utf8"), "i"));
}

// Povolené odkazy. Riadok zoznamu, ktorý začína znakom +, je regulárny výraz
// v base64. Zhody sa z riadku vyrežú pred hľadaním mien, takže odkaz na naše
// verejné repá prejde a to isté meno inde nie.
export function loadAllowed(file = LIST) {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.startsWith("+"))
    .map((l) => new RegExp(Buffer.from(l.slice(1).trim(), "base64").toString("utf8"), "gi"));
}

// Vráti zoznam nálezov "miesto:riadok" bez výpisu nájdeného mena.
export function scanText(label, text, patterns, allowed = []) {
  const out = [];
  text.split("\n").forEach((raw, i) => {
    const line = allowed.reduce((l, a) => l.replace(a, ""), raw);
    if (patterns.some((p) => p.test(line))) out.push(`${label}:${i + 1}`);
  });
  return out;
}

export function scanRepo(root = ROOT, patterns = loadPatterns(), allowed = loadAllowed()) {
  const files = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
  const out = [];
  for (const f of files) {
    if (f === "lib/public_check.txt") continue;
    if (patterns.some((p) => p.test(f))) out.push(`${f}: názov súboru`);
    let text;
    try { text = readFileSync(join(root, f), "utf8"); } catch { continue; }
    out.push(...scanText(f, text, patterns, allowed));
  }
  return out;
}

export function scanCommits(range, root = ROOT, patterns = loadPatterns(), allowed = loadAllowed()) {
  const log = execFileSync("git", ["-C", root, "log", "--format=%H%x00%an%x00%cn%x00%B%x01", range], { encoding: "utf8" });
  const out = [];
  for (const rec of log.split("\x01").map((r) => r.replace(/^\n/, "")).filter(Boolean)) {
    const [hash, an, cn, body] = rec.split("\0");
    if (patterns.some((p) => p.test(an))) out.push(`${hash.slice(0, 7)}: meno autora`);
    if (patterns.some((p) => p.test(cn))) out.push(`${hash.slice(0, 7)}: meno committera`);
    out.push(...scanText(`${hash.slice(0, 7)} (správa)`, body, patterns, allowed));
  }
  return out;
}

// Obsah súborov, ktoré commity v rozsahu zmenili (git show <commit>:<cesta>), nie pracovný strom.
// revArgs sú argumenty pre git rev-list (napr. ["abc..def"] alebo ["def", "--not", "--remotes"]).
// Zmazané súbory sa preskočia. Nález: <commit7>:<cesta>:<riadok>.
export function scanBlobs(revArgs, root = ROOT, patterns = loadPatterns(), allowed = loadAllowed()) {
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", maxBuffer: 1 << 28 });
  const commits = git("rev-list", "--reverse", ...revArgs).split("\n").filter(Boolean);
  const out = [];
  for (const c of commits) {
    const files = git("diff-tree", "--root", "-r", "-m", "--no-commit-id", "--name-only", "--diff-filter=d", "-z", c).split("\0").filter(Boolean);
    for (const f of new Set(files)) {
      if (f === "lib/public_check.txt") continue;
      const label = `${c.slice(0, 7)}:${f}`;
      if (patterns.some((p) => p.test(f))) out.push(`${label}: názov súboru`);
      let text;
      try { text = git("show", `${c}:${f}`); } catch { continue; }
      out.push(...scanText(label, text, patterns, allowed));
    }
  }
  return out;
}

// Chystaný commit: meno autora a committera z `git var`, správa zo súboru hooku commit-msg.
export function scanPending(msgFile, root = ROOT, patterns = loadPatterns(), allowed = loadAllowed()) {
  const out = [];
  for (const [v, label] of [["GIT_AUTHOR_IDENT", "meno autora"], ["GIT_COMMITTER_IDENT", "meno committera"]]) {
    const ident = execFileSync("git", ["-C", root, "var", v], { encoding: "utf8" });
    const name = ident.replace(/\s*<.*$/s, "");
    if (patterns.some((p) => p.test(name))) out.push(`chystaný commit: ${label}`);
  }
  out.push(...scanText("správa commitu", readFileSync(msgFile, "utf8"), patterns, allowed));
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const i = args.indexOf("--commits");
  const m = args.indexOf("--commit-msg");
  const b = args.indexOf("--blobs");
  const hits = b >= 0 ? scanBlobs(args.slice(b + 1)) : i >= 0 ? scanCommits(args[i + 1]) : m >= 0 ? scanPending(args[m + 1]) : scanRepo();
  if (hits.length) {
    console.error("public_check: nález mena alebo adresy, ktoré do verejného repa nepatria:");
    for (const h of hits) console.error(`  ${h}`);
    console.error("Oprav miesto (nahraď rolou alebo zástupným menom) a zopakuj. Vzory sú v lib/public_check.txt (base64).");
    process.exit(1);
  }
  console.log(b >= 0 ? "public_check: obsah commitov v poriadku" : i >= 0 ? "public_check: commity v poriadku" : m >= 0 ? "public_check: autor a správa v poriadku" : "public_check: súbory v poriadku");
}
