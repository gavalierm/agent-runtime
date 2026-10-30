#!/usr/bin/env node
// check.mjs — jedinečnosť mien skillov, stav nasadenia, requires hookov a mŕtvy kód. Exit 1 pri probléme.
//
//   node check.mjs           vypíše všetko
//   node check.mjs --quiet   mlčí, keď je všetko v poriadku (SessionStart hook)
//   node check.mjs --list    vypíše každý skill podľa zdroja
//
// Meno skillu existuje v systéme raz. Kolízia je vyriešená, keď sú všetci
// kolidujúci okrem jedného skrytí pred modelom: permissions.deny ako
// Skill(<id>), disable-model-invocation vo frontmatter, alebo skillOverrides
// v settings.json (na pluginové skilly neplatí, docs 2026-09-21).

import { execSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CLAUDE, HOME, MODEL_PLUGINS, entries, isDir, pluginRoots, skillDirs, userOnly } from "./lib/plugins.mjs";
import { LIMIT as UNSLOP_LIMIT, core as unslopCore } from "./hooks/unslop.mjs";
import { agentDocs, stalePaths } from "./lib/doc_paths.mjs";
import { deployKeyProblems } from "./lib/deploy_keys.mjs";
import { wordCapProblems } from "./lib/word_cap.mjs";
import { check as rozhodniaCheck, defaultDir as rozhodniaDir, zapnute as rozhodniaZapnute } from "./lib/rozhodnutia.mjs";
import { memoryProblems } from "./lib/memory_claims.mjs";
import { openBranchFiles } from "./lib/open_branches.mjs";
import { denyProblems } from "./lib/deny_check.mjs";
import { dupeProblems } from "./lib/rule_dupes.mjs";
import { brainGlobalDir, workflowDir } from "./lib/paths.mjs";
import { agentDefProblems } from "./lib/agent_defs.mjs";
import { requiresProblems } from "./lib/hook_requires.mjs";
import { deadCodeProblems } from "./lib/dead_code.mjs";
import { driftProblems, settingsFor, tableProblems } from "./env/hooks.mjs";

const REPO = dirname(fileURLToPath(import.meta.url));
// Prostredie: Mac má pracovisko ~/Work, server stromy agentov v /root.
// Nasadený klon je workflowDir() z lib/paths.mjs.
const MAC = process.platform === "darwin";
const WORK = MAC ? resolve(HOME, "Work") : resolve(HOME);
const DEPLOY_CLONE = workflowDir();
// Hlavný checkout repa. Vo worktree (.worktrees/<úloha>) je iný ako REPO:
// symlinky v ~/.claude a lokálne súbory ako .claude/settings.local.json
// ukazujú do hlavného checkoutu. Kontroly nasadenia na Mac preto bežia len
// v ňom, kontroly obsahu repa všade.
const MAIN = (() => {
  try {
    return dirname(resolve(REPO, execSync("git rev-parse --git-common-dir", { cwd: REPO, encoding: "utf8" }).trim()));
  } catch {
    return REPO;
  }
})();
// Nasadenie sa kontroluje len v nasadenom klone, inde (worktree, klon
// správcu agentov na serveri) len obsah repa.
const deployed = MAIN === REPO && REPO === DEPLOY_CLONE;
const quiet = process.argv.includes("--quiet");
const listing = process.argv.includes("--list");

// Zabudované skilly harness-u sa z disku nedajú vypísať. Zoznam z výpisu
// skillov v session 2026-09-21 — doplň, keď pribudne.
const BUILTIN = [
  "code-review", "simplify", "init", "security-review", "loop", "schedule", "run",
  "fewer-permission-prompts", "update-config", "keybindings-help", "claude-api",
  "workflow-authoring", "claude-in-chrome", "dataviz", "artifact-design",
  "artifact-diagramming", "artifact-capabilities",
];
const SKIP = new Set(["node_modules", "vendor", ".git", ".svelte-kit", "build", "dist", "scratch", "archiv"]);

