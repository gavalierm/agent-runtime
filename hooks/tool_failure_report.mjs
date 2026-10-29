#!/usr/bin/env node
// tool_failure_report.mjs — zlyhaný spoločný nástroj agent nahlási vlastníkovi
// úlohou ten istý ťah (global/CLAUDE.md §4, D0177). Chyba 25. 10. 2026: agent
// v behu pod používateľom správcu úloh spustil browser.sh z klonu kódu, ten skončil
// kódom 2 ("spúšťa sa pod rootom"), agent ho obišiel kópiou browser.mjs a chybu
// len spomenul v komentári.
//
// Stop a SubagentStop. Hook prejde prepis relácie (SubagentStop prepis
// sub-agenta `agent_transcript_path`, Stop hlavný `transcript_path` bez
// vlákien sub-agentov) od poslednej skutočnej správy a hľadá príkaz Bash,
// ktorý spustil program z klonu kódu (workflowDir), spoločného mozgu
// (brainGlobalDir) alebo z /opt/tasker/ a skončil kódom nad 0. Ak po poslednom takom zlyhaní nebeží
// hlásenie (`tk task add`, `tasker task add`, `ask_agent.sh`, a skončilo
// úspešne), zastaví ukončenie (decision block). Pri `stop_hook_active` mlčí,
// aby nezacyklil.
//
// Prepis, nie stav po PostToolUseFailure: Claude Code doručí Bash s kódom
// nad 0 hooku PostToolUseFailure (pole `error` s prvým riadkom "Exit code N",
// code.claude.com/docs/en/hooks), kým PostToolUse len úspešný. Stop dostane
// prepis, v ňom je zlyhanie aj hlásenie, takže nepotrebuje súbor stavu, ktorý
// by pri súbehu vlákien a behov pod rôznymi používateľmi musel niekto čistiť.
//
// Kód skončenia patrí poslednému vykonanému úseku príkazu (`codeSegments`):
// pri `;` je to posledný úsek, pri `&&` ktorýkoľvek, za `||` a pred rúrou nie.
// V reťazci `&&` rozhodne výstup (`failedInstead`): keď nesie podpis iného úseku
// reťazca (git `error:`/`fatal:`, `cat: x: No such file`, stopa node alebo python)
// a nie podpis nástroja, kód patrí tomu úseku a nástroj nebežal alebo prešiel.
// Chyba 26. 10. 2026 (úloha 611): `git commit -- <nový súbor> && ... && kontext.sh`
// skončil kódom 1 s "error: pathspec", hook hlásil kontext.sh, ktorý sa nespustil.
//
// Nepočíta sa: `tk` a `tasker` (zlyhanie je zvyčajne chybný vstup agenta),
// výsledok s riadkom "Správny postup:" (spoločné nástroje tak hlásia chybný vstup
// volajúceho: tk, reply.sh, deny.sh; úloha 608), kód interpretov, ktoré nie sú shell
// (`python3 -c "..."`, `node -e "..."`, `perl -e`, `ruby -e`): jeho text sa nedelí na
// príkazy, inak `sys.stdin` po `cd` do spoločného priečinka vyzeral ako skript
// (úloha 608), testy (`--test`, `*.test.*`, `check.mjs`), čítanie súborov (`cat`, `grep`,
// `ls`, `git -C` nie sú spustený nástroj), hľadanie a syntax (`command -v`,
// `bash -n`, `node --check`) a signál TERM/KILL (kód 137, 143, 144) v príkaze
// s `kill`, `pkill` alebo `killall`: príkaz zabil sám seba alebo svoj shell
// (chyba 25. 10. 2026, úloha 593: `pkill -f "serve --port N"` zabil vlastný
// shell, hook pripísal kód 144 browser.sh, ktorý v tom príkaze skončil kódom 0).

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { blockStop } from "../lib/deny.mjs";
import { brainGlobalDir, workflowDir } from "../lib/paths.mjs";
import { stripHeredocs, stripQuoted } from "./no_model_wait.mjs";

// Spoločné nástroje: cesta a vlastník (rola z roles/agents.md).
export const SHARED = [
  { prefix: `${workflowDir()}/`, owner: "správca agentov", project: "agenti" },
  { prefix: `${brainGlobalDir()}/`, owner: "správca agentov", project: "agenti" },
  { prefix: "/opt/tasker/", owner: "vedúci vývoja (kód Taskera)", project: "tasker" },
];

