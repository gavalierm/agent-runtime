// Mŕtvy kód: súbor v hooks/, lib/, bin/, brain/bin/, skills/*/scripts/ alebo
// v koreni repa (.mjs, .sh), ktorý nikde mimo seba a mimo testov nie je
// importovaný, volaný ani menovaný. Zdrojom zmienky je kód, skript, SKILL.md,
// konfigurácia a systemd; ostatné .md (README, pravidlá, dokumenty) a dáta
// .txt nestačia. Výnimka je riadok `<cesta> <dôvod>` v lib/dead_code_allow.txt;
// výnimka bez dôvodu, na neexistujúci súbor alebo na súbor, ktorý mŕtvy nie je,
// je chyba.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

export const ALLOW_FILE = "lib/dead_code_allow.txt";

const SKIP_DIRS = new Set([".git", "node_modules", ".scratch", "archiv", "vendor"]);
const NOT_SOURCE = /\.(md|txt|png|jpe?g|gif|svg|ico|pdf|woff2?|lock)$/i;
const CODE = /\.(mjs|sh)$/;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const isTest = (rel) => /(^|\/)test\//.test(rel) || /\.test\.(mjs|sh)$/.test(rel) || /\.replay\.mjs$/.test(rel);

function walk(root, dir = "", out = []) {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue;
    const rel = dir ? `${dir}/${e.name}` : e.name;
    if (e.isDirectory()) walk(root, rel, out);
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

// Súbor, ktorý má mať zmienku: kód v sledovaných priečinkoch a v koreni.
export function isCandidate(rel, executable) {
  if (isTest(rel)) return false;
  const parts = rel.split("/");
  const name = parts[parts.length - 1];
  const code = CODE.test(name);
  if (parts.length === 1) return code;
  const dir = parts.slice(0, -1).join("/");
  if (dir === "hooks" || dir === "lib") return code;
  if (dir === "bin" || dir === "brain/bin") return code || (!name.includes(".") && executable);
  return parts[0] === "skills" && parts[2] === "scripts" && parts.length === 4 && (code || executable);
}

// Relatívne špecifikátory importov v zdroji JavaScriptu, preložené na cesty od koreňa repa.
function importTargets(rel, text) {
  const out = new Set();
  for (const m of text.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g))
    out.add(posix.normalize(posix.join(posix.dirname(rel), m[1])));
  return out;
}

export function deadCode(repo) {
  const files = walk(repo);
  const executable = (rel) => (statSync(join(repo, rel)).mode & 0o111) !== 0;
  const candidates = files.filter((f) => isCandidate(f, executable(f)));
  const sources = files
    .filter((f) => !isTest(f) && (f.endsWith("/SKILL.md") || !NOT_SOURCE.test(f)) && statSync(join(repo, f)).size < 1_000_000)
    .map((f) => ({ rel: f, text: readFileSync(join(repo, f), "utf8") }));
  const baseCount = new Map();
  for (const c of candidates) baseCount.set(posix.basename(c), (baseCount.get(posix.basename(c)) || 0) + 1);
  const imports = new Map(sources.filter((s) => s.rel.endsWith(".mjs")).map((s) => [s.rel, importTargets(s.rel, s.text)]));

  const referenced = (c) => {
    const base = posix.basename(c);
    const dir = posix.dirname(c);
    const unique = baseCount.get(base) === 1;
    let needle;
    if (!base.includes(".")) needle = new RegExp(`(?<![\\w.-])${esc(posix.basename(dir))}/${esc(base)}(?![\\w-])|["']${esc(posix.basename(dir))}["'],\\s*["']${esc(base)}["']`);
    else if (unique) needle = new RegExp(`(?<![\\w.-])${esc(base)}(?![\\w-])`);
    else needle = new RegExp(`(?<![\\w${dir === "." ? "./" : "."}-])${esc(c)}(?![\\w-])`);
    return sources.some((s) => s.rel !== c && (imports.get(s.rel)?.has(c) || needle.test(s.text)));
  };
  return { candidates, dead: candidates.filter((c) => !referenced(c)).sort() };
}

export function parseAllow(text) {
  const entries = [];
  for (const [i, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(\S+)\s*(.*)$/.exec(line);
    entries.push({ line: i + 1, path: m[1], reason: m[2].trim() });
  }
  return entries;
}

export function deadCodeProblems(repo) {
  const { candidates, dead } = deadCode(repo);
  const allowPath = join(repo, ALLOW_FILE);
  const allow = existsSync(allowPath) ? parseAllow(readFileSync(allowPath, "utf8")) : [];
  const problems = [];
  for (const a of allow) {
    if (!a.reason) problems.push(`${ALLOW_FILE}:${a.line}: výnimka ${a.path} nemá dôvod na riadku`);
    else if (!candidates.includes(a.path)) problems.push(`${ALLOW_FILE}:${a.line}: ${a.path} nie je súbor, ktorý kontrola mŕtveho kódu sleduje`);
    else if (!dead.includes(a.path)) problems.push(`${ALLOW_FILE}:${a.line}: výnimka ${a.path} netreba, súbor je niekde menovaný, zmaž riadok`);
  }
  const allowed = new Set(allow.filter((a) => a.reason).map((a) => a.path));
  for (const d of dead) if (!allowed.has(d)) problems.push(`mŕtvy kód ${d}: nikde mimo seba a mimo testov nie je importovaný, volaný ani menovaný (zmaž ho, alebo riadok s dôvodom do ${ALLOW_FILE})`);
  return problems;
}
