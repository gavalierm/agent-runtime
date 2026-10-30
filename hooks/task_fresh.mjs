#!/usr/bin/env node
// requires: tasker
// task_fresh.mjs — relácia pracuje podľa záznamov úlohy, ktoré ešte nečítala (úloha 690).
// Chyba 30. 10. 2026, úloha 689: správca servera v hlavnom vlákne prečítal úlohu o 19:28,
// správca agentov o 19:30 zapísal komentár so schválenou cestou A, beh komentár nevidel
// a o 19:35 nasadil cestu B (sudo). Beh číta úlohu len na štarte, Tasker komentár
// bežiacemu behu nedoručí a správa zo schránky čaká na ďalšie zobudenie. repeat_guard.mjs
// ani task_concurrency.mjs čas komentára nečítajú.
//
// Pravidlo: global §6 (RULES.md, "Autonomy"): práca ide podľa aktuálnej úlohy, nie podľa jej
// stavu zo štartu; README, časť "Hooky relácie".
//
// PreToolUse pre Bash. Aktuálna úloha relácie N je TASKER_TASK_ID (beh Taskera), inak pole
// `n` súboru tasker_work_current/<relácia> (hook tasker_work.mjs), bez nej hook skončí
// kódom 0 bez volania tk. Značka relácie
// ${XDG_CACHE_HOME:-$HOME/.cache}/agentic-workflow/task_fresh/<relácia> nesie JSON
// { n, seenAt, checkedAt }: seenAt je čas (ms) záznamov úlohy, ktoré relácia videla (bez
// značky pole `at` zo súboru current, v behu Taskera teraz), checkedAt posledné volanie tk.
//  - Príkaz, ktorý číta úlohu N (`tk task show N`): prejde a seenAt je teraz.
//  - Inak `tk task show N --json`: nové komentáre (created_at > seenAt, autor iný než agent)
//    a zmeny stavu (kind status, at > seenAt, aktér iný než agent). Necitlivý príkaz
//    volá tk najviac raz za 20 s a prejde s additionalContext so záznamami (seenAt sa posunie),
//    citlivý príkaz (SENSITIVE) volá tk vždy a pri nových záznamoch sa zamietne, seenAt
//    sa pri zamietnutí nemení, posunie ho až `task show`.
//  - Zlyhanie tk, neplatný JSON alebo chýbajúce polia: kód 0 bez výstupu (fail open).
//  - Príkazy `tk` a `tasker` nikdy nie sú citlivé.
// Test podstrčí tk premennou TASKER_WORK_CMD (rovnako ako tasker_work.mjs), HOME a
// XDG_CACHE_HOME v tmp, živý Tasker sa nevolá.

import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { denyTool } from "../lib/deny.mjs";
import { commands, taskerCommands } from "./web_review.mjs";
import { agentName, tk, currentFile } from "./tasker_work.mjs";

const THROTTLE_MS = 20_000;
const BODY_MAX = 600;
const LINES_MAX = 8;

// Citlivé príkazy: [názov, regex]. Dopĺňaj tu. Regex sa skúša na každom jednoduchom príkaze
// z rozkladu (`;`, `&&`, `||`, `|`, nový riadok, `sudo`, `runuser -u X --`, `sh -c '...'`;
// text v heredoci sa nerozkladá) s prvým slovom ako basename, a na riadku "write <cieľ>"
// pre každý cieľ zápisu (presmerovanie `>`/`>>`, `tee`, `cp`, `mv`, `install`, `ln`, `sed -i`,
// `chmod`, `chown`, `rm`, `mkdir`, `touch`). Cieľ s premennou alebo `$(...)` sa nedá určiť, prejde.
export const SENSITIVE = [
  ["apt/dpkg install, remove, purge", /^(?:apt|apt-get|dpkg)\s+(?:-\S+\s+)*(?:install|remove|purge|-i|--install|--remove|--purge)(?:\s|$)/],
  ["pip install", /^(?:pip3?|python3?\s+-m\s+pip)\s+(?:-\S+\s+)*install(?:\s|$)/],
  ["npm install -g", /^npm\s+(?=.*\s(?:-g|--global)(?:\s|$))(?:\S+\s+)*?(?:install|i|add)(?:\s|$)/],
  ["systemctl zmena služby", /^systemctl\s+(?:-\S+\s+)*(?:enable|disable|start|stop|restart|mask|unmask|daemon-reload)(?:\s|$)/],
  ["účty a prístupy", /^(?:useradd|usermod|userdel|groupadd|visudo|ssh-copy-id)(?:\s|$)/],
  ["skript install, deploy, setup", /^(?:(?:bash|sh|zsh|dash|source|\.)\s+(?:-\S+\s+)*)?(?:\S*\/)?(?:install|deploy|setup)[^\s/]*\.sh(?:\s|$)/],
  ["zápis do /etc, /usr/local, /var/lib, authorized_keys", /^write (?:\/etc\/|\/usr\/local\/|\/var\/lib\/|(?:\S*\/)?authorized_keys$)/],
];