const problems = [];
// Repá agentov: na Macu ~/Work/agenti/<meno>, na serveri /root/<meno>.
// AR_AGENTS ukáže na iný priečinok, napríklad na worktree vetiev agentov
// pred ich zlúčením, alebo na fixtúru testu.
const AGENTI = process.env.AR_AGENTS ? resolve(process.env.AR_AGENTS) : MAC ? resolve(WORK, "agenti") : WORK;
const agentRepos = () => (existsSync(AGENTI) ? readdirSync(AGENTI) : []).filter((a) => existsSync(resolve(AGENTI, a, "PERSONA.md")));

const notes = [];
const found = []; // { name, id, source }
const tilde = (p) => p.replace(HOME, "~");

// 1. vlastné
const own = new Set();
for (const p of skillDirs(join(REPO, "skills"), 0)) {
  own.add(basename(p));
  const uo = userOnly(p);
  found.push({ name: basename(p), id: basename(p), source: `vlastný${uo ? ", len /príkaz" : ""}`, userOnly: uo });
}

// 2. ~/.claude/skills — symlinky do repa, alebo cudzie. Symlink ukazuje do
// hlavného checkoutu, aj keď check beží vo worktree.
for (const e of entries(join(CLAUDE, "skills"))) {
  if (e === "synced" || e.startsWith(".")) continue;
  const p = join(CLAUDE, "skills", e);
  let target = null;
  try {
    if (lstatSync(p).isSymbolicLink()) target = resolve(dirname(p), readlinkSync(p));
  } catch {}
  // Symlink do nasadeného klonu platí aj pri kontrole iného klonu (správca
  // agentov na serveri má vlastný klon, nasadený je workflowDir()).
  if (target && target.startsWith(join(DEPLOY_CLONE, "skills") + "/") && MAIN !== DEPLOY_CLONE) continue;
  // Mimo nasadeného klonu je nasadenie vec toho klonu: vlastný skill
  // nasadený z iného klonu (starého repa pravidiel, iného checkoutu) je
  // poznámka, nie kolízia.
  if (target && !deployed && own.has(e) && basename(dirname(target)) === "skills") {
    notes.push(`skill ${e} je nasadený z iného klonu, ${tilde(target)}`);
    continue;
  }
  // Skill spoločného mozgu: symlink do $AGENT_BRAIN_GLOBAL/skills, nasadzuje ho
  // env/*/install.sh vedľa skillov tohto repa.
  if (target && target.startsWith(join(brainGlobalDir(), "skills") + "/")) {
    if (!existsSync(target)) problems.push(`mŕtvy symlink ${tilde(p)} → ${tilde(target)}`);
    else found.push({ name: e, id: e, source: `mozog ${tilde(brainGlobalDir())}` });
    continue;
  }
  if (target && (target.startsWith(join(MAIN, "skills") + "/") || agentRepos().some((a) => target.startsWith(join(AGENTI, a, "skills") + "/") || target.startsWith(join(AGENTI, a, ".claude", "skills") + "/")))) {
    if (!existsSync(target)) problems.push(`mŕtvy symlink ${tilde(p)} → ${tilde(target)}`);
    else if (!target.startsWith(join(MAIN, "skills") + "/")) found.push({ name: e, id: e, source: `agent ${tilde(dirname(dirname(target)).replace(/\/\.claude$/, ""))}` });
    continue;
  }
  found.push({ name: e, id: e, source: `${tilde(p)} (mimo repa)` });
  problems.push(`skill mimo repa: ${tilde(p)} — presuň do ${tilde(REPO)}/skills alebo zmaž`);
}
for (const n of deployed && MAC ? own : []) {
  const link = join(CLAUDE, "skills", n);
  let ok = false;
  try {
    ok = lstatSync(link).isSymbolicLink() && resolve(dirname(link), readlinkSync(link)) === join(REPO, "skills", n);
  } catch {}
  if (!ok) problems.push(`skill ${n} nie je nasadený — spusti env/mac/install.sh`);
}

