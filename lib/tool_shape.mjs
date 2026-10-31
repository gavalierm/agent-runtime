// tool_shape.mjs — tvar príkazu Bash a rozpoznanie "nástroj alebo prepínač
// v tomto prostredí nefunguje" (úloha 615). Používajú ho hooky
// tool_failure_log.mjs (zapíše zlyhanie do registra) a tool_failure_block.mjs
// (zamietne ten istý tvar podruhé).
//
//   shapeOf(command)     {program, flags, sub, segment, shapes}: prvý jednoduchý príkaz,
//                        ktorý nie je neutrálny (cd, echo, printf, test, [), a tvary
//                        všetkých jednoduchých príkazov v `shapes`
//   envKey()             `${používateľ}@${hostname}`
//   missingTool(text, p) true, keď chyba hovorí o chýbajúcom nástroji alebo neznámom
//                        prepínači (nie o práve, sieti ani vstupe)
//   MISSING_PATTERNS     zoznam vzorov
//
// Tvar = program (basename prvého slova), prepínače (tokeny na `-`, bez `=hodnota`,
// zoradené) a pri programoch s podpríkazmi (git, docker, ...) aj podpríkaz: bez neho
// by "git: 'foo' is not a git command" zamietlo každý `git` bez prepínačov.
// Rozdelenie na jednoduché príkazy: `;`, `&&`, `||`, `|`, nový riadok, `(`, `)`,
// spätný apostrof; text v úvodzovkách a heredoc sa nedelí. Priradenia premenných na
// začiatku a `env`, `time`, `nohup`, `exec` sa preskočia.
import { hostname, userInfo } from "node:os";
import { basename } from "node:path";

export const NEUTRAL = new Set(["cd", "echo", "printf", "test", "["]);
const PREFIX = new Set(["!", "{", "}", "if", "then", "else", "elif", "do", "while", "until", "time", "nohup", "exec", "env"]);
const SUBCOMMAND = new Set(["git", "docker", "systemctl", "apt", "apt-get", "npm", "pnpm", "yarn", "kubectl", "cargo", "pip", "pip3", "tasker", "tk"]);
const VALUE_FLAGS = { git: new Set(["-C", "-c"]) };

export function envKey({ user, host } = {}) {
  let u = user;
  if (!u) {
    try {
      u = userInfo().username;
    } catch {
      u = process.env.USER || "?";
    }
  }
  return `${u}@${host || hostname()}`;
}

// Heredoc: riadky tela až po ukončovací riadok sa zahodia.
function stripHeredocs(text) {
  const out = [];
  let end = null;
  for (const line of text.split("\n")) {
    if (end !== null) {
      if (line.trim() === end) end = null;
      continue;
    }
    out.push(line);
    const m = line.match(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1/);
    if (m) end = m[2];
  }
  return out.join("\n");
}

// Rozdelí príkaz na jednoduché príkazy, každý je pole tokenov {text, quoted}.
function parse(command) {
  const s = stripHeredocs(String(command ?? ""));
  const segs = [];
  let toks = [];
  let cur = null;
  let q = null;
  const endTok = () => {
    if (cur) toks.push(cur);
    cur = null;
  };
  const endSeg = () => {
    endTok();
    if (toks.length) segs.push(toks);
    toks = [];
  };
  const add = (ch) => {
    cur = cur || { text: "", quoted: false };
    cur.text += ch;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (q === '"' && c === "\\" && i + 1 < s.length) add(s[++i]);
      else add(c);
      continue;
    }
    if (c === "\\") {
      if (s[i + 1] === "\n") i++;
      else if (i + 1 < s.length) add(s[++i]);
      continue;
    }
    if (c === "'" || c === '"') {
      q = c;
      cur = cur || { text: "", quoted: true };
      continue;
    }
    if (c === "#" && !cur) {
      while (i + 1 < s.length && s[i + 1] !== "\n") i++;
      continue;
    }
    if (c === ";" || c === "\n" || c === "|" || c === "(" || c === ")" || c === "`") {
      endSeg();
      continue;
    }
    if (c === "&") {
      if (s[i + 1] === "&") {
        i++;
        endSeg();
      } else if (s[i - 1] === ">" || s[i - 1] === "<" || s[i + 1] === ">") add(c);
      else endSeg();
      continue;
    }
    if (/\s/.test(c)) {
      endTok();
      continue;
    }
    add(c);
  }
  endSeg();
  return segs;
}

