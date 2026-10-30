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
// z rozkladu (`;`, `&&`, `||`, `|`, nový riadok, `sudo`, `runuser -u X --`, `sh -c '...'`,
// `env`, `timeout`, `nice`, `xargs`, `find -exec`; text v heredoci sa nerozkladá) s prvým
// slovom ako basename, a na riadku "write <cieľ>" pre každý cieľ zápisu (presmerovanie
// `>`/`>>`, `tee`, `cp`, `mv`, `install`, `ln`, `sed -i`, `chmod`, `chown`, `chgrp`, `rm`,
// `mkdir`, `touch`, `truncate`, `chattr`, `ssh-keygen -f`, `openssl -out`, `dd of=`, `rsync`, `tar -C`, `unzip -d`, `find -delete`).
// Cieľ s premennou alebo `$(...)` sa nedá určiť, prejde. Čisto čítacie tvary (`ufw status`,
// `crontab -l`, `nft list`, `iptables -L`, `tailscale serve status`) nie sú citlivé.
// Inštalácia rúrou (`curl ... | sh`) sa posudzuje zvlášť v sensitiveName.
const APT_OPTS = String.raw`(?:-o\s+\S+\s+|-\S+\s+)*`;
const SYSTEMCTL_OPTS = String.raw`(?:(?:-[MHs]|--machine|--host|--signal)\s+\S+\s+|-\S+\s+)*`;
const DOCKER_OPTS = String.raw`(?:(?:-H|--host|--context|-c)\s+\S+\s+|-\S+\s+)*`;
const SCRIPT_PREFIX = "install|deploy|setup|upgrade|retire|create|firewall|write_usb|ssh_config";
export const SENSITIVE = [
  ["apt install, remove, upgrade", new RegExp(String.raw`^(?:apt|apt-get|aptitude)\s+${APT_OPTS}(?:install|remove|purge|upgrade|full-upgrade|dist-upgrade|safe-upgrade|autoremove|autopurge|reinstall|build-dep)(?:\s|$)`)],
  ["dpkg", /^dpkg\s+(?:\S+\s+)*?(?:-i|-r|-P|--install|--remove|--purge|--configure|--unpack|--set-selections)(?:\s|$)/],
  ["dpkg-reconfigure", /^dpkg-reconfigure(?:\s|$)/],
  ["pip install", /^(?:pip3?|python3?\s+-m\s+pip)\s+(?:-\S+\s+)*install(?:\s|$)/],
  ["npm install -g", /^npm\s+(?=.*\s(?:-g|--global)(?:\s|$))(?:\S+\s+)*?(?:install|i|add)(?:\s|$)/],
  ["snap, cargo, go, gem, make install", /^(?:snap\s+(?:-\S+\s+)*(?:install|remove|refresh)|cargo\s+(?:-\S+\s+)*install|go\s+install|gem\s+(?:-\S+\s+)*install|make\s+(?:\S+\s+)*?install)(?:\s|$)/],
  ["docker run, rm, pull, compose up, down", new RegExp(String.raw`^docker(?:-compose)?\s+${DOCKER_OPTS}(?:(?:compose\s+${DOCKER_OPTS})?(?:up|down)|run|rm|rmi|pull|stop|start|restart|kill|prune)(?:\s|$)`)],
  ["systemctl zmena služby", new RegExp(String.raw`^systemctl\s+${SYSTEMCTL_OPTS}(?:enable|reenable|disable|start|stop|restart|mask|unmask|daemon-reload|daemon-reexec|reload|force-reload|reload-or-restart|try-restart|try-reload-or-restart|kill|edit|set-property|preset|preset-all|revert|link|isolate|set-default|reboot|poweroff|halt|kexec)(?:\s|$)`)],
  ["reboot, shutdown", /^(?:reboot|shutdown|poweroff|halt|telinit)(?:\s|$)/],
  ["firewall ufw", /^ufw(?!\s+(?:-\S+\s+)*status(?:\s|$))(?:\s|$)/],
  ["firewall nft", /^nft(?!\s+(?:-\S+\s+)*list\b)(?:\s|$)/],
  ["firewall iptables", /^ip6?tables(?:-restore|-nft)?(?!.*\s-[nvx]*[LS][nvx]*(?:\s|$))(?:\s|$)/],
  ["ip zmena siete", /^ip\s+(?:-\S+\s+)*(?:addr|address|route|link|rule|neigh|netns|tunnel)\s+(?:\S+\s+)*?(?:add|del|delete|change|replace|set|flush)(?:\s|$)/],
  ["nmcli zmena siete", /^nmcli\s+(?:\S+\s+)*?(?:modify|up|down|add|delete)(?:\s|$)/],
  ["tailscale zmena", /^tailscale\s+(?:-\S+\s+)*(?:up|down|set|serve(?!\s+status\b)|funnel(?!\s+status\b)|login|logout|cert)(?:\s|$)/],
  ["sysctl -w", /^sysctl\s+(?:\S+\s+)*?(?:-w|--write|--system)(?:\s|$)/],
  ["účty a prístupy", /^(?:useradd|usermod|userdel|groupadd|groupdel|groupmod|adduser|deluser|addgroup|delgroup|chpasswd|gpasswd|visudo|ssh-copy-id)(?:\s|$)/],
  ["passwd, chage", /^(?:passwd(?!\s+(?:-\S+\s+)*-S\b)|chage(?!\s+(?:\S+\s+)*-l\b))(?:\s|$)/],
  ["loginctl linger", /^loginctl\s+(?:\S+\s+)*?(?:enable|disable)-linger(?:\s|$)/],
  ["crontab", /^crontab(?!.*\s-l(?:\s|$))(?:\s|$)/],
  ["systemd-run, at", /^(?:systemd-run|at)(?:\s|$)/],
  ["skript install, deploy, setup a pod.", new RegExp(String.raw`^(?:(?:bash|sh|zsh|dash|source|\.)\s+(?:-\S+\s+)*)?(?:\S*\/)?(?:${SCRIPT_PREFIX})[^\s/]*\.sh(?:\s|$)`)],
  ["zápis do /etc, /usr, /opt, /srv, /boot, /var/lib, cron, .ssh", /^write (?:\/(?:etc|usr|opt|srv|boot)\/|\/var\/lib\/|\/var\/spool\/cron\/|\/root\/\.ssh\/|\/home\/[^/]+\/\.ssh\/|(?:\S*\/)?authorized_keys$)/],
];