// 3. synced z claude.ai
for (const bucket of entries(join(CLAUDE, "skills", "synced"))) {
  if (bucket.startsWith(".")) continue;
  for (const p of skillDirs(join(CLAUDE, "skills", "synced", bucket), 0)) {
    found.push({ name: basename(p), id: `anthropic-skills:${basename(p)}`, source: "claude.ai synced" });
  }
}

// 4. zapnuté pluginy
// Pluginy, deny a skillOverrides berie kontrola zo živého ~/.claude/settings.json
// (kľúče mimo hookov patria stroju a spoločnému mozgu, nie tomuto repu); hooky
// vzniknú z env/hooks.mjs (druh mac) a živý súbor sa s nimi porovná nižšie.
const generated = settingsFor("mac", join(REPO, "hooks"), REPO);
let settings = {};
try {
  if (existsSync(join(CLAUDE, "settings.json"))) settings = JSON.parse(readFileSync(join(CLAUDE, "settings.json"), "utf8"));
} catch (e) {
  problems.push(`~/.claude/settings.json sa nedá načítať: ${e.message}`);
}
// Commit agenta nemá trailer Co-Authored-By ani Claude-Session. Zastaraný
// includeCoAuthoredBy odkaz na reláciu Remote Control neskryje (2026-10-16).
// Platí aj pre nastavenie agentov v ich repách.
// Spoločné nastavenie (root na serveri, používateľ na Macu), z neho bežia vlákna
// bez vlastného .claude/settings.json (2026-10-19).
const attributionFiles = agentRepos().map((a) => join(AGENTI, a, ".claude", "settings.json"));
if (!process.env.AR_AGENTS) attributionFiles.push(join(CLAUDE, "settings.json"));
for (const p of attributionFiles) {
  let a;
  try {
    a = JSON.parse(readFileSync(p, "utf8")).attribution;
  } catch {
    continue;
  }
  if (a !== false && !(a?.commit === "" && a?.pr === "" && a?.sessionUrl === false))
    problems.push(`${tilde(p)}: attribution nemá commit "", pr "" a sessionUrl false, commity agenta dostanú Co-Authored-By a Claude-Session`);
}
// Pluginový skill má mať disable-model-invocation: true, model ho nevidí,
// operátor ho volá cez /plugin:meno. Aktualizácia pluginu príznak zmaže.
// Skilly pluginov z MODEL_PLUGINS príznak mať nesmú, volá ich aj model.
const seenPlugin = new Set();
for (const { key, plugin, root } of pluginRoots(settings)) {
  if (!root) {
    notes.push(`plugin ${key} je zapnutý, ale v cache chýba`);
    continue;
  }
  for (const p of skillDirs(join(root, "skills"), 3)) {
    const id = `${plugin}:${basename(p)}`;
    if (seenPlugin.has(id)) continue;
    seenPlugin.add(id);
    const uo = userOnly(p);
    found.push({ name: basename(p), id, source: `plugin ${key}${uo ? ", len /príkaz" : ""}`, userOnly: uo });
    if (MODEL_PLUGINS.has(key)) {
      if (uo) problems.push(`pluginový skill ${id} má volať aj model, ale je len na príkaz, spusti env/mac/install.sh`);
    } else if (!uo) problems.push(`pluginový skill ${id} sa načítava automaticky, spusti env/mac/install.sh`);
  }
}

// 5. projektové .claude/skills v ~/Work (osobný skill ich tieňuje)
function walk(dir, depth) {
  if (depth < 0) return;
  for (const e of entries(dir)) {
    if (SKIP.has(e)) continue;
    const p = join(dir, e);
    if (e === ".claude") {
      for (const s of skillDirs(join(p, "skills"), 0)) {
        const proj = tilde(dir);
        found.push({ name: basename(s), id: `${proj}:${basename(s)}`, source: `projekt ${proj}` });
      }
      continue;
    }
    if (e.startsWith(".")) continue;
    if (isDir(p)) walk(p, depth - 1);
  }
}
if (MAC) walk(WORK, 5);

