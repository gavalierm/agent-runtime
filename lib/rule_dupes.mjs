#!/usr/bin/env node
// Kontrola duplikátov pravidiel (D0144, úloha Taskera 439). Lokálne pravidlo
// s globálnym dosahom patrí do globálnych pravidiel a kópie z lokálnych
// pravidiel agentov zmiznú. Kontrola nájde dvojice jednotiek pravidiel
// (odrážka alebo odsek), ktoré hovoria to isté:
//   - lokálna jednotka (PERSONA.md, CLAUDE.md repa agenta) podobná zdieľanej
//     (RULES.md tohto repa, env/*/RULES.md zo spoločného mozgu, roles/*.md tohto repa
//     okrem agents.md a ROLES.md),
//   - podobné jednotky dvoch rôznych agentov (kandidát na presun do globálnych).
// Podobnosť je lexikálna: malé písmená, bez diakritiky a interpunkcie, bez
// krátkych slov, kmeň prvých 5 znakov, Jaccard a pokrytie menšej jednotky.
// Výrazy v spätných apostrofoch (mená súborov, hookov, príkazov) presahujú
// jazyk (global je po anglicky, lokálne po slovensky), preto sa porovnávajú
// osobitne. Spomenutý jeden súbor nie je nález, treba zhodu viacerých.
// Zámerné opakovanie: riadok v lib/rule_dupes_allow.txt.
//
//   node lib/rule_dupes.mjs          vypíše nálezy, exit 1 pri nálezoch
//   AR_AGENTS=<priečinok>            repá agentov inde než /root (Mac ~/Work/agenti)

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { brainGlobalDir } from "./paths.mjs";

export const ALLOW_FILE = "lib/rule_dupes_allow.txt";
// Prahy. Odkaz na jeden súbor alebo príkaz (jeden kódový výraz) nikdy nie je nález.
export const MIN_WORDS = 7; // najmenej kmeňov slov v kratšej jednotke
export const LEX_JACCARD = 0.5; // Jaccard slov, ten istý jazyk
export const LEX_COVER = 0.7; // pokrytie kratšej jednotky slovami
export const MIN_CODES = 2; // zhodných kódových výrazov
export const CODE_COVER = 0.75; // pokrytie kratšej množiny kódových výrazov
export const CODE_ONLY = 3; // toľko zhodných výrazov stačí aj bez zhody slov (global je po anglicky, lokálne po slovensky)
export const CODE_LEX_COVER = 0.3; // aj zhoda slov (rôzne jazyky, preto slabšia), inak ide o spoločný zoznam súborov
export const COMMON_CODE = 8; // výraz vo viac jednotkách (`CLAUDE.md`, `PERSONA.md`) o zhode nerozhoduje

const stripDiacritics = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "");
const stem = (w) => w.slice(0, 5);

// Jednotky súboru: odrážka (aj s pokračovaním na ďalších riadkoch), číslovaný
// bod alebo odsek. Nadpis, tabuľka, blok kódu a front matter jednotku ukončia.
export function splitUnits(text) {
  const units = [];
  let cur = null;
  let fence = false;
  const flush = () => {
    if (cur) units.push({ ...cur, text: cur.lines.join(" ").trim() });
    cur = null;
  };
  const lines = text.split("\n");
  lines.forEach((raw, i) => {
    const line = raw.replace(/\s+$/, "");
    if (/^\s*```/.test(line)) { flush(); fence = !fence; return; }
    if (fence) return;
    if (i === 0 && line === "---") fence = true; // front matter, končí druhým ---
    if (/^---\s*$/.test(line) && i > 0 && fence && !/^```/.test(lines[0])) { fence = false; return; }
    if (!line.trim() || /^\s*#{1,6}\s/.test(line) || /^\s*\|/.test(line) || /^\s*---+\s*$/.test(line)) { flush(); return; }
    // Číslovaný bod má za číslom slovo. Zalomený dátum ("18.", nový riadok
    // "10. 2026") bodom nie je.
    const item = /^\s*(?:[-*]|\d{1,2}[.)](?=\s+[^\d\s]))\s+(.*)$/.exec(line);
    if (item) {
      flush();
      cur = { start: i + 1, lines: [item[1]] };
    } else if (cur) {
      cur.lines.push(line.trim());
    } else {
      cur = { start: i + 1, lines: [line.trim()] };
    }
  });
  flush();
  return units;
}

// Znaky jednotky: kmene slov, kódové výrazy a normalizovaný text pre id dvojice.
export function features(text) {
  const codes = new Set();
  const prose = text.replace(/`([^`]+)`/g, (_, c) => {
    const k = stripDiacritics(c.toLowerCase()).replace(/\s+/g, " ").trim();
    if (k.length >= 3) codes.add(k);
    return " ";
  });
  const words = stripDiacritics(prose.toLowerCase())
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length >= 4);
  return { words: new Set(words.map(stem)), codes, norm: words.join(" ") + "|" + [...codes].sort().join(" ") };
}

const inter = (a, b) => { let n = 0; for (const x of a) if (b.has(x)) n++; return n; };

// Podobnosť dvoch jednotiek: null, ak nejde o duplikát, inak opis dôvodu.
export function similar(a, b) {
  const wa = a.words, wb = b.words;
  const small = Math.min(wa.size, wb.size);
  const shared = inter(wa, wb);
  const lexCover = small ? shared / small : 0;
  const lexJaccard = shared / (wa.size + wb.size - shared || 1);
  if (small >= MIN_WORDS && lexJaccard >= LEX_JACCARD && lexCover >= LEX_COVER)
    return `slová ${Math.round(lexJaccard * 100)} % (pokrytie ${Math.round(lexCover * 100)} %)`;
  const cs = inter(a.codes, b.codes);
  const codeSmall = Math.min(a.codes.size, b.codes.size);
  if (cs >= MIN_CODES && cs / codeSmall >= CODE_COVER && (cs >= CODE_ONLY || lexCover >= CODE_LEX_COVER))
    return `${cs} spoločných výrazov v \`\`, slová ${Math.round(lexCover * 100)} %`;
  return null;
}

