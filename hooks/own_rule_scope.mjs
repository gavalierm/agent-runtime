#!/usr/bin/env node
// own_rule_scope.mjs: pravidlo, ktoré potrebuje aj iný agent, nepatrí do
// vlastného repa (RULES.md §3: "If other agents need a rule or hold
// a copy, it goes to global rules or a role, not your own repo. Check before
// writing."). PreToolUse pre Write, Edit, MultiEdit a Bash (zapojuje ho
// adaptér prostredia).
//
// Cieľ je CLAUDE.md alebo PERSONA.md v koreni repa agenta: server
// /root/<meno>/ (s PERSONA.md, inak je to projekt), /home/<AGENT_TASKER_USER>/agenti/<meno>/
// (používateľ behov úloh, bez premennej sa nekontroluje), Mac ~/Work/agent-<meno>/ a ~/Work/agenti/<meno>/; aj worktree
// .worktrees/<úloha>/. Repo kódu a spoločného mozgu (workflowDir, brainGlobalDir) a projekty hook nechá tak.
//
// Zápis, ktorý pridáva text (aspoň 40 znakov navyše alebo nová odrážka "- "),
// sa prvýkrát zamietne s otázkou, či tú vec robí aj iný agent alebo rola.
// Rovnaký zápis (relácia + cesta + hash nového textu) zopakovaný druhýkrát
// prejde. Zmazanie a preformulovanie bez prírastku prejde hneď.
// Stav: $AR_STATE alebo ~/.local/state/agentic-workflow/own_rule_scope/<relácia>.
// Príčina zavedenia: pravidlo pre všetkých agentov zapísal agent do CLAUDE.md
// vlastného repa, správne miesto bolo env/server/RULES.md.
//
// Odsek s dátumom chyby (úloha 613): chyba agenta sa zapisuje len do registra
// skriptom chyba.sh (stĺpec mechanizmus), nikdy ako nový odsek "Chyba <deň>. <mesiac>. <rok>"
// do CLAUDE.md alebo PERSONA.md (ľubovoľný taký súbor, aj v repe kódu). Hook
// zamietne trvalo, druhý pokus neprejde: Edit a MultiEdit s väčším počtom takých
// odsekov v new_string než v old_string, Write s väčším počtom než má súbor,
// Bash s textom odseku a zápisom (presmerovanie >, >>, tee, sed -i, perl -i,
// python s open na zápis) do takého súboru. Čítanie (grep, cat, sed -n) prejde.
// Mazanie prejde (úloha 625): pri sed -i, perl -i a python s prepisom súboru
// (open na "w", write_text, write_bytes) hook prečíta cieľový súbor (cesta
// z príkazu, relatívna voči cwd) a zamietne len odsek s dátumom z textu príkazu,
// ktorý v súbore ešte nie je (porovnanie po zlúčení medzier). Odsek, ktorý v súbore
// je, príkaz maže alebo preformuluje. Presmerovanie, tee a python len s módom "a"
// pridávajú vždy, tam sa zamieta bez porovnania. Neexistujúci súbor: zamietne.

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { denyTool } from "../lib/deny.mjs";
import { hookEnv } from "../lib/agent_env.mjs";
import { brainGlobalDir, workflowDir } from "../lib/paths.mjs";

export const GROWTH = 40;
const FILES = new Set(["CLAUDE.md", "PERSONA.md"]);
const NOT_AGENT = new Set([basename(workflowDir()), basename(brainGlobalDir()), "rules"]);
const WT = /\/\.worktrees\/[^/]+$/;

export const POSTUP =
  "ak tú vec robí aj iný agent alebo rola, zapíš ju do RULES.md, env/<prostredie>/RULES.md alebo roles/ " +
  "v repe kódu alebo spoločného mozgu (commit s riadkom o dosahu); ak je len tvoja, zopakuj ten istý zápis a prejde.";

export const POSTUP_CHYBA =
  `spusti ${join(workflowDir(), "bin", "chyba.sh")} --trieda <trieda> --subor <súbor s opravou> --mechanizmus <hook|test|deny|rozhodnutie>:<cesta alebo id>; ` +
  "pravidlo bez dátumu a čísla úlohy prepíš v existujúcom odseku.";

