// shell_cmd.mjs — rozbor príkazu Bash na jednoduché príkazy v poradí, v akom sa
// vykonajú. Spoločný základ hookov sed_line.mjs a secret_read.mjs (úloha 621).
// Rozbalí `sh -c '...'`, `runuser -u X --`, `sudo`, `env`, `xargs` a podobné predpony,
// príkazy v `$(...)` a spätných apostrofoch, vyhodí telo heredocu a komentáre.
// Text v úvodzovkách je jeden argument, takže `echo sed -i ...` je príkaz echo.
// Tokenizér je `segments` z hooks/rm_target.mjs.
//
// simpleCommands(raw) vráti pole { head, args, stdin, stdoutFile, captured, sep, pipeNext }:
//   head        meno programu bez cesty (`/bin/cat` je `cat`)
//   args        argumenty ako {val, exp} bez presmerovaní
//   stdin       súbory z `< súbor`
//   stdoutFile  stdout ide do súboru (`> f`, `>> f`, `&> f`)
//   captured    príkaz beží v `$(...)` alebo v priradení `X=$(...)` a jeho výstup
//               nejde na obrazovku (výnimka: `echo "$(cat f)"`, `printf ...`)
//   sep         znak, ktorým úsek skončil (`|` je rúra)
//   pipeNext    meno programu za rúrou, alebo null

import { segments } from "../hooks/rm_target.mjs";
import { stripHeredocs } from "../hooks/no_model_wait.mjs";

const WRAP = new Set(["env", "time", "nohup", "command", "exec", "nice", "ionice", "stdbuf", "!", "{", "if", "then", "elif", "else", "do", "while", "until", "sudo", "runuser", "su", "timeout", "xargs", "builtin"]);
const SHELL = /^(?:ba|da|z)?sh$/;
const PRINTING_PARENT = new Set(["echo", "printf", "print"]);
export const base = (t) => String(t).replace(/^.*\//, "");

// Komentár shellu: `#` na začiatku slova mimo úvodzoviek až do konca riadka.
export function stripComments(cmd) {
  const s = String(cmd);
  let out = "", q = null, word = true;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      out += c;
      if (c === "\\" && q === '"' && i + 1 < s.length) out += s[++i];
      else if (c === q) q = null;
      continue;
    }
    if (c === "\\") { out += c + (s[i + 1] ?? ""); i++; word = false; continue; }
    if (c === "'" || c === '"') { q = c; out += c; word = false; continue; }
    if (c === "#" && word) { while (i + 1 < s.length && s[i + 1] !== "\n") i++; continue; }
    out += c;
    word = /[\s;&|()]/.test(c);
  }
  return out;
}

// Texty z `$(...)` a spätných apostrofov v rozvinuteľnej časti slova.
export function substitutions(exp) {
  const out = [];
  for (let i = 0; i < exp.length; i++) {
    if (exp[i] === "$" && exp[i + 1] === "(") {
      let d = 0, j = i + 1;
      for (; j < exp.length; j++) { if (exp[j] === "(") d++; else if (exp[j] === ")" && --d === 0) break; }
      out.push(exp.slice(i + 2, j));
      i = j;
    } else if (exp[i] === "`") {
      const j = exp.indexOf("`", i + 1);
      const end = j < 0 ? exp.length : j;
      out.push(exp.slice(i + 1, end));
      i = end;
    }
  }
  return out;
}

// Presmerovania `2>&1` a `&>f` by tokenizér rozsekal na `&`. `2>&1` zmizne, `&>` je `>`.
function normalizeRedirects(text) {
  return text.replace(/(\d*)>&(\d+|-)/g, " ").replace(/&>>?/g, (m) => m.slice(1));
}

