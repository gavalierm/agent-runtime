#!/usr/bin/env node
// own_rule_scope.mjs: pravidlo, ktoré potrebuje aj iný agent, nepatrí do
// vlastného repa (global/CLAUDE.md §3: "If other agents need a rule or hold
// a copy, it goes to global rules or a role, not your own repo. Check before
// writing."). PreToolUse pre Write, Edit a MultiEdit (zapojuje ho
// env/server/install.sh a env/mac/settings.json repa pravidiel).
//
// Cieľ je CLAUDE.md alebo PERSONA.md v koreni repa agenta: server
// /root/<meno>/ (s PERSONA.md, inak je to projekt), /home/<AGENT_TASKER_USER>/agenti/<meno>/
// (používateľ behov úloh, bez premennej sa nekontroluje), Mac ~/Work/agent-<meno>/ a ~/Work/agenti/<meno>/; aj worktree
// .worktrees/<úloha>/. Repo pravidiel (agent-rules, /opt/agent-rules) a projekty hook nechá tak.
//
// Zápis, ktorý pridáva text (aspoň 40 znakov navyše alebo nová odrážka "- "),
// sa prvýkrát zamietne s otázkou, či tú vec robí aj iný agent alebo rola.
// Rovnaký zápis (relácia + cesta + hash nového textu) zopakovaný druhýkrát
// prejde. Zmazanie a preformulovanie bez prírastku prejde hneď.
// Stav: $AR_STATE alebo ~/.local/state/agent-rules/own_rule_scope/<relácia>.
// Chyba 23. 10. 2026 (druhýkrát): pravidlo pre všetkých agentov (úloha
// s riešiteľom) zapísal agent do CLAUDE.md vlastného repa, správne miesto bolo
// env/server/CLAUDE.md.

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { denyTool } from "../lib/deny.mjs";
import { hookEnv } from "../lib/agent_env.mjs";

export const GROWTH = 40;
const FILES = new Set(["CLAUDE.md", "PERSONA.md"]);
const NOT_AGENT = new Set(["agent-rules", "rules"]);
const WT = /\/\.worktrees\/[^/]+$/;

export const POSTUP =
  "ak tú vec robí aj iný agent alebo rola, zapíš ju do env/<prostredie>/CLAUDE.md, global/CLAUDE.md alebo roles/ " +
  "v repe agent-rules (/root/agent-rules, commit s riadkom o dosahu); ak je len tvoja, zopakuj ten istý zápis a prejde.";

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
  if (!["Write", "Edit", "MultiEdit"].includes(input.tool_name)) return null;
  const file = (input.tool_input || {}).file_path;
  if (!file) return null;
  const abs = resolve(input.cwd || process.cwd(), String(file));
  const repo = agentRepoOf(abs, opts);
  if (!repo) return null;
  const text = addedText(input, opts.read);
  if (text === null) return null;
  const stateDir = opts.stateDir || process.env.AR_STATE || join(process.env.HOME || homedir(), ".local/state/agent-rules/own_rule_scope");
  if (seenBefore({ stateDir, session: input.session_id, file: abs, text })) return null;
  return `Zapisuješ nový text do ${abs}, do vlastného repa agenta. Robí tú vec aj iný agent alebo rola? Podľa global/CLAUDE.md §3 taká vec patrí do repa pravidiel, nie do repa jedného agenta.`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  let why = null;
  try { why = check(input, { taskerUser: hookEnv(input).AGENT_TASKER_USER }); } catch {}
  if (why) denyTool(why, POSTUP);
}