const CHYBA_RE = /\bChyba \d{1,2}\. ?\d{1,2}\. ?\d{4}\b/g;
const count = (s) => (String(s ?? "").match(CHYBA_RE) || []).length;
// Cieľový súbor v príkaze: CLAUDE.md alebo PERSONA.md, s cestou alebo bez nej.
const TARGET = String.raw`(?:[^\s"'|;&<>()]*\/)?(?:CLAUDE|PERSONA)\.md(?=$|[\s"'|;&<>()\\])`;
const WRITE_TO_TARGET = [
  new RegExp(String.raw`>>?\s*["']?` + TARGET),
  new RegExp(String.raw`\btee\s+(?:-\S+\s+)*["']?` + TARGET),
  new RegExp(String.raw`\b(?:sed|perl)(?=\s)[\s\S]*?\s(?:-[A-Za-z]*i\S*|--in-place\S*)(?=\s)[\s\S]*` + TARGET),
  new RegExp(String.raw`^(?=[\s\S]*\bpython3?\b)(?=[\s\S]*(?:open\([^)]*["'][wa]\+?b?["']|write_text|write_bytes))[\s\S]*` + TARGET),
];

// Mazanie a preformulovanie (úloha 625): Bash cez sed -i, perl -i alebo python
// s prepisom súboru (open na zápis, write_text) odsek, ktorý je v cieľovom súbore
// už teraz, nepridáva. Zamietne len odsek, ktorého text v súbore nie je. Presmerovanie,
// tee a python len s módom "a" pridávajú vždy, tam platí zamietnutie bez porovnania.
const PY_RE = WRITE_TO_TARGET[3];
const REWRITE = [WRITE_TO_TARGET[2], PY_RE];
const PY_REPLACE = /open\([^)]*["']w\+?b?["']|write_text|write_bytes/;
const ws = (s) => String(s).replace(/\s+/g, " ").trim();
const DATUM = /\d{1,2}\. ?\d{1,2}\. ?\d{4}/;
// Odseky s dátumom chyby v texte príkazu: od "Chyba <dátum>" po koniec riadku, úvodzovky,
// spätné lomítko, lomku, zvislú čiaru (oddeľovač sed) alebo kotvu konca riadku. Medzery sa zlúčia.
const odseky = (cmd) => [...cmd.matchAll(/\bChyba \d{1,2}\. ?\d{1,2}\. ?\d{4}[^\n'"\\/|$]*/g)].map((m) => ws(m[0]));

// Zápis nového odseku s dátumom chyby do CLAUDE.md alebo PERSONA.md: vráti
// { file, datum } alebo null.
export function chybaOdsek(input, read = (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } }) {
  const ti = input.tool_input || {};
  const tool = input.tool_name;
  if (tool === "Bash") {
    const cmd = String(ti.command ?? "");
    const datum = cmd.match(new RegExp(CHYBA_RE.source));
    if (!datum) return null;
    for (const re of WRITE_TO_TARGET) {
      const t = cmd.match(re);
      if (t) {
        const file = t[0].match(new RegExp(TARGET + "$"));
        const hit = { file: file ? file[0] : "CLAUDE.md", datum: datum[0].slice("Chyba ".length) };
        if (!REWRITE.includes(re) || (re === PY_RE && !PY_REPLACE.test(cmd))) return hit;
        const obsah = ws(read(resolve(input.cwd || process.cwd(), hit.file)));
        const nove = odseky(cmd).find((o) => !obsah.includes(o));
        return nove ? { ...hit, datum: nove.match(DATUM)[0] } : null;
      }
    }
    return null;
  }
  if (!["Write", "Edit", "MultiEdit"].includes(tool)) return null;
  const file = ti.file_path;
  if (!file || !FILES.has(basename(String(file)))) return null;
  let more = false;
  if (tool === "Edit") more = count(ti.new_string) > count(ti.old_string);
  else if (tool === "MultiEdit") more = (ti.edits || []).some((e) => count(e.new_string) > count(e.old_string));
  else more = count(ti.content) > count(read(String(file)));
  if (!more) return null;
  const texts = tool === "Write" ? [ti.content] : tool === "Edit" ? [ti.new_string] : (ti.edits || []).map((e) => e.new_string);
  const datum = texts.map((t) => String(t ?? "").match(new RegExp(CHYBA_RE.source))).find(Boolean);
  return { file: String(file), datum: datum ? datum[0].slice("Chyba ".length) : "<dátum>" };
}

// Repo agenta (priečinok) pre súbor, inak null.
export function agentRepoOf(file, { home = process.env.HOME || homedir(), exists = existsSync, taskerUser = process.env.AGENT_TASKER_USER } = {}) {
  const p = resolve(String(file || ""));
  if (!FILES.has(basename(p))) return null;
  const dir = dirname(p).replace(WT, "");
  const h = home.replace(/\/$/, "");
  const under = (root, re) => {
    if (dirname(dir) !== root) return null;
    const n = basename(dir);
    return re.test(n) && !NOT_AGENT.has(n) ? n : null;
  };
  if (under(`${h}/Work`, /^agent-.+/) || under(`${h}/Work/agenti`, /^.+/) || (taskerUser && under(`/home/${taskerUser}/agenti`, /^.+/))) return dir;
  if ((dirname(dir) === "/root" || dirname(dir) === h) && !NOT_AGENT.has(basename(dir)) && basename(dir) !== ".claude"
    && (exists(join(dir, "PERSONA.md")) || basename(p) === "PERSONA.md")) return dir;
  return null;
}

const bullets = (s) => String(s).split("\n").filter((l) => /^- /.test(l)).length;
const adds = (oldS, newS) => String(newS).length - String(oldS).length >= GROWTH || bullets(newS) > bullets(oldS);

// Pridáva zápis text? Vráti text na hash alebo null.
export function addedText(input, read = (f) => { try { return readFileSync(f, "utf8"); } catch { return ""; } }) {
  const ti = input.tool_input || {};
  if (input.tool_name === "Edit") return adds(ti.old_string ?? "", ti.new_string ?? "") ? String(ti.new_string) : null;
  if (input.tool_name === "MultiEdit") {
    const hit = (ti.edits || []).filter((e) => adds(e.old_string ?? "", e.new_string ?? ""));
    return hit.length ? hit.map((e) => String(e.new_string)).join("\n\u0000\n") : null;
  }
  if (input.tool_name === "Write") return adds(read(ti.file_path), ti.content ?? "") ? String(ti.content) : null;
  return null;
}

const sha = (s) => createHash("sha256").update(s).digest("hex");

// Druhý rovnaký pokus: stav zapíše pri prvom. Vráti true, keď zápis má prejsť.
export function seenBefore({ stateDir, session, file, text }) {
  const key = `${sha(resolve(file))} ${sha(text)}`;
  const path = join(stateDir, String(session || "bez-relacie").replace(/[^\w.-]/g, "_"));
  let seen = "";
  try { seen = readFileSync(path, "utf8"); } catch {}
  if (seen.split("\n").includes(key)) return true;
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  appendFileSync(path, key + "\n", { mode: 0o600 });
  return false;
}

export function check(input, opts = {}) {
  const chyba = chybaOdsek(input, opts.read);
  if (chyba) return `Odsek Chyba ${chyba.datum} do ${chyba.file} nejde, chyba patrí do registra (skill chyba).`;
  if (!["Write", "Edit", "MultiEdit"].includes(input.tool_name)) return null;
  const file = (input.tool_input || {}).file_path;
  if (!file) return null;
  const abs = resolve(input.cwd || process.cwd(), String(file));
  const repo = agentRepoOf(abs, opts);
  if (!repo) return null;
  const text = addedText(input, opts.read);
  if (text === null) return null;
  const stateDir = opts.stateDir || process.env.AR_STATE || join(process.env.HOME || homedir(), ".local/state/agentic-workflow/own_rule_scope");
  if (seenBefore({ stateDir, session: input.session_id, file: abs, text })) return null;
  return `Zapisuješ nový text do ${abs}, do vlastného repa agenta. Robí tú vec aj iný agent alebo rola? Podľa RULES.md §3 taká vec patrí do spoločných pravidiel, nie do repa jedného agenta.`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  let why = null;
  try { why = check(input, { taskerUser: hookEnv(input).AGENT_TASKER_USER }); } catch {}
  if (why) denyTool(why, why.startsWith("Odsek Chyba ") ? POSTUP_CHYBA : POSTUP);
}
