#!/usr/bin/env node
// web_gate.mjs — brána mockupu webu. Úloha agentovi webu vznikne len s
// `--mockup <id>` (hotová úloha dizajnéra s mockupom, ktorý schválil
// niekto iný ako on) alebo s `--bez-mockupu "<dôvod>"` (zmena bez nového
// vzhľadu, alebo priamy pokyn operátora k dizajnu). Dizajnér je agent
// z WEB_DESIGNER (predvolene `designer`), manuál webu WEB_MANUAL a WEB_MANUAL_BASE
// (predvolene v /home/<AGENT_TASKER_USER>/agenti/<dizajnér>/manualy/). Volá ju bin/uloha-webu.sh,
// hook hooks/web_review.mjs zamietne zakladanie úlohy webu mimo nej.
//
//   node web_gate.mjs create --project P --assign A --title T --body B (--mockup N | --bez-mockupu D) [--parent N] [--verify V] [--model M] [--max-runs N]

import { execFileSync } from "node:child_process";
import { basename, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const TASKER_USER = process.env.AGENT_TASKER_USER || "tasker";
export const DESIGNER = process.env.WEB_DESIGNER || "designer";
const DESIGNER_HOME = `/home/${TASKER_USER}/agenti/${DESIGNER}/manualy`;
export const MANUAL = process.env.WEB_MANUAL || `${DESIGNER_HOME}/web.md`;
export const MANUAL_BASE = process.env.WEB_MANUAL_BASE || `${DESIGNER_HOME}/zaklad/`;
const TK = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "tk");
export const TASKER_HOME = `/home/${TASKER_USER}/.tasker`;
export const APPROVAL = /^[ \t]*Mockup schválený:/m;
export const MIN_REASON = 10;

// Agent webu: meno alebo basename workdiru končí na `-web`.
export function parseAgents(text) {
  const agents = new Map();
  for (const line of String(text).split("\n")) {
    const [name, enabled, workdir] = line.split("\t");
    if (name && enabled) agents.set(name, workdir || "");
  }
  return agents;
}

export function isWebAgent(name, agents = null) {
  if (!name) return false;
  if (/-web$/.test(name)) return true;
  const workdir = agents?.get(name);
  return Boolean(workdir && /-web$/.test(basename(workdir.replace(/\/+$/, ""))));
}

// Argumenty príkazu `tasker` s prostredím. Pod rootom cez obal bin/tk.
export function taskerArgv(args, { uid = process.getuid(), user = process.env.TASKER_USER || process.env.AGENT_NAME || "agent" } = {}) {
  if (uid === 0) return ["env", [`AGENT_NAME=${user}`, TK, ...args]];
  return ["env", [`TASKER_HOME=${process.env.TASKER_HOME || TASKER_HOME}`, `TASKER_USER=${user}`, "tasker", ...args]];
}