// 6. zabudované
for (const n of BUILTIN) found.push({ name: n, id: n, source: "builtin" });

// --- kolízie ---------------------------------------------------------------
const deny = new Set((settings.permissions?.deny || []).map((d) => d.replace(/^Skill\((.*)\)$/, "$1")));
const overrides = settings.skillOverrides || {};
const overridden = (f) => !f.source.startsWith("plugin ") && ["off", "user-invocable-only"].includes(overrides[f.name]);
const hidden = (f) => deny.has(f.id) || Boolean(f.userOnly) || overridden(f);
const byName = new Map();
for (const f of found) byName.set(f.name, [...(byName.get(f.name) || []), f]);
for (const [name, list] of byName) {
  if (list.length < 2) continue;
  const live = list.filter((f) => !hidden(f));
  const desc = list.map((f) => `${f.id} [${f.source}${deny.has(f.id) ? ", deny" : ""}${overridden(f) ? ", skillOverrides " + overrides[f.name] : ""}]`).join(" · ");
  if (live.length <= 1) notes.push(`kolízia ${name} vyriešená: ${desc}`);
  else if (list.some((f) => f.source === "vlastný"))
    problems.push(`kolízia ${name}: ${desc} — vlastný ostáva, cudzím pridaj Skill(<id>) do permissions.deny`);
  else problems.push(`kolízia ${name}: ${desc} — cudzí × cudzí, vyberie operátor`);
}

