#!/usr/bin/env node
// requires: mac
// guard.mjs — územie agenta. PreToolUse hook pre Write, Edit, MultiEdit,
// NotebookEdit a Bash. Rozhoduje podľa toho, kde session začala
// (CLAUDE_PROJECT_DIR, nie aktuálne cwd, ktoré sa posúva s `cd`) a kam smeruje
// zápis. Je to zábrana, nie sandbox: číta cesty v tool_input a v texte
// príkazu, nie to, čo spustený skript urobí.
//
//   začiatok              voľne                              inak
//   projekt               pod cwd                            ask, aj /tmp
//   repo kódu             samo, ~/Work/agenti, konfigurácia  ask
//   (agentic-workflow)    agentov v ~/Work: CLAUDE.md,
//                         PERSONA.md, AGENTS.md, .claude/
//   ~/Work/agenti/<meno>  repo okrem persony, projekty       ask, aj persona
//                         z permissions.additionalDirectories
//   ~/Work/agenti         ~/Work/agenti/scratch              ask
//   ~/Work                ~/Work/scratch                     ask
//   mimo ~/Work           pod cwd                            ask
//
// Hook nikdy nevracia deny. Každý zápis mimo voľného územia ide operátorovi
// na potvrdenie, koncové zamietnutie by operátorovi nedalo cestu zmenu
// povoliť (rozhodnutie z 19. 10. 2026). V relácii bez
// operátora (claude -p) harness otázku zamietne sám.
//
// Správca agentov (roles/ROLES.md) spravuje konfiguráciu každého agenta bez
// súhlasu operátora, relácia v repe kódu ju zapisuje v jeho mene, zmena
// štruktúry ~/Work ide cez súhlas operátora. Agent s identitou nemení vlastnú
// personu, mení ju správca agentov (rozhodnutia z 14. a 18. 10. 2026). Persona sú PERSONA.md, CLAUDE.md, AGENTS.md,
// .claude/ a skills/ v repe agenta.
//
// Rola "rules" je len relácia v repe, ktoré nesie tento hook. Tam beží zábrana jednej relácie
// z .claude/settings.json repa. Relácia v ~/Work/agenti ju nemá, 14. 10. 2026
// tam stará relácia zapisovala popri novej, preto do repa agenta nezapíše
// nič (rozhodnutie zo 14. 10. 2026).
//
// V každej role je voľná aj vlastná pamäť harnessu,
// ~/.claude/projects/<začiatok s pomlčkami>/memory. Pamäť iného projektu nie.
//
// Pri allow mlčí (exit 0 bez JSON), aby nepreskočil ostatné pravidlá.
// Test: CLAUDE_PROJECT_DIR=/cesta node hooks/guard.mjs < vstup.json, vstup je
// JSON z PreToolUse (cwd, tool_name, tool_input).
//
// Platí bez reštartu: tento súbor harness spúšťa pri každom volaní, nič
// nekešuje. settings.json sa tiež načítava za behu — permissions.deny nasadený
// cez install.sh zablokoval Skill(...) v tej istej session (overené 2026-09-21).
// Docs (code.claude.com/docs/en/settings, 2026-09-21): „Claude Code watches your
// settings files and reloads them when they change, so it applies most edits to
// the running session without a restart" — sekciu hooks výslovne nemenuje.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const WORK = resolve(HOME, "Work");
const AGENTI = resolve(WORK, "agenti");
// Repo kódu je to, ktoré nesie tento hook. Meno a miesto priečinka sa
// môže zmeniť, hook pritom nesmie zamknúť vlastný presun.
const RULES = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLAUDE_HOME = resolve(HOME, ".claude");
const FREE = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);
// Pamäť, ktorú harness agentovi prideľuje. Názov priečinka je cesta začiatku
// session, v ktorej harness každý znak mimo písmen a číslic nahradil pomlčkou.
const memoryOf = (dir) => resolve(CLAUDE_HOME, "projects", dir.replace(/[^A-Za-z0-9]/g, "-"), "memory");

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

// Územie je priečinok, v ktorom session začala: CLAUDE_PROJECT_DIR, ktorý harness
// dáva hookom. input.cwd sa posúva s každým `cd` v Bash, preto slúži len ako
// základ pre relatívne cesty. Bez CLAUDE_PROJECT_DIR platí input.cwd.
const cwd = resolve(process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd());
const shell = resolve(input.cwd || cwd);
const tool = input.tool_name || "";
const ti = input.tool_input || {};
const role =
  cwd === RULES
    ? "rules"
    : cwd === AGENTI
      ? "agenti"
      : cwd.startsWith(AGENTI + sep) && !cwd.slice(AGENTI.length + 1).includes(sep)
      ? "agent"
      : cwd === WORK
        ? "root"
        : "project";