// Shell alebo interpret, ktorý za rúrou číta skript zo stdin (`curl ... | sh`).
const STDIN_SHELLS = new Set(["sh", "bash", "zsh", "dash", "python", "python3", "perl", "ruby", "node"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash"]);
const PREFIX = new Set(["!", "{", "}", "if", "then", "else", "elif", "do", "while", "until", "time", "nohup", "exec", "command"]);
const SUDO_LONG_VALUE = /^--(?:user|group|host|prompt|chdir|chroot|role|type|other-user|close-from|command-timeout)$/;
const RUNUSER_VALUE = new Set(["-u", "-l", "-g", "-G", "-s", "-w"]);
const XARGS_VALUE = /^(?:-[adEeILnPsSR]|--(?:arg-file|delimiter|max-args|max-procs|max-lines|replace|eof|max-chars|process-slot-var))$/;
const VAR = /^[A-Za-z_]\w*=/;

// Voľba sudo, ktorá berie hodnotu v nasledujúcom slove: `-u`, `-iu` (zlúčené voľby, hodnotu
// berie posledné písmeno), nie `-uroot` (hodnota je prilepená) ani `-i`.
const sudoTakesValue = (w) => {
  if (SUDO_LONG_VALUE.test(w)) return true;
  const m = w.match(/^-([A-Za-z]+)$/);
  return !!m && /[ugpCrtUDRh]/.test(m[1].slice(-1)) && !/[ugpCrtUDRh]/.test(m[1].slice(0, -1));
};

// Telá heredocov preč, zvyšok riadku s `<<` (presmerovanie, rúra) ostáva.
export const stripBodies = (text) => String(text ?? "").replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2\s*(?=\n|$)/g, "<<heredoc$3");

// Slová jedného príkazu bez obalov. Výsledné príkazy ukladá do `out`.
function expand(words, depth, out) {
  for (let guard = 0; guard < 20 && words.length; guard++) {
    const w = words[0];
    const prog = basename(w);
    if (VAR.test(w) || PREFIX.has(w)) words = words.slice(1);
    else if (prog === "env") {
      let i = 1;
      while (i < words.length && (VAR.test(words[i]) || words[i].startsWith("-"))) i += words[i] === "-u" ? 2 : 1;
      words = words.slice(i);
    } else if (prog === "timeout") {
      let i = 1;
      while (i < words.length && words[i].startsWith("-")) i += /^(?:-[sk]|--signal|--kill-after)$/.test(words[i]) ? 2 : 1;
      words = words.slice(i + 1);
    } else if (prog === "nice" || prog === "ionice") {
      let i = 1;
      while (i < words.length && words[i].startsWith("-")) i += /^(?:-[ncpP]|--adjustment|--class|--classdata)$/.test(words[i]) ? 2 : 1;
      words = words.slice(i);
    } else if (prog === "xargs") {
      let i = 1;
      while (i < words.length && words[i].startsWith("-")) i += XARGS_VALUE.test(words[i]) ? 2 : 1;
      words = words.slice(i);
    } else if (prog === "sudo" || prog === "doas") {
      let i = 1;
      while (i < words.length && words[i].startsWith("-")) i += sudoTakesValue(words[i]) ? 2 : 1;
      words = words.slice(i);
    } else if (prog === "runuser" || prog === "su") {
      const c = words.indexOf("-c");
      if (c >= 0 && words[c + 1] !== undefined) {
        if (depth < 3) out.push(...simpleCommands(words[c + 1], depth + 1));
        return;
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
        return;
      }
      break;
    } else if (prog === "find") {
      // `find ... -exec cmd ... ;` aj `+`: príkaz za -exec je samostatný príkaz.
      for (let i = 1; i < words.length; i++) {
        if (!/^-(?:exec|execdir|ok|okdir)$/.test(words[i])) continue;
        let j = i + 1;
        while (j < words.length && words[j] !== ";" && words[j] !== "+") j++;
        // `{}` je cesta nájdená v začiatočných cestách find, pre zápisový príkaz to sú tie cesty.
        const start = findStart(words.slice(1));
        const sub = words.slice(i + 1, j).flatMap((x) => (x === "{}" ? start : [x]));
        if (depth < 3) expand(sub, depth + 1, out);
        i = j;
      }
      break;
    } else break;
  }
  if (words.length) out.push(words);
}

// Jednoduché príkazy z `raw` bez obalov: [slová]. Prvé slovo je program.
export function simpleCommands(raw, depth = 0) {
  const out = [];
  for (const words of commands(stripBodies(raw))) expand(words, depth, out);
  return out;
}

const isTk = (words) => ["tk", "tasker"].includes(basename(words[0]));

// Cieľ zápisu je určiteľný: bez premennej, `$(...)` a spätného apostrofu.
const known = (t) => typeof t === "string" && t !== "" && !/[$`]/.test(t);

// Začiatočné cesty `find`: slová pred prvou voľbou alebo výrazom.
const findStart = (args) => {
  const i = args.findIndex((a) => a.startsWith("-") || a === "(" || a === "!");
  return i < 0 ? args : args.slice(0, i);
};

// Hodnota voľby: `-C dir`, `-Cdir`, `--directory dir`, `--directory=dir`.
function optValue(args, short, long) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === short || a === long) return args[i + 1];
    if (long && a.startsWith(`${long}=`)) return a.slice(long.length + 1);
    if (short && a.startsWith(short) && a.length > short.length && !a.startsWith("--") && short.length === 2 && /^-[A-Za-z]$/.test(short)) return a.slice(short.length);
  }
  return undefined;
}

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
  if (["tee", "rm", "mkdir", "touch", "truncate"].includes(prog)) targets.push(...pos);
  else if (prog === "chmod" || prog === "chown" || prog === "chgrp") targets.push(...pos.slice(1));
  else if (prog === "chattr") targets.push(...pos.filter((a) => !/^[+=][A-Za-z]+$/.test(a)));
  else if (prog === "ssh-keygen") {
    // `-f` je cieľ zápisu pri tvorbe kľúča, pri `-l`, `-y` a `-F` sa kľúč len číta.
    const f = optValue(args, "-f", null);
    if (f !== undefined && !flags.some((x) => ["-l", "-y", "-F"].includes(x))) targets.push(f);
  } else if (prog === "openssl") {
    for (const o of ["-out", "-keyout"]) {
      const v = optValue(args, o, null);
      if (v !== undefined) targets.push(v);
    }
  } else if (prog === "install" && flags.includes("-d")) targets.push(...pos);
  else if (["cp", "mv", "install", "ln"].includes(prog)) {
    const t = optValue(args, "-t", "--target-directory");
    if (t !== undefined) targets.push(t);
    else if (pos.length >= 2) targets.push(pos[pos.length - 1]);
  } else if (prog === "rsync") {
    if (pos.length >= 2) targets.push(pos[pos.length - 1]);
  } else if (prog === "dd") {
    for (const a of args) if (a.startsWith("of=")) targets.push(a.slice(3));
  } else if (prog === "tar") {
    const extract = args.slice(0, 3).some((a) => /^-?[A-Za-z]*[xru][A-Za-z]*$/.test(a)) || flags.some((f) => /^--(extract|get|append|update)$/.test(f));
    const dir = optValue(args, "-C", "--directory");
    if (extract && dir !== undefined) targets.push(dir);
  } else if (prog === "unzip") {
    const dir = optValue(args, "-d", null);
    if (dir !== undefined) targets.push(dir);
  } else if (prog === "find" && flags.includes("-delete")) {
    targets.push(...findStart(args));
  } else if (prog === "sed" && flags.some((f) => /^-[A-Za-z]*i/.test(f) || f.startsWith("--in-place"))) {
    targets.push(...(flags.some((f) => /^-[A-Za-z]*[ef]/.test(f) || /^--(expression|file)/.test(f)) ? pos : pos.slice(1)));
  }
  return targets.filter(known);
}

// Rozdelí text na príkazy podľa `;`, `&`, `|`, nového riadku mimo úvodzoviek: [{ pipe, text }].
// `pipe` je true pre príkaz hneď za jednoduchou rúrou (nie `||`).
function pipeSegments(text) {
  const out = [];
  let cur = "";
  let pipe = false;
  let q = null;
  const push = (nextPipe) => { if (cur.trim()) out.push({ pipe, text: cur }); cur = ""; pipe = nextPipe; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { cur += c; if (c === q) q = null; else if (c === "\\" && q === '"' && i + 1 < text.length) cur += text[++i]; continue; }
    if (c === "\\" && i + 1 < text.length) { cur += c + text[++i]; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === "|" && text[i + 1] === "|") { i++; push(false); continue; }
    if (c === "|") { push(true); continue; }
    if (c === "&" && (text[i - 1] === ">" || text[i - 1] === "<" || text[i + 1] === ">")) { cur += c; continue; }
    if (c === "&" && text[i + 1] === "&") { i++; push(false); continue; }
    if (c === ";" || c === "&" || c === "\n") { push(false); continue; }
    cur += c;
  }
  push(false);
  return out;
}

// Skript z rúry alebo zo substitúcie procesu: `curl ... | sh`, `| sudo bash`, `bash <(curl ...)`.
function installPipe(text) {
  if (/\b(?:sh|bash|zsh|dash)\s+(?:-\S+\s+)*(?:<\(|-c\s+["']?\$\()\s*(?:curl|wget)\b/.test(text)) return true;
  for (const seg of pipeSegments(text)) {
    if (!seg.pipe) continue;
    for (const words of simpleCommands(seg.text)) {
      if (!STDIN_SHELLS.has(basename(words[0]))) continue;
      const rest = words.slice(1);
      if (rest.includes("-c")) continue;
      if (rest.every((w) => w.startsWith("-")) || rest.includes("-s")) return true;
    }
  }
  return false;
}

// Názov prvého citlivého pravidla, ktoré zasiahne príkaz, alebo null. `tk` a `tasker` nikdy.
export function sensitiveName(raw) {
  for (const words of simpleCommands(raw)) {
    if (isTk(words)) continue;
    // Cieľ aj s lomkou na konci: `rm -r /etc` a `tar -C /etc` zasahujú celý priečinok.
    const probes = [[basename(words[0]), ...words.slice(1)].join(" "), ...writeTargets(words).flatMap((t) => [`write ${t}`, `write ${t}/`])];
    for (const [name, re] of SENSITIVE) if (probes.some((p) => re.test(p))) return name;
  }
  return installPipe(stripBodies(raw)) ? "skript z rúry (curl | sh)" : null;
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