const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const PREFIX = new Set(["!", "{", "}", "if", "then", "else", "elif", "do", "while", "until", "time", "nohup", "exec", "command", "nice"]);
const SUDO_VALUE = new Set(["-u", "-g", "-h", "-p", "-C", "-r", "-t", "-U", "-D", "-R"]);
const RUNUSER_VALUE = new Set(["-u", "-l", "-g", "-G", "-s", "-w"]);

// Jednoduché príkazy z `raw` bez obalov: [slová]. Prvé slovo je program.
export function simpleCommands(raw, depth = 0) {
  const out = [];
  for (let words of commands(raw)) {
    for (let guard = 0; guard < 20 && words.length; guard++) {
      const w = words[0];
      const prog = basename(w);
      if (/^[A-Za-z_]\w*=/.test(w) || PREFIX.has(w)) words = words.slice(1);
      else if (prog === "env") {
        let i = 1;
        while (i < words.length && (/^[A-Za-z_]\w*=/.test(words[i]) || words[i].startsWith("-"))) i += words[i] === "-u" ? 2 : 1;
        words = words.slice(i);
      } else if (prog === "timeout") {
        let i = 1;
        while (i < words.length && words[i].startsWith("-")) i++;
        words = words.slice(i + 1);
      } else if (prog === "sudo" || prog === "doas") {
        let i = 1;
        while (i < words.length && words[i].startsWith("-")) i += SUDO_VALUE.has(words[i]) ? 2 : 1;
        words = words.slice(i);
      } else if (prog === "runuser" || prog === "su") {
        const c = words.indexOf("-c");
        if (c >= 0 && words[c + 1] !== undefined) {
          if (depth < 3) out.push(...simpleCommands(words[c + 1], depth + 1));
          words = [];
          break;
        }
        let i = 1;
        while (i < words.length && words[i] !== "--") {
          if (words[i] === "-") i++;
          else if (words[i].startsWith("-")) i += RUNUSER_VALUE.has(words[i]) ? 2 : 1;
          else { if (prog === "su") i++; break; }
        }
        if (words[i] === "--") i++;
        words = words.slice(i);
      } else if (SHELLS.has(prog)) {
        const c = words.findIndex((x) => /^-[a-z]*c$/.test(x));
        if (c >= 0 && words[c + 1] !== undefined) {
          if (depth < 3) out.push(...simpleCommands(words[c + 1], depth + 1));
          words = [];
        }
        break;
      } else break;
    }
    if (words.length) out.push(words);
  }
  return out;
}

const isTk = (words) => ["tk", "tasker"].includes(basename(words[0]));

// Cieľ zápisu je určiteľný: bez premennej, `$(...)` a spätného apostrofu.
const known = (t) => typeof t === "string" && t !== "" && !/[$`]/.test(t);

// Ciele zápisu jednoduchého príkazu.
export function writeTargets(words) {
  const targets = [];
  const args = [];
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    let m;
    if (/^\d*>>?$/.test(w)) { if (known(words[i + 1])) targets.push(words[i + 1]); i++; }
    else if ((m = w.match(/^\d*>>?([^&>].*)$/))) { if (known(m[1])) targets.push(m[1]); }
    else args.push(w);
  }
  const prog = basename(words[0]);
  const flags = args.filter((a) => a.startsWith("-"));
  const pos = args.filter((a) => !a.startsWith("-"));
  if (prog === "tee" || prog === "rm" || prog === "mkdir" || prog === "touch") targets.push(...pos);
  else if (prog === "chmod" || prog === "chown") targets.push(...pos.slice(1));
  else if (prog === "install" && flags.includes("-d")) targets.push(...pos);
  else if (["cp", "mv", "install", "ln"].includes(prog)) {
    const t = args.findIndex((a) => a === "-t" || a.startsWith("--target-directory"));
    if (t >= 0) targets.push(args[t].includes("=") ? args[t].split("=")[1] : args[t + 1]);
    else if (pos.length >= 2) targets.push(pos[pos.length - 1]);
  } else if (prog === "sed" && flags.some((f) => /^-[A-Za-z]*i/.test(f) || f.startsWith("--in-place"))) {
    targets.push(...(flags.some((f) => /^-[A-Za-z]*[ef]/.test(f) || /^--(expression|file)/.test(f)) ? pos : pos.slice(1)));
  }
  return targets.filter(known);
}

// Názov prvého citlivého pravidla, ktoré zasiahne príkaz, alebo null. `tk` a `tasker` nikdy.
export function sensitiveName(raw) {
  for (const words of simpleCommands(raw)) {
    if (isTk(words)) continue;
    const probes = [[basename(words[0]), ...words.slice(1)].join(" "), ...writeTargets(words).map((t) => `write ${t}`)];
    for (const [name, re] of SENSITIVE) if (probes.some((p) => re.test(p))) return name;
  }
  return null;
}

// Čas záznamu v ms: číslo (ms, pri malom čísle sekundy) alebo text ISO.
export function toMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v < 1e11 ? v * 1000 : v;
  const t = Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? t : NaN;
}

const clip = (s) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > BODY_MAX ? `${t.slice(0, BODY_MAX)}…` : t;
};

// Nové záznamy úlohy po seenAt: [{ t, line }] v poradí času. Neplatný tvar hodí chybu.
export function newRecords(task, agent, seenAt) {
  if (!Array.isArray(task.comments) || !Array.isArray(task.events)) throw new Error("tvar úlohy");
  const own = (who) => { const x = String(who ?? "").toLowerCase(); return x === agent || x.endsWith(`:${agent}`); };
  const out = [];
  for (const c of task.comments) {
    const t = toMs(c.created_at);
    if (!(t > seenAt) || own(c.author)) continue;
    out.push({ t, line: `${new Date(t).toISOString()} komentár ${c.author}: ${clip(c.body)}` });
  }
  for (const e of task.events) {
    const t = toMs(e.at);
    if (e.kind !== "status" || !(t > seenAt) || own(e.actor)) continue;
    out.push({ t, line: `${new Date(t).toISOString()} stav ${e.from_status} -> ${e.to_status} (${e.actor})` });
  }
  return out.sort((a, b) => a.t - b.t);
}

// Riadky záznamov: najviac LINES_MAX najnovších, zvyšok jedným riadkom.
function listing(n, recs) {
  const shown = recs.slice(-LINES_MAX).map((r) => r.line);
  const rest = recs.length - shown.length;
  if (rest > 0) shown.push(`a ešte ${rest} starších, pozri \`tk task show ${n} --json\``);
  return shown.join("\n");
}