// Index prvého slova príkazu po predponách a priradeniach. Pre shell s `-c` vráti
// { script }. Pre predpony `su`/`runuser` s `-c` tiež.
function headOf(toks) {
  let i = 0;
  while (i < toks.length) {
    const t = toks[i].val;
    const b = base(t);
    if (/^[A-Za-z_]\w*\+?=/.test(t)) { i++; continue; }
    if (WRAP.has(b)) {
      i++;
      while (i < toks.length && /^-/.test(toks[i].val) && toks[i].val !== "--") {
        const o = toks[i].val;
        i++;
        if (b === "sudo" ? /^-(u|g|h|p|C|r|t|U|D|R|T)$/.test(o) : /^-(u|g|n|I|P|s|l|L|d|E|a)$/.test(o) && b !== "su") i++;
      }
      if ((b === "runuser" || b === "su") && i < toks.length && toks[i].val !== "--" && !SHELL.test(base(toks[i].val))) {
        const c = toks.findIndex((x, k) => k > i && x.val === "-c");
        if (c < 0) i++;
        else if (toks[c + 1]) return { script: toks[c + 1].val };
      }
      if (b === "timeout" && /^\d/.test(toks[i]?.val ?? "")) i++;
      if (toks[i]?.val === "--") i++;
      continue;
    }
    if (SHELL.test(b)) {
      const c = toks.findIndex((x, k) => k > i && /^-[a-z]*c$/.test(x.val));
      if (c >= 0 && toks[c + 1]) return { script: toks[c + 1].val };
    }
    return { h: i };
  }
  return { h: -1 };
}

// Argumenty bez presmerovaní: { args, stdin, stdoutFile }.
function splitRedirects(argv) {
  const args = [], stdin = [];
  let stdoutFile = false;
  for (let k = 0; k < argv.length; k++) {
    const { val: v, exp } = argv[k];
    let m = /^(\d*)(>>?|<)$/.exec(v);
    if (m && exp === v) {
      const tgt = argv[++k];
      if (m[2] === "<") { if (m[1] === "" || m[1] === "0") if (tgt) stdin.push(tgt.val); }
      else if (m[1] === "" || m[1] === "1") stdoutFile = true;
      continue;
    }
    m = /^(\d*)(>>?|<)([^<>=\s].*)$/.exec(v);
    if (m && exp === v) {
      if (m[2] === "<") { if (m[1] === "" || m[1] === "0") stdin.push(m[3]); }
      else if (m[1] === "" || m[1] === "1") stdoutFile = true;
      continue;
    }
    args.push(argv[k]);
  }
  return { args, stdin, stdoutFile };
}

export function simpleCommands(raw, { depth = 0, captured = false } = {}) {
  const out = [];
  const text = normalizeRedirects(stripComments(stripHeredocs(String(raw))));
  const segs = segments(text);
  segs.forEach((toks, idx) => {
    const hd = headOf(toks);
    const nextHead = (() => {
      const n = segs[idx + 1];
      if (!n) return null;
      const h = headOf(n);
      return h.h >= 0 ? base(n[h.h].val) : null;
    })();
    const headName = hd.h >= 0 ? base(toks[hd.h].val) : "";
    // Príkazy v substitúciách sa vykonajú pred hlavným príkazom.
    toks.forEach((t, k) => {
      if (depth >= 4) return;
      const assign = hd.h < 0 || k < hd.h || /^[A-Za-z_]\w*\+?=/.test(t.val);
      for (const inner of substitutions(t.exp)) {
        const cap = captured || !(PRINTING_PARENT.has(headName) && !assign) ;
        out.push(...simpleCommands(inner, { depth: depth + 1, captured: cap }));
      }
    });
    if (hd.script !== undefined) {
      if (depth < 4) out.push(...simpleCommands(hd.script, { depth: depth + 1, captured }));
      return;
    }
    if (hd.h < 0) return;
    const { args, stdin, stdoutFile } = splitRedirects(toks.slice(hd.h + 1));
    out.push({ head: headName, args, stdin, stdoutFile, captured, sep: toks.sep ?? "", pipeNext: toks.sep === "|" ? nextHead : null });
  });
  return out;
}