// Konfigurácia agenta: súbory, ktoré riadia jeho správanie.
const CONFIG = /\/(CLAUDE|PERSONA|AGENTS)\.md$|\/\.claude(\/|$)/;
const PERSONA = ["PERSONA.md", "CLAUDE.md", "AGENTS.md", ".claude", "skills"].map((n) => resolve(cwd, n));

// Projekty agenta s identitou. Rovnaký zoznam dáva spúšťač relácii cez --add-dir.
function projects() {
  const out = [];
  for (const f of ["settings.json", "settings.local.json"]) {
    try {
      const j = JSON.parse(readFileSync(resolve(cwd, ".claude", f), "utf8"));
      for (const d of j.permissions?.additionalDirectories || []) out.push(expand(String(d), cwd));
    } catch {}
  }
  return out;
}

const inside = (p, dir) => p === dir || p.startsWith(dir + sep);

// Premenné z priradení v príkaze, P=~/x && rm $P. Hodnota sa dosadí za $P.
const VARS = new Map();
const subVars = (s) => s.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (m, n) => (VARS.has(n) ? VARS.get(n) : m));

function expand(raw, base) {
  let p = subVars(raw).replace(/^["']|["']$/g, "");
  if (p === "~" || p.startsWith("~/")) p = HOME + p.slice(1);
  p = p.replace(/^\$\{?HOME\}?(?=\/|$)/, HOME);
  return resolve(base, p);
}

// --- zber cieľových ciest ---------------------------------------------------

function pathsFromTool() {
  const p = ti.file_path ?? ti.notebook_path ?? ti.path;
  return p ? [expand(String(p), shell)] : [];
}

// Cieľ je posledný argument.
const DEST_LAST = /^(cp|mv|rsync|ln|install|scp)$/;
// Každý argument s cestou je cieľ; bez cesty sa zapisuje do base.
const WRITE_ALL = /^(rm|rmdir|mkdir|touch|tee|truncate|chmod|chown|dd|patch)$/;
// Cesty absolútne, ~, $HOME, alebo relatívne cez ..
const TOKEN = /(?:^|[\s=])(?:(["'])((?:~|\$\{?HOME\}?|\/|\.\.)[^"']*)\1|((?:~|\$\{?HOME\}?|\/|\.\.(?=\/|$))[^\s"'`;|&<>()]*))/g;

function pathTokens(seg, base) {
  const out = [];
  for (const m of subVars(seg).matchAll(TOKEN)) out.push(expand(m[2] ?? m[3], base));
  return out;
}

// Slovo pred príkazom: priradenie premennej, sudo, command.
const PREFIX = (w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || w === "sudo" || w === "command";
// Spúšťač pred príkazom, jeho prepínače patria jemu.
const RUNNER = new Set(["env", "xargs", "nice", "nohup", "time"]);

// Argumenty sed a perl rozdelené na skripty a súbory. Skript je argument za -e,
// inak prvý argument, ktorý nie je prepínač. Lomky a > v skripte nie sú cesty.
function sedArgs(seg, name) {
  const toks = seg.match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) || [];
  const args = toks.slice(toks.findIndex((t) => t.replace(/^.*\//, "") === name) + 1);
  const scripts = [];
  const files = [];
  let haveScript = args.some((a) => /^-[a-zA-Z]*e$/.test(a));
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (/^-[a-zA-Z]*e$/.test(a)) {
      if (args[i + 1]) scripts.push(args[++i]);
    } else if (name === "sed" && a === "-f") {
      i++;
    } else if (/^-/.test(a)) {
      // BSD sed berie za -i príponu zálohy, obvykle ''
      if (name === "sed" && /^-[a-zA-Z]*i$/.test(a) && /^(''|"")$/.test(args[i + 1] ?? "")) i++;
    } else if (!haveScript) {
      haveScript = true;
      scripts.push(a);
    } else if (!/^\d*[<>]/.test(a)) {
      files.push(a);
    } else {
      break;
    }
  }
  return { scripts, files };
}

// Ciele zápisu curl a wget. Zapisujú len prepínače výstupu, ostatné
// argumenty sú adresy, hlavičky a telo požiadavky. Cesta v tele -d nie je cieľ.
const NET = {
  curl: {
    out: /^-[oDc]$|^--(output|dump-header|cookie-jar|trace|trace-ascii|stderr|libcurl|output-dir|etag-save|hsts|alt-svc)$/,
    val: "AbcCdDeEFHKmoPQrTtuUwxXyYz",
    here: /^--remote-name(-all)?$/,
  },
  wget: {
    out: /^-[OoaP]$|^--(output-document|output-file|append-output|directory-prefix)$/,
    val: "eoaiBtOTwQPlARDXIU",
    here: null,
  },
};

function netTargets(seg, name, base) {
  const spec = NET[name];
  const toks = (seg.match(/(?:"[^"]*"|'[^']*'|[^\s"'])+/g) || []).map((t) => t.replace(/^(["'])(.*)\1$/, "$2"));
  const args = toks.slice(toks.findIndex((t) => t.replace(/^.*\//, "") === name) + 1);
  const out = [];
  let here = false;
  let dir = null;
  let doc = false;
  const take = (flag, v) => {
    if (v == null || v === "-") return;
    if (name === "wget" && /^(-O|--output-document)$/.test(flag)) doc = true;
    if (/^(-P|--directory-prefix|--output-dir)$/.test(flag)) dir = expand(v, base);
    else out.push(expand(v, base));
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--spider") doc = true;
    if (spec.here?.test(a)) here = true;
    const long = a.match(/^(--[a-z-]+)=(.*)$/);
    if (long) {
      if (spec.out.test(long[1])) take(long[1], long[2]);
    } else if (a.startsWith("--")) {
      if (spec.out.test(a)) take(a, args[++i]);
    } else if (/^-[a-zA-Z]/.test(a)) {
      // Zhluk krátkych prepínačov, napríklad -sSo: prvé písmeno s hodnotou
      // berie zvyšok slova alebo ďalší argument.
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (name === "curl" && c === "O") here = true;
        if (!spec.val.includes(c)) continue;
        const v = j + 1 < a.length ? a.slice(j + 1) : args[++i];
        if (spec.out.test("-" + c)) take("-" + c, v);
        break;
      }
    }
  }
  if (name === "wget" && !doc) here = true;
  if (here) out.push(dir ?? base);
  else if (dir) out.push(dir);
  return out;
}

// Telo heredocu od konca riadka s << po ukončovací riadok vrátane. Je to
// obsah, nie príkaz: `cd /tmp` v ňom nemení adresár a cesta v ňom nie je cieľ.
const HEREDOC = /(<<-?\s*(['"]?)(\w+)\2[^\n]*)(\n[\s\S]*?\n[ \t]*\3)(?=\n|$)/g;

// Príkaz s telom heredocu nahradeným medzerami, z neho sa berie text segmentu.
function stripHeredocs(cmd) {
  return cmd.replace(HEREDOC, (m, head, q, tag, body) => head + " ".repeat(body.length));
}

// Kópia príkazu s telom heredocu a obsahom úvodzoviek nahradeným znakom x.
// Operátory ; | && > a koniec riadka sa hľadajú v nej, text sa berie
// zo stripHeredocs na rovnakých pozíciách. Riadok ukončený \ pokračuje.
function maskQuotes(cmd) {
  return cmd
    .replace(HEREDOC, (m, head, q, tag, body) => head + "x".repeat(body.length))
    .replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, (q) => "x".repeat(q.length))
    .replace(/\\\n/g, "  ");
}

function pathsFromBash() {
  const orig = String(ti.command || "");
  const mask = maskQuotes(orig);
  const cmd = stripHeredocs(orig);
  const out = [];
  let base = shell;
  const cuts = [...mask.matchAll(/;|&&|\|\||\||\n/g)];
  for (let i = 0; i <= cuts.length; i++) {
    const from = i ? cuts[i - 1].index + cuts[i - 1][0].length : 0;
    const raw = cmd.slice(from, i < cuts.length ? cuts[i].index : cmd.length);
    const seg = raw.trim();
    if (!seg) continue;
    const lead = from + raw.length - raw.trimStart().length;
    const segMask = mask.slice(lead, lead + seg.length);
    // Spúšťače env a xargs s prepínačmi pred príkazom preskočí, inak by
    // `xargs rm -f /tmp/x` mal meno xargs a zápis by prešiel.
    const all = [...seg.matchAll(/\S+/g)];
    let k = 0;
    for (let runner = false; k < all.length; k++) {
      const w = all[k][0];
      const as = w.match(/^([A-Za-z_][A-Za-z0-9_]*)=(["']?)(.*)\2$/);
      if (as) VARS.set(as[1], subVars(as[3]));
      if (PREFIX(w)) continue;
      if (RUNNER.has(w)) { runner = true; continue; }
      if (runner && w.startsWith("-")) {
        if (/^-[nILPsEduC]$/.test(w)) k++; // prepínač s hodnotou, xargs -n 1
        continue;
      }
      break;
    }
    const words = all.slice(k).map((m) => m[0]).filter((w) => !PREFIX(w));
    const name = (words[0] || "").replace(/^.*\//, "");
    const argv = words.slice(1);
    // Spustiteľný súbor zadaný cestou (/bin/rm) nie je cieľ zápisu, z textu
    // pre pathTokens ho nahradia medzery.
    const exe = all[k];
    const args = exe ? seg.slice(0, exe.index) + " ".repeat(exe[0].length) + seg.slice(exe.index + exe[0].length) : seg;

    if (name === "cd") {
      base = argv[0] ? expand(argv[0], base) : HOME;
      continue;
    }
    const sed = name === "sed" || name === "perl" ? sedArgs(seg, name) : null;
    for (const m of segMask.matchAll(/(?<![<>&\d])>{1,2}\s*([^\s;&|()]+)/g)) {
      const at = m.index + m[0].length - m[1].length;
      const t = seg.slice(at, at + m[1].length).replace(/^["']|["']$/g, "");
      if (!/^&\d$/.test(t)) out.push(expand(t, base));
    }
    if (name === "mktemp") out.push("/tmp/mktemp");
    if (name === "git" && /^(clone|init|worktree)$/.test(argv[0] || "")) {
      out.push(argv.length > 1 ? expand(argv[argv.length - 1], base) : base);
      continue;
    }
    if (sed) {
      if (argv.some((a) => /^-[a-zA-Z]*i/.test(a))) out.push(...sed.files.map((f) => expand(f, base)));
      continue;
    }
    if (NET[name]) {
      out.push(...netTargets(seg, name, base));
      continue;
    }
    // unzip archív len číta, zapisuje do -d alebo do aktuálneho priečinka.
    // 17. 10. 2026 guard zamietol `unzip ~/Desktop/x.zip` v scratch/.
    if (name === "unzip") {
      const d = argv.indexOf("-d");
      if (argv.some((a) => /^-[a-zA-Z]*[lZtv]/.test(a))) continue;
      out.push(d >= 0 && argv[d + 1] ? expand(argv[d + 1], base) : base);
      continue;
    }
    if (DEST_LAST.test(name)) {
      out.push(argv.length ? expand(argv[argv.length - 1], base) : base);
      continue;
    }
    // defaults write zapisuje do ~/Library/Preferences, aj keď cesta nepadne.
    if (name === "defaults" && /^(write|delete|import|rename)$/.test(argv[0] || "")) {
      out.push(...pathTokens(args, base), `${HOME}/Library/Preferences`);
      continue;
    }
    // plutil a PlistBuddy menia súbor len v týchto režimoch, -p a -lint čítajú.
    if (
      (name === "plutil" && argv.some((a) => /^-(replace|insert|remove|convert|create)$/.test(a))) ||
      (name === "PlistBuddy" && /\b(Set|Add|Delete|Clear|Merge|Import|Save)\b/.test(seg))
    ) {
      const toks = pathTokens(args, base);
      out.push(...(toks.length ? toks : [base]));
      continue;
    }
    if (WRITE_ALL.test(name)) {
      const toks = pathTokens(args, base);
      out.push(...(toks.length ? toks : [base]));
    }
  }
  return out;
}

// --- rozhodnutie ---------------------------------------------------------------

function decide(p) {
  if (FREE.has(p)) return "allow";
  if (inside(p, memoryOf(cwd))) return "allow";
  switch (role) {
    case "rules":
      if (inside(p, RULES) || inside(p, AGENTI)) return "allow";
      return inside(p, WORK) && CONFIG.test(p) ? "allow" : "ask";
    case "agent":
      if (PERSONA.some((d) => inside(p, d))) return "ask";
      if (inside(p, cwd)) return "allow";
      return projects().some((d) => inside(p, d)) ? "allow" : "ask";
    case "agenti":
      return inside(p, resolve(AGENTI, "scratch")) ? "allow" : "ask";
    case "root":
      return inside(p, resolve(WORK, "scratch")) ? "allow" : "ask";
    default:
      return inside(p, cwd) ? "allow" : "ask";
  }
}

const RANK = { allow: 0, ask: 1 };
const paths = tool === "Bash" ? pathsFromBash() : pathsFromTool();
let decision = "allow";
let culprit = null;
for (const p of paths) {
  const d = decide(p);
  if (RANK[d] > RANK[decision]) {
    decision = d;
    culprit = p;
  }
}
if (decision === "allow") process.exit(0);

const tilde = (p) => p.replace(HOME, "~");
const where = role === "rules" ? `${tilde(RULES)} a ~/Work/agenti` : role === "root" ? "~/Work" : tilde(cwd);
const agenti = role === "agenti";
const persona = role === "agent" && PERSONA.some((d) => inside(culprit, d));
const reason = agenti
  ? `Relácia v ~/Work/agenti nie je relácia repa kódu a nemá zábranu jednej relácie. Agent beží vo svojom repe ~/Work/agenti/<meno>. Zápis ${tilde(culprit)} potrebuje súhlas operátora.`
  : persona
  ? `${tilde(culprit)} je persona agenta. Mení ju správca agenta, opravu vlastnej chyby agent sám, so súhlasom operátora.`
  : `${tilde(culprit)} je mimo územia ${where}, zápis potrebuje súhlas operátora. Dočasné súbory patria do <cwd>/scratch/.`;

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }),
);