const safeId = (s) => String(s).replace(/[^\w-]/g, "_");
const markerFile = (session, env) =>
  join(env.XDG_CACHE_HOME || join(env.HOME || homedir(), ".cache"), "agentic-workflow", "task_fresh", safeId(session));

function save(file, value) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(value));
    renameSync(`${file}.tmp`, file);
  } catch {}
}

const readJson = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; } };

// Aktuálna úloha relácie: { n, at } alebo null.
function currentTask(input, env) {
  const e = Number(env.TASKER_TASK_ID);
  if (Number.isInteger(e) && e > 0) return { n: e, at: null };
  if (!input.session_id) return null;
  const cur = readJson(currentFile(input.session_id, env));
  return cur && Number.isInteger(cur.n) && cur.n > 0 ? { n: cur.n, at: Number.isFinite(cur.at) ? cur.at : null } : null;
}

// Číta príkaz úlohu n (`tk task show n`)?
const readsTask = (raw, n) =>
  taskerCommands(raw).some(({ rest }) => rest[0] === "task" && rest[1] === "show" && rest.slice(2).find((w) => !w.startsWith("-")) === String(n));

// Rozhodnutie hooku: null (prejde bez výstupu), alebo { deny: [dôvod, postup] }, alebo { context }.
export function decide(input, env = process.env, now = Date.now()) {
  const raw = String((input.tool_input || {}).command || "");
  const cur = currentTask(input, env);
  if (!cur || !input.session_id) return null;
  const agent = (agentName(input, env) || env.TASKER_USER || "").toLowerCase();
  if (!agent) return null;
  const { n } = cur;
  const file = markerFile(input.session_id, env);
  let m = readJson(file);
  if (!m || m.n !== n || !Number.isFinite(m.seenAt)) m = { n, seenAt: cur.at ?? now, checkedAt: 0 };
  const sensitive = sensitiveName(raw);
  if (!sensitive && readsTask(raw, n)) {
    save(file, { ...m, seenAt: now });
    return null;
  }
  if (!sensitive && now - (m.checkedAt || 0) < THROTTLE_MS) {
    save(file, m);
    return null;
  }
  m.checkedAt = now;
  let recs = [];
  try {
    recs = newRecords(JSON.parse(tk(agent, ["task", "show", String(n), "--json"], env)), agent, m.seenAt);
  } catch {
    recs = [];
  }
  if (!recs.length) {
    save(file, m);
    return null;
  }
  const head = `Úloha ${n} má záznamy, ktoré táto relácia nečítala:\n${listing(n, recs)}`;
  if (sensitive) {
    save(file, m);
    return {
      deny: [
        `${head}\nPríkaz je citlivý (${sensitive}) a záznamy ho môžu meniť.`,
        `prečítaj úlohu \`tk task show ${n} --json\` a príkaz spusť znova, keď záznamy neprikazujú inak.`,
      ],
    };
  }
  m.seenAt = Math.max(...recs.map((r) => r.t));
  save(file, m);
  return { context: `${head}\nKonaj podľa nich, nie podľa stavu úlohy zo štartu.` };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  if (input.tool_name !== "Bash") process.exit(0);
  let r = null;
  try {
    r = decide(input);
  } catch {}
  if (r?.deny) denyTool(...r.deny);
  else if (r?.context) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: r.context } }));
  process.exit(0);
}