function shapeOfSegment(tokens) {
  let t = tokens.slice();
  for (;;) {
    if (t.length && !t[0].quoted && /^[A-Za-z_]\w*=/.test(t[0].text)) t = t.slice(1);
    else if (t.length > 1 && !t[0].quoted && PREFIX.has(t[0].text)) t = t.slice(1);
    else break;
  }
  if (!t.length) return null;
  const program = basename(t[0].text) || t[0].text;
  const flags = new Set();
  let sub = "";
  let skip = false;
  for (let i = 1; i < t.length; i++) {
    const a = t[i];
    if (skip) {
      skip = false;
      continue;
    }
    if (!a.quoted && /^-./.test(a.text) && a.text !== "--") {
      flags.add(a.text.split("=")[0]);
      if (VALUE_FLAGS[program]?.has(a.text)) skip = true;
    } else if (!sub && SUBCOMMAND.has(program) && !a.quoted && a.text !== "--") sub = a.text;
  }
  return { program, sub, flags: [...flags].sort(), segment: t.map((x) => x.text).join(" ") };
}

export function shapeOf(command) {
  const shapes = parse(command).map(shapeOfSegment).filter(Boolean);
  const first = shapes.find((x) => !NEUTRAL.has(x.program)) || { program: "", sub: "", flags: [], segment: "" };
  return { ...first, shapes };
}

// Vzory chýb o chýbajúcom nástroji alebo prepínači. "must be run as root" je iné
// (právo, nie nástroj). "No such file or directory" sa posudzuje zvlášť.
export const MISSING_PATTERNS = [
  /command not found/i,
  /unrecognized option/i,
  /unknown option/i,
  /invalid option/i,
  /illegal option/i,
  /unknown flag/i,
  /option [^:]*: is unknown/i,
  /is not a git command/i,
  /option requires/i,
  /^(?:\S+: )?sudo: .*not found/i,
];
export const NOT_MISSING = /must be run as root/i;
const NO_FILE_OK = new Set(["cp", "mv", "cat", "ls"]);

// `line` je prvý riadok chyby. Bez `program` stačí "No such file or directory" na
// prvom riadku (okrem cp, mv, cat, ls v texte), s `program` len keď je ten súbor
// samotný program ("bash: line 1: ./x.sh: No such file or directory"), inak by
// `python3: can't open file ...: No such file` zamietlo každý ďalší `python3`.
export function missingTool(line, program = "") {
  const text = String(line ?? "").split("\n")[0];
  if (NOT_MISSING.test(text)) return false;
  if (MISSING_PATTERNS.some((re) => re.test(text))) return true;
  if (!/No such file or directory/.test(text)) return false;
  if (program) {
    if (NO_FILE_OK.has(program)) return false;
    const esc = program.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?:^|[\\s:/])${esc}: No such file or directory`).test(text);
  }
  return !/^\s*(?:cp|mv|cat|ls)\b/.test(text) && !/\b(?:cp|mv|cat|ls): /.test(text);
}

// Prvý riadok chyby: Claude Code dáva do `error` na prvý riadok "Exit code N".
export function firstErrorLine(err) {
  for (const l of String(err ?? "").split("\n")) {
    const t = l.trim();
    if (t && !/^Exit code \d+$/.test(t)) return t.replace(/\s+/g, " ").slice(0, 300);
  }
  return "";
}

// Tvar zlyhania: segment, ktorého program sa spomína v chybe, inak prvý nie neutrálny.
export function failedShape(command, errLine = "") {
  const sh = shapeOf(command);
  const named = sh.shapes.find((x) => !NEUTRAL.has(x.program) && errLine.includes(x.program));
  if (named) return { ...named, shapes: sh.shapes };
  // Chyba s menom iného programu (`tasker: unknown option` z `tk comment` vedľa `cat > súbor`)
  // nepatrí prvému segmentu. Chyba 31. 10. 2026 (úloha 720): register ju pripísal `cat`.
  if (errorProgram(errLine)) return { shapes: sh.shapes };
  return sh;
}

// Program, ktorý chybu vypísal (`tasker: ...`, `bash: line 1: x: ...` dá `bash`), alebo "".
export function errorProgram(errLine = "") {
  const m = String(errLine).match(/^([A-Za-z0-9_.+-]+): /);
  return m ? m[1] : "";
}