// Slová, za ktorými príkaz beží ďalej.
const WRAPPERS = new Set([
  "env", "time", "nohup", "exec", "command", "nice", "timeout", "sudo", "runuser", "su",
  "bash", "sh", "dash", "zsh", "node", "python", "python3", "xvfb-run", "setsid", "stdbuf", "!", "{", "if", "then", "else", "do",
]);
const NOT_A_TOOL = new Set(["tk", "tasker"]);
const TESTISH = /\.test\.|(^|\/)tests?(\/|$)|(^|\/)test[_-][^/]*$|(^|\/)check\.mjs$/;

function tokens(seg) {
  return seg.trim().split(/\s+/).filter(Boolean);
}

// Index prvého tokenu, ktorý nie je priradenie, predpona ani voľba.
function headIndex(t) {
  let i = 0;
  while (i < t.length) {
    const x = t[i];
    if (/^[A-Za-z_]\w*=/.test(x) || WRAPPERS.has(x) || /^\d+[smhd]?$/.test(x) || x === "--") i++;
    else if (x.startsWith("-")) i += x === "-u" || x === "-g" || x === "-c" ? 2 : 1;
    else break;
  }
  return i;
}

// Citovaný kód interpretu, ktorý nie je shell (`python3 -c "..."`, `node -e '...'`).
const FOREIGN_CODE = /(\b(?:python3?|node|perl|ruby)\b(?:\s+-[^\s'"]+)*?\s+(?:-c|-e|-p|-pe|-ne|--eval|--print))\s*(?:'[^']*'|"(?:[^"\\]|\\.)*")/g;

function flatten(command) {
  const plain = stripHeredocs(String(command || "")).replace(FOREIGN_CODE, "$1 ''");
  return stripQuoted(plain).replace(/\b(?:ba|da|z)?sh\s+(?:-\S+\s+)*?-\w*c\s+['"]/g, "");
}

function segments(command) {
  return flatten(command).split(/[;&|\n`()]+/).map((s) => s.trim()).filter(Boolean);
}

const COMPOUND = /^(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|\{|\})$/;

// Úseky príkazu a či im môže patriť kód skončenia Bashu (úloha 593): kód patrí
// poslednému vykonanému úseku. Pri `;` a novom riadku je to posledný úsek najvyššej
// úrovne, pri `&&` ktorýkoľvek úsek reťazca, pri `||` len úsek za posledným `||`
// (chyba pred ním je ošetrená), pri rúre posledný príkaz rúry (`pipefail` sa nerieši).
// Zložený príkaz (if, for, podshell, `$(...)`) sa nerozlišuje, kód môže patriť komukoľvek.
export function codeSegments(command) {
  const flat = flatten(command);
  const all = (list) => list.split(/[;&|\n`()]+/).map((x) => x.trim()).filter(Boolean).map((seg) => ({ seg, last: true, item: 0 }));
  if (/[`()]|\$\{/.test(flat)) return all(flat);
  const items = flat.replace(/\d*[<>]&\d*-?|&>>?/g, " ").split(/[;\n]+/).map((x) => x.trim()).filter(Boolean);
  if (items.some((it) => COMPOUND.test(it.split(/\s+/)[0]))) return all(flat);
  const out = [];
  items.forEach((item, idx) => {
    const parts = item.split(/(&&|\|\||\||&)/);
    const lastOr = parts.lastIndexOf("||");
    for (let i = 0; i < parts.length; i += 2) {
      const seg = parts[i].trim();
      if (!seg) continue;
      const next = parts[i + 1];
      out.push({ seg, last: idx === items.length - 1 && i > lastOr && (next === undefined || next === "&&"), item: idx });
    }
  });
  return out;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Podpis programu vo výstupe: `<meno>: ...` na začiatku riadka (coreutils, bash pri
// "command not found"), git `error:`/`fatal:`, python Traceback alebo `File "x.py"`,
// node stopa `at ... (x.mjs:3:1)`, npm `npm ERR!`.
export function signature(head) {
  const name = basename(head);
  if (name === "git") return /^(?:error|fatal): /m;
  if (/^python3?$/.test(name)) return /^Traceback \(most recent call last\)|^python3?: /m;
  if (name === "npm") return /^npm (?:ERR!|error) /m;
  const n = escapeRe(name);
  return new RegExp(`^(?:\\S*sh: (?:line \\d+: )?)?${n}: |[\\s(/]${n}:\\d+|^\\s*File "[^"]*${n}"`, "m");
}

// Kód skončenia reťazca `&&` patrí inému úseku než nástroju: výstup nesie podpis
// iného úseku reťazca a nie podpis nástroja.
export function failedInstead(tool, heads, output) {
  if (!output || !heads.length) return false;
  if (signature(tool).test(output)) return false;
  return heads.some((h) => signature(h).test(output));
}

// `command -v x`, `bash -n x`, `node --check x`: meno nástroja je argument, nespúšťa sa.
function lookupOnly(t) {
  const w = t.find((x) => !/^[A-Za-z_]\w*=/.test(x));
  const rest = t.slice(t.indexOf(w) + 1);
  if (w === "command") return rest.some((x) => /^-[vV]$/.test(x));
  if (["bash", "sh", "dash", "zsh"].includes(w)) return rest.some((x) => /^-\w*n\w*$/.test(x));
  if (w === "node") return rest.some((x) => x === "--check" || x === "-c");
  return false;
}

const KILLERS = new Set(["kill", "pkill", "killall"]);
const SIGNAL_CODES = new Set([137, 143, 144]);

// Príkaz s `kill`, `pkill` alebo `killall` ako spusteným príkazom v niektorom úseku.
export function killsProcesses(command) {
  return segments(command).some((seg) => {
    const t = tokens(seg);
    return KILLERS.has(basename(t[headIndex(t)] || ""));
  });
}

// Spoločný nástroj, ktorý príkaz spúšťa: { prefix, owner, project, tool } alebo null.
// `output` je výstup príkazu: v reťazci `&&` rozhodne, či kód patrí inému úseku.
export function sharedTool(command, output = "") {
  let cwd = null;
  const vars = new Map();
  const segs = codeSegments(command);
  const heads = segs.map(({ seg }) => {
    const t = tokens(seg);
    if (t[0] === "cd" || t.every((x) => /^[A-Za-z_]\w*=/.test(x) || x === "export")) return "";
    return t[headIndex(t)] || "";
  });
  segs.forEach((s, i) => {
    const ref = /^\$(?:(\w+)|\{(\w+)\})$/.exec(heads[i]);
    const t = tokens(s.seg);
    const assigns = t[0] === "export" ? t.slice(1) : t;
    if (assigns.length && assigns.every((x) => /^[A-Za-z_]\w*=/.test(x))) {
      for (const x of assigns) vars.set(x.slice(0, x.indexOf("=")), x.slice(x.indexOf("=") + 1));
    }
    if (ref && vars.has(ref[1] || ref[2])) heads[i] = vars.get(ref[1] || ref[2]);
  });
  vars.clear();
  for (const [i, { seg, last, item }] of segs.entries()) {
    const t = tokens(seg);
    const assigns = t[0] === "export" ? t.slice(1) : t;
    if (assigns.length && assigns.every((x) => /^[A-Za-z_]\w*=/.test(x))) continue;
    if (t[0] === "cd" && t[1]) {
      cwd = SHARED.find((s) => (t[1].replace(/\/*$/, "") + "/").startsWith(s.prefix)) || null;
      continue;
    }
    if (t.some((x) => x === "--test" || x.startsWith("--test="))) continue;
    if (lookupOnly(t)) continue;
    const head = heads[i];
    if (!head || TESTISH.test(head) || NOT_A_TOOL.has(basename(head))) continue;
    let hit = SHARED.find((s) => head.startsWith(s.prefix));
    // Relatívna cesta po `cd <spoločný priečinok>`: `./browser.sh`, `bash browser.sh`.
    if (!hit && cwd && !head.startsWith("/") && /[./]/.test(head) && !/^[\w-]+$/.test(head)) hit = cwd;
    if (!hit || !last) continue;
    // Ostatné vykonateľné úseky toho istého reťazca `&&`: ich podpis vo výstupe
    // znamená, že kód je ich (úloha 611).
    const others = segs.map((s, j) => (j !== i && s.item === item && s.last ? heads[j] : "")).filter(Boolean);
    if (failedInstead(head, others, output)) continue;
    return { ...hit, tool: head };
  }
  return null;
}

// Príkaz je hlásenie: `tk task add`, `tasker task add` alebo `ask_agent.sh` (nie `--replies`).
export function isReport(command) {
  for (const seg of segments(command)) {
    const t = tokens(seg);
    const i = headIndex(t);
    const name = basename(t[i] || "");
    if ((name === "tk" || name === "tasker") && t[i + 1] === "task" && t[i + 2] === "add") return true;
    if (name === "ask_agent.sh" && !t.includes("--replies")) return true;
  }
  return false;
}

function textOf(c) {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c.map((b) => (typeof b === "string" ? b : b?.type === "text" ? b.text : "")).join("\n");
}

// Posledné zlyhanie spoločného nástroja v ťahu bez hlásenia po ňom, inak null.
// `entries` sú riadky prepisu, `sidechain` true pre prepis sub-agenta.
export function unreported(entries, { sidechain = false } = {}) {
  const cmds = new Map();
  let pos = 0;
  let fail = null;
  let report = -1;
  for (const e of entries) {
    if (!sidechain && e?.isSidechain) continue;
    const c = e?.message?.content;
    if (e?.type === "user" && !e.isMeta && (typeof c === "string" || (Array.isArray(c) && c.some((b) => b?.type === "text")))) {
      if (!sidechain) {
        cmds.clear();
        fail = null;
        report = -1;
      }
      continue;
    }
    if (e?.type === "assistant" && Array.isArray(c)) {
      for (const b of c) if (b?.type === "tool_use" && b.name === "Bash") cmds.set(b.id, String(b.input?.command || ""));
    } else if (e?.type === "user" && Array.isArray(c)) {
      for (const b of c) {
        if (b?.type !== "tool_result" || !cmds.has(b.tool_use_id)) continue;
        const cmd = cmds.get(b.tool_use_id);
        const out = textOf(b.content);
        pos++;
        if (b.is_error) {
          const m = /^Exit code (\d+)/.exec(out);
          const code = m ? Number(m[1]) : 0;
          const callerError = /^\s*Správny postup:/m.test(out);
          const tool = code > 0 && !callerError && !(SIGNAL_CODES.has(code) && killsProcesses(cmd)) ? sharedTool(cmd, out) : null;
          if (tool) fail = { ...tool, pos, code: m[1], command: cmd, output: out.split("\n").slice(1).filter((l) => l.trim()).pop() || "" };
        } else if (isReport(cmd)) {
          report = pos;
        }
      }
    }
  }
  return fail && report < fail.pos ? fail : null;
}

export function message(f) {
  const cmd = f.command.replace(/\s+/g, " ").slice(0, 160);
  return `Spoločný nástroj ${f.tool} zlyhal (kód ${f.code}${f.output ? `, "${f.output.slice(0, 140)}"` : ""}) v príkaze \`${cmd}\` `
    + `a po ňom nebeží hlásenie. Vlastník je ${f.owner}, hlásiš mu úlohu v projekte ${f.project} aj vtedy, keď si chybu obišiel (global §4).`;
}

export function postup(f, uid = process.getuid?.()) {
  const add = uid === 0 ? `AGENT_NAME=<tvoje meno> ${workflowDir()}/bin/tk task add` : "tasker task add";
  return `\`${add} --project ${f.project} --assign <agent s rolou "${f.owner}" z roles/agents.md> --title "<nástroj>: <čo zlyhalo>" `
    + `--body "<príkaz, kód, výstup, čo si urobil namiesto toho>" --verify "<príkaz, ktorý po oprave prejde>"\`; `
    + `súrne aj \`${workflowDir()}/bin/ask_agent.sh <agent> <téma>\`. Úlohu založ pred ukončením ťahu.`;
}

export function readEntries(path) {
  const out = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  if (input.stop_hook_active) process.exit(0);
  const sub = input.hook_event_name === "SubagentStop";
  const path = sub ? input.agent_transcript_path : input.transcript_path;
  if (!path) process.exit(0);
  let f;
  try { f = unreported(readEntries(path), { sidechain: sub }); } catch { process.exit(0); }
  if (f) blockStop(message(f), postup(f));
}