const pairId = (x, y) => createHash("sha1").update([x.norm, y.norm].sort().join("\n")).digest("hex").slice(0, 10);

// Zdieľané súbory: [{ base, rel }]. RULES.md a roles/ sú v repe, env/*/RULES.md
// v spoločnom mozgu, ak priečinok existuje.
export function sharedFiles(repo, brain = brainGlobalDir()) {
  const out = [];
  const add = (base, rel) => { if (existsSync(join(base, rel))) out.push({ base, rel }); };
  add(repo, "RULES.md");
  if (brain && existsSync(join(brain, "env"))) for (const e of readdirSync(join(brain, "env")).sort()) add(brain, `env/${e}/RULES.md`);
  if (existsSync(join(repo, "roles")))
    for (const f of readdirSync(join(repo, "roles")).sort())
      if (f.endsWith(".md") && f !== "agents.md" && f !== "ROLES.md") add(repo, `roles/${f}`);
  return out;
}

export function allowList(repo) {
  const path = join(repo, ALLOW_FILE);
  const ids = new Map();
  const problems = [];
  if (!existsSync(path)) return { ids, problems };
  readFileSync(path, "utf8").split("\n").forEach((l, i) => {
    if (!l.trim() || l.trim().startsWith("#")) return;
    const m = /^([0-9a-f]{10})\s+(\S.*)$/.exec(l.trim());
    if (m) ids.set(m[1], m[2]);
    else problems.push(`${ALLOW_FILE}:${i + 1}: riadok má mať "<id dvojice> <dôvod>"`);
  });
  return { ids, problems };
}

// agents: [{ name, dir }]. Vráti { findings, problems }.
export function ruleDupes(repo, agents, brain = brainGlobalDir()) {
  const load = (kind, owner, base, rel) => {
    const abs = join(base, rel);
    if (!existsSync(abs)) return [];
    return splitUnits(readFileSync(abs, "utf8")).map((u) => ({ ...u, kind, owner, rel, abs, f: features(u.text) }));
  };
  const shared = sharedFiles(repo, brain).flatMap((f) => load("shared", "shared", f.base, f.rel));
  const local = agents.flatMap((a) => ["PERSONA.md", "CLAUDE.md"].flatMap((rel) => load("local", a.name, a.dir, rel)));
  // Bežný výraz sa spomína všade, zhodu dvoch jednotiek nedokazuje. Id dvojice
  // (norm) od toho nezávisí.
  const df = new Map();
  for (const u of [...shared, ...local]) for (const c of u.f.codes) df.set(c, (df.get(c) || 0) + 1);
  for (const u of [...shared, ...local]) u.f = { ...u.f, codes: new Set([...u.f.codes].filter((c) => df.get(c) <= COMMON_CODE)) };
  const { ids: allowed, problems } = allowList(repo);
  const findings = [];
  const seen = new Set();
  const consider = (x, y) => {
    const why = similar(x.f, y.f);
    if (!why) return;
    const id = pairId(x.f, y.f);
    if (allowed.has(id) || seen.has(id)) return;
    seen.add(id);
    findings.push({ id, why, a: x, b: y, kind: x.kind === "shared" || y.kind === "shared" ? "shared" : "agents" });
  };
  for (const l of local) for (const s of shared) consider(s, l);
  for (let i = 0; i < local.length; i++)
    for (let j = i + 1; j < local.length; j++)
      if (local[i].owner !== local[j].owner) consider(local[i], local[j]);
  return { findings, problems };
}

const snippet = (t) => (t.length > 90 ? t.slice(0, 87) + "..." : t);

export function describe(f, show = (p) => p) {
  const at = (u) => `${show(u.abs)}:${u.start}`;
  const what = f.kind === "shared"
    ? "lokálne pravidlo je kópia zdieľaného, zmaž ho z lokálnych pravidiel"
    : "rovnaké pravidlo u dvoch agentov, presuň ho do globálnych pravidiel a zmaž kópie";
  return `duplikát pravidla ${at(f.a)} ~ ${at(f.b)} (${f.why}, id ${f.id}): "${snippet(f.a.text)}", ${what}, alebo zámerné opakovanie zapíš do ${ALLOW_FILE}`;
}

export function dupeProblems(repo, agents, show, brain = brainGlobalDir()) {
  const { findings, problems } = ruleDupes(repo, agents, brain);
  return [...problems, ...findings.map((f) => describe(f, show))];
}

export function agentRepos(root) {
  return (existsSync(root) ? readdirSync(root) : [])
    .filter((n) => existsSync(join(root, n, "PERSONA.md")))
    .map((n) => ({ name: n, dir: join(root, n) }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const home = process.env.HOME || "/root";
  const root = process.env.AR_AGENTS ? resolve(process.env.AR_AGENTS) : process.platform === "darwin" ? join(home, "Work", "agenti") : home;
  const p = dupeProblems(repo, agentRepos(root));
  for (const l of p) console.log(`✗ ${l}`);
  console.log(p.length ? `${p.length} nálezov` : "bez duplikátov");
  process.exit(p.length ? 1 : 0);
}