export function tasker(args) {
  const [cmd, argv] = taskerArgv(args);
  return execFileSync(cmd, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Zoznam agentov z Taskera alebo null pri chybe.
export function loadAgents() {
  try {
    return parseAgents(tasker(["agent", "list"]));
  } catch {
    return null;
  }
}

export const MANUAL_PARAGRAPH =
  `Pred prácou prečítaj dizajn manuál ${MANUAL} a súbory v ${MANUAL_BASE}. Odchýlku od manuálu zdôvodni v súhrne.`;

const FLAGS = ["project", "parent", "assign", "title", "body", "verify", "model", "max-runs", "mockup", "bez-mockupu"];

export function parseCreateArgs(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([\w-]+)(?:=([\s\S]*))?$/.exec(argv[i]);
    if (!m || !FLAGS.includes(m[1])) throw new Error(`neznáma voľba: ${argv[i]}`);
    o[m[1]] = m[2] ?? argv[++i];
    if (o[m[1]] === undefined) throw new Error(`chýba hodnota pre --${m[1]}`);
  }
  for (const r of ["project", "assign", "title", "body"]) if (!o[r]) throw new Error(`chýba --${r}`);
  return o;
}

export function loadTask(id) {
  return JSON.parse(tasker(["task", "show", String(id), "--json"]));
}

// Overí `--mockup <id>`: úloha dizajnérky v stave done a v komentároch riadok
// `Mockup schválený:` od autora, ktorý nie je dizajnérka. Vráti zoznam chýb.
export function mockupProblems(id, show = loadTask) {
  let t;
  try {
    t = show(id);
  } catch (e) {
    return [`úloha ${id} sa nenačítala: ${e.message}`];
  }
  const problems = [];
  if (t.assignee !== DESIGNER) problems.push(`úloha ${id} nemá riešiteľa ${DESIGNER} (má ${t.assignee || "nikoho"})`);
  if (t.status !== "done") problems.push(`úloha ${id} nie je done (je ${t.status})`);
  const approved = (t.comments || []).some((c) => String(c.author || "").toLowerCase() !== DESIGNER && APPROVAL.test(String(c.body || "")));
  if (!approved) problems.push(`úloha ${id} nemá komentár s riadkom "Mockup schválený:" od iného autora ako ${DESIGNER}`);
  return problems;
}

// Odsek tela úlohy webu podľa voľby brány. Chyba = výnimka s dôvodom.
export function mockupParagraph(o, show = loadTask) {
  const hasMockup = o.mockup !== undefined;
  const hasReason = o["bez-mockupu"] !== undefined;
  if (hasMockup === hasReason) {
    throw new Error(hasMockup ? "--mockup a --bez-mockupu naraz nejde, zvoľ jednu" : 'chýba --mockup <id úlohy dizajnéra> alebo --bez-mockupu "<dôvod>"');
  }
  if (hasReason) {
    const reason = String(o["bez-mockupu"]).trim();
    if (reason.length < MIN_REASON) throw new Error(`dôvod v --bez-mockupu má mať aspoň ${MIN_REASON} znakov`);
    return `Bez mockupu: ${reason}`;
  }
  if (!/^\d+$/.test(String(o.mockup))) throw new Error(`--mockup chce číslo úlohy, nie "${o.mockup}"`);
  const problems = mockupProblems(o.mockup, show);
  if (problems.length) throw new Error(`mockup ${o.mockup} nevyhovuje bráne: ${problems.join("; ")}`);
  return (
    `Implementuj podľa mockupu z úlohy ${o.mockup} (cesta je v jej komentároch). ` +
    `V kontrolnom komentári pred done daj snímky svojej implementácie pri 1440 a 390 px vedľa snímok mockupu ` +
    `a výstup \`browser.sh --gaps\`, odchýlku od mockupu zdôvodni.`
  );
}

// Založí úlohu webu. `run(args)` spustí tasker a vráti výstup, `show(id)` načíta úlohu.
export function createWebTask(o, { agents, run = tasker, show = loadTask } = {}) {
  if (!isWebAgent(o.assign, agents)) throw new Error(`--assign ${o.assign} nie je agent webu (meno alebo workdir končí na -web)`);
  const paragraph = mockupParagraph(o, show);
  const opt = (k) => (o[k] === undefined ? [] : [`--${k}`, o[k]]);
  const id = Number(JSON.parse(run(["task", "add", "--title", o.title, "--body", `${o.body}\n\n${paragraph}\n\n${MANUAL_PARAGRAPH}`, "--assign", o.assign, "--project", o.project, ...opt("parent"), ...opt("verify"), ...opt("model"), ...opt("max-runs"), "--json"])).id);
  if (!Number.isInteger(id)) throw new Error("Tasker nevrátil id úlohy");
  return { w: id };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [mode, ...rest] = process.argv.slice(2);
  try {
    if (mode === "create") {
      const o = parseCreateArgs(rest);
      const { w } = createWebTask(o, { agents: loadAgents() });
      console.log(`úloha webu: ${w}`);
    } else {
      throw new Error("použitie: web_gate.mjs create");
    }
  } catch (e) {
    console.error(`chyba: ${e.message}`);
    process.exit(2);
  }
}