// --- delegovanie vo vlastných skilloch ---------------------------------------
// Nástroj Skill odmietne skill, ktorý model nevidí. Vlastný skill, ktorý naň
// cez nástroj Skill deleguje, preto nikdy nedobehne. Postup cudzieho skillu
// sa načíta zo súboru: vlastný skill uvedie kľúč pluginu a cestu k SKILL.md
// pod jeho koreňom, obe v spätných apostrofoch, a tu sa overí, že súbor je.
const roots = pluginRoots(settings);
for (const n of own) {
  const text = readFileSync(join(REPO, "skills", n, "SKILL.md"), "utf8");
  const body = text.split(/^---$/m).slice(2).join("---");
  const delegated = new Set();
  for (const line of body.split("\n")) {
    if (/Skill tool|nástroj\w* Skill|Skill\(/.test(line))
      for (const [, id] of line.matchAll(/["'`(]([\w-]+(?::[\w-]+)?)["'`)]/g)) delegated.add(id);
    // Pluginový skill s menným priestorom je pokyn na volanie aj bez slova
    // "Skill", napríklad "use a superpowers:* skill" alebo `superpowers:tdd`.
    for (const [, id] of line.matchAll(/\b([\w-]+:[\w-]+)\b/g)) delegated.add(id);
    for (const [, ns] of line.matchAll(/\b([\w-]+):\*/g))
      for (const f of found) if (f.id.startsWith(`${ns}:`)) delegated.add(f.id);
  }
  const blocked = [...delegated].filter((id) => {
    const target = found.find((f) => f.id === id && f.id !== n);
    return target && hidden(target);
  });
  if (blocked.length)
    problems.push(`skill ${n} deleguje na skilly, ktoré model nevolá: ${[...new Set(blocked)].sort().join(", ")} — načítaj ich SKILL.md zo súboru`);
  const keys = [...body.matchAll(/`([\w-]+@[\w-]+)`/g)].map((m) => m[1]);
  const files = [...body.matchAll(/`(skills\/[^`]+\/SKILL\.md)`/g)].map((m) => m[1]);
  for (const key of new Set(keys)) {
    const root = roots.find((r) => r.key === key)?.root;
    if (!root) {
      problems.push(`skill ${n} číta z pluginu ${key}, ktorý nie je zapnutý alebo chýba v cache`);
      continue;
    }
    for (const f of new Set(files))
      if (!existsSync(join(root, f))) problems.push(`skill ${n} číta ${f} z pluginu ${key}, súbor tam nie je`);
  }
}

// --- nasadenie (len hlavný checkout) -----------------------------------------
function linked(link, target) {
  try {
    return lstatSync(link).isSymbolicLink() && resolve(dirname(link), readlinkSync(link)) === target;
  } catch {
    return false;
  }
}
if (!deployed) notes.push(`${tilde(REPO)} nie je nasadený klon ${tilde(DEPLOY_CLONE)}, nasadenie (symlinky, settings.json, gitignore) sa tu nekontroluje`);
// ~/.claude/CLAUDE.md je súbor s dvoma importmi: RULES.md klonu kódu a RULES.md spoločného mozgu.
if (deployed) {
  let have = [];
  try {
    have = readFileSync(join(CLAUDE, "CLAUDE.md"), "utf8").split("\n").map((l) => l.trim());
  } catch {}
  for (const want of [join(REPO, "RULES.md"), join(brainGlobalDir(), "RULES.md")])
    if (!have.includes(`@${want}`)) problems.push(`~/.claude/CLAUDE.md nemá riadok @${tilde(want)} — spusti install.sh prostredia (env/${MAC ? "mac" : "server"}/install.sh)`);
}
if (deployed && MAC && !linked(join(WORK, "CLAUDE.md"), join(brainGlobalDir(), "env", "mac", "RULES.md"))) problems.push("~/Work/CLAUDE.md nie je symlink na env/mac/RULES.md spoločného mozgu — spusti env/mac/install.sh");
if (deployed && !MAC && !linked(join(WORK, "CLAUDE.md"), join(brainGlobalDir(), "env", "server", "RULES.md"))) problems.push("/root/CLAUDE.md nie je symlink na env/server/RULES.md spoločného mozgu — spusti env/server/install.sh");

if (deployed && MAC) {
  // Živý súbor sa nesmie líšiť od toho, čo z env/hooks.mjs urobí env/mac/install.sh.
  const drift = driftProblems(settings, "mac", join(REPO, "hooks"), REPO);
  if (drift.length) problems.push(`drift: ~/.claude/settings.json ≠ výstup env/hooks.mjs (mac) — spusti env/mac/install.sh (zlúči hooky do živého súboru, ostatné kľúče nechá)`);
}
if (deployed && MAC) try {
  const ex = execSync("git config --global core.excludesfile", { encoding: "utf8" }).trim();
  if (resolve(ex.replace(/^~/, HOME)) !== join(REPO, "env", "mac", "gitignore")) problems.push("globálny gitignore nie je nastavený na env/mac/gitignore — spusti env/mac/install.sh");
} catch {
  problems.push("globálny gitignore nie je nastavený — spusti env/mac/install.sh");
}

// --- unslop v kontexte relácie ----------------------------------------------
// hooks/unslop.mjs vkladá sekciu Jadro skillu, musí byť pod limitom
// a settings.json musí hook volať.
try {
  const t = unslopCore();
  if (t.length > UNSLOP_LIMIT) problems.push(`unslop: Jadro má ${t.length} znakov, limit hooku je ${UNSLOP_LIMIT}`);
} catch (e) {
  problems.push(`unslop: pravidlá sa nedajú načítať: ${e.message}`);
}
const startCmds = (generated.hooks?.SessionStart || []).flatMap((m) => m.hooks || []).map((h) => h.command || "");
if (!startCmds.some((c) => /hooks\/unslop\.mjs"?\s*$/.test(c)))
  problems.push("unslop: env/hooks.mjs nevolá pre mac SessionStart hook hooks/unslop.mjs bez argumentu");
// Zmena pravidiel ide do ťahu hookom rules_delta.mjs, nie správou do
// schránky (rozhodnutie z 19. 10. 2026, budič budí zadávateľa len keď čaká).
const promptCmds = (generated.hooks?.UserPromptSubmit || []).flatMap((m) => m.hooks || []).map((h) => h.command || "");
if (!promptCmds.some((c) => /hooks\/rules_delta\.mjs"?\s*$/.test(c)))
  problems.push("rules_delta: env/hooks.mjs nevolá pre mac UserPromptSubmit hook hooks/rules_delta.mjs");

// --- spustiteľné súbory v gite -----------------------------------------------
// env/mac/install.sh robí chmod +x na hooks/*.mjs. Súbor, ktorý má v gite
// 100644, by po inštalácii zašpinil klon a rebase by padol.
for (const line of spawnSync("git", ["-C", REPO, "ls-files", "-s", "hooks/*.mjs", "check.mjs", "lib/plugin_skills_user_only.mjs"], { encoding: "utf8" }).stdout.split("\n")) {
  const [mode, , , file] = line.split(/\s+/);
  if (file && mode !== "100755") problems.push(`${file} má v gite ${mode}, install.sh ho spraví spustiteľným: git update-index --chmod=+x ${file}`);
}

// --- pamäť agentov v gite ---------------------------------------------------
// Pamäť agenta s identitou je v gite (rozhodnutie zo 14. 10. 2026).
// Tajomstvo v nej by ostalo v histórii natrvalo, preto sa pred commitom
// hľadajú vzory kľúčov a hesiel v memory/ každého repa agenta.
const SECRET = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(password|passwd|heslo|token|secret|api[_-]?key)\s*[:=]\s*["']?[^\s"']{8,}/i,
];
// Vo worktree sa namiesto pamäte hlavného checkoutu číta pamäť worktree,
// ktorú ide commit zapísať.
for (const a of agentRepos()) {
  const dir = resolve(AGENTI, a, "memory");
  if (!existsSync(dir)) continue;
  // Podpriečinky, napríklad memory/topics, tiež. Do 16. 10. 2026 tu bol
  // readdirSync bez recursive a check.mjs na priečinku spadol.
  for (const f of readdirSync(dir, { recursive: true })) {
    if (lstatSync(resolve(dir, f)).isDirectory()) continue;
    const text = readFileSync(resolve(dir, f), "utf8");
    const hit = SECRET.find((r) => r.test(text));
    if (hit) problems.push(`pamäť ${tilde(resolve(dir, f))} vyzerá, že obsahuje tajomstvo (${hit.source.slice(0, 30)}), do gitu nesmie`);
    // Chyba je vlastnosť persony, nie fakt v pamäti (rozhodnutie z 18. 10. 2026,
    // PERSONA.md "Vlastná chyba"). Poučenie patrí do persony alebo pravidla.
    // Všetci agenti v ~/Work/agenti.
    // K4 (návrh 390): stav "čaká na operátora" a rozhodnutia patria do Taskera
    // a do decisions/. Vypnuté, kým nie je AR_ROZHODNUTIA=1; ručne:
    // node lib/memory_claims.mjs <súbor>. Pamäte vyčistila úloha 401.
    if (rozhodniaZapnute() && f.endsWith(".md"))
      for (const p of memoryProblems(text)) problems.push(`pamäť ${tilde(resolve(dir, f))}:${p.riadok}: ${p.dovod}`);
    if ((/^\s*type:\s*feedback\b/m.test(text) || /Chybu by zachytil/.test(text)))
      problems.push(`pamäť ${tilde(resolve(dir, f))} nesie poučenie z chyby, prenes ho do persony alebo pravidla a z pamäte zmaž`);
  }
}

// --- roly v personách -------------------------------------------------------
// Riadok "Role: <slug>, <slug>" v PERSONA.md agenta určuje, ktoré súbory
// roles/<slug>.md vloží hook identity.mjs. Slug bez súboru by hook len
// ohlásil v kontexte, preto ho zastaví kontrola už pred commitom.
for (const a of agentRepos()) {
  const persona = readFileSync(resolve(AGENTI, a, "PERSONA.md"), "utf8");
  const slugs = (persona.match(/^Role:[ \t]*(.+)$/m)?.[1] ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  for (const slug of slugs) {
    if (!/^[a-z0-9-]+$/.test(slug) || !existsSync(join(REPO, "roles", `${slug}.md`)))
      problems.push(`persona ${tilde(resolve(AGENTI, a, "PERSONA.md"))} uvádza rolu \`${slug}\`, súbor roles/${slug}.md neexistuje`);
  }
}

// --- zastarané odkazy v pokynoch agentov ------------------------------------
// Odkaz na zmazaný súbor dá agentovi po čistom kontexte neplatný pokyn
// (rozhodnutie z 15. 10. 2026, "zastarané pokyny blokuje kontrola").
{
  const agent = (n) => resolve(AGENTI, n);
  const roots = [WORK, REPO, dirname(REPO), ...agentRepos().map(agent)].filter(existsSync);
  // Dokumenty prostredia Mac odkazujú na súbory, ktoré sú len na Macu
  // (Herd, lokálne settings), na serveri sa nekontrolujú.
  const files = [...agentDocs(REPO).filter((f) => MAC || !f.includes("/env/mac/")), ...agentRepos().flatMap((n) => agentDocs(agent(n)).filter((f) => !f.includes("/memory/")))];
  // Vo worktree a v cudzom klone chýbajú súbory, ktoré git ignoruje
  // a založil ich install.sh v hlavnom checkoute repa (napríklad
  // .claude/settings.local.json). Odkaz na ne platí, keď súbor je
  // v hlavnom checkoute tohto repa alebo repa agenta a git ho tam ignoruje.
  const mainOf = (dir) => {
    try {
      return dirname(resolve(dir, execSync("git rev-parse --git-common-dir", { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim()));
    } catch {
      return dir;
    }
  };
  const local = (p) => {
    if (p.startsWith("/") || p.startsWith("~")) return false;
    for (const base of [MAIN, ...agentRepos().map((n) => mainOf(agent(n)))]) {
      if (!existsSync(join(base, p))) continue;
      try {
        execSync(`git check-ignore -q -- ${JSON.stringify(p)}`, { cwd: base, stdio: "ignore" });
        return true;
      } catch {}
    }
    return false;
  };
  // Súbor, ktorý mení otvorená vetva, opraví jej zlúčenie (lib/open_branches.mjs).
  const pending = new Map([REPO, ...agentRepos().map(agent)].flatMap((d) => [...openBranchFiles(d)]));
  for (const p of stalePaths(files, roots, HOME, undefined, local)) {
    const branch = pending.get(p.replace(/:\d+ .*$/s, ""));
    if (branch) notes.push(`zastaraný odkaz ${tilde(p)}, čaká na zlúčenie ${branch}`);
    else problems.push(`zastaraný odkaz ${tilde(p)}`);
  }
}

// Zrušené meno nesmie ostať v gite repa kódu ani repa agenta
// (lib/retired_names.sh, 19. 10. 2026).
{
  const r = spawnSync("bash", [join(REPO, "lib", "retired_names.sh"), REPO, ...agentRepos().map((n) => resolve(AGENTI, n))], { encoding: "utf8" });
  if (r.status !== 0) problems.push(`zrušené meno v gite:\n${r.stderr.trim()}`);
}

// Skripty prostredia server majú testy env/server/tests, bežia len na serveri.
if (!MAC && existsSync(join(REPO, "env", "server", "tests", "run.sh"))) {
  const r = spawnSync("bash", [join(REPO, "env", "server", "tests", "run.sh")], { encoding: "utf8" });
  if (r.status !== 0) problems.push(`env/server/tests/run.sh zlyhal:\n${(r.stdout + r.stderr).split("\n").filter((l) => /^FAIL|^In |^\s+\^/.test(l)).join("\n")}`);
}

// Každé zamietnutie hooku nesie "Správny postup:" a ide cez lib/deny.mjs
// alebo lib/deny.sh (D0141, úloha 424, lib/deny_check.mjs).
problems.push(...denyProblems(REPO));

// Rovnaké alebo podobné pravidlo v zdieľanom súbore a v lokálnych pravidlách
// agenta, alebo u dvoch agentov, patrí do globálnych pravidiel a kópie
// zmiznú (D0144, úloha 439, lib/rule_dupes.mjs). Zdieľané súbory sú RULES.md
// a roles/ repa, env/*/RULES.md z brainGlobalDir(), ak existuje. Zámerné opakovanie je
// riadok v lib/rule_dupes_allow.txt.
problems.push(...dupeProblems(REPO, agentRepos().map((name) => ({ name, dir: resolve(AGENTI, name) })), tilde));

// Sub-agent implementator beží na Sonnete: agents/implementator.md nesie
// `model: sonnet` (global §6, úloha 602, lib/agent_defs.mjs).
problems.push(...agentDefProblems(REPO));

// Každý hook nesie v druhom riadku `// requires: ...` (lib/hook_requires.mjs).
problems.push(...requiresProblems(REPO));

// Tabuľka hookov env/hooks.mjs: hook existuje, requires sedí s hlavičkou, každý
// hook v hooks/ je v tabuľke, pomocný modul alebo výnimka.
problems.push(...tableProblems(REPO));

// Súbor kódu, ktorý nikde mimo seba a mimo testov nie je importovaný, volaný ani
// menovaný, je mŕtvy; výnimky nesie lib/dead_code_allow.txt (lib/dead_code.mjs).
problems.push(...deadCodeProblems(REPO));

// RULES.md má strop slov, ktorý smie len klesať (lib/word_cap.mjs).
problems.push(...wordCapProblems(REPO));

// Záznamy rozhodnutí: hlavička, jedinečný platný kľúč, moc na rozsah, index
// (lib/rozhodnutia.mjs check). Zrušené tvrdenia z nich číta retiredClaims()
// v kontrole zastaraných odkazov vyššie. ROZHODNUTIA_DIR ukáže na fixtúru.
if (existsSync(rozhodniaDir())) problems.push(...rozhodniaCheck(rozhodniaDir()).map((p) => `rozhodnutia: ${p}`));

// Kľúč so zápisom do repa agenta patrí žijúcemu agentovi (lib/deploy_keys.mjs).
{
  const r = deployKeyProblems();
  if (r.note) notes.push(r.note);
  else problems.push(...r.problems);
}

// --- výstup ----------------------------------------------------------------
if (listing) {
  const groups = new Map();
  for (const f of found) {
    const src = f.source.replace(/, len \/príkaz$/, "");
    groups.set(src, [...(groups.get(src) || []), f]);
  }
  for (const [src, items] of groups) {
    console.log(`\n${src} (${items.length})`);
    for (const f of items.sort((a, b) => a.name.localeCompare(b.name)))
      console.log(`  ${f.name}${deny.has(f.id) ? " [deny]" : ""}${/len \/príkaz/.test(f.source) ? " [len /príkaz]" : ""}`);
  }
  console.log();
}
if (!quiet) {
  console.log(`skilly: ${found.length} (vlastné ${own.size}, zapnuté pluginy ${seenPlugin.size}, builtin ${BUILTIN.length})`);
  for (const n of notes) console.log(`  · ${n}`);
}
if (problems.length) {
  console.log(`check.mjs — ${problems.length} problém(ov):`);
  for (const p of problems) console.log(`  ✗ ${p}`);
  process.exit(1);
}
if (!quiet) console.log("check: v poriadku");
