#!/usr/bin/env node
// sed_line.mjs — `sed -i` s číslom riadku mení iba vtedy, keď agent ten riadok
// v tom istom príkaze videl. Chyba 22. 10. 2026: `sed -i '6s|.*|...|'` v návrhu
// webu Taskera prepísal riadok `:root` namiesto riadku s farbami stavov, číslo
// riadku pochádzalo z predošlého výpisu a súbor sa medzitým zmenil (operátor dostal
// rozbité CSS s bielym pozadím). Pravidlo v CLAUDE.md Huga nestačilo (global §4).
//
// PreToolUse pre Bash. Zamietne príkaz, v ktorom `sed` s `-i` (`-i.bak`, `-i ''`,
// `-Ei`, `--in-place`; aj za `&&`, `;`, `|`, v `$(...)`, pod `sh -c`, `runuser`,
// `sudo`) má príkaz `s`, `c`, `d`, `i` alebo `a` s adresou z čísla riadku (`6`),
// rozsahu čísel (`6,9`), kroku (`6~2`), posledného riadku (`$`) alebo z premennej
// (`"${N}s|a|b|"`) a v tom istom príkaze pred ním nie je výpis toho riadka
// toho istého súboru: `sed -n '6p' f`, `sed -n '6,9p' f` (rozsah musí pokryť
// celú adresu) alebo `awk 'NR==6' f`. Adresa podľa obsahu (`/vzor/`), `sed` bez
// `-i`, `sed -f skript` a `sed` v texte (echo, grep, heredoc, komentár) prejdú.
// Rozbor príkazu: lib/shell_cmd.mjs. Test: hooks/sed_line.test.mjs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normalize } from "node:path";
import { simpleCommands } from "../lib/shell_cmd.mjs";
import { denyTool } from "../lib/deny.mjs";

const DANGEROUS = new Set(["s", "c", "d", "i", "a"]);

// --- adresy skriptu sed -----------------------------------------------------

// Zhltne adresu od `i`. Vráti { end, kind, text, lo, hi } alebo null. kind:
// num, last, step, var, re.
function parseAddr(src, i, expands) {
  const c = src[i];
  if (c === undefined) return null;
  if (/\d/.test(c)) {
    let j = i;
    while (/\d/.test(src[j] ?? "")) j++;
    const n = Number(src.slice(i, j));
    if (src[j] === "~" && /\d/.test(src[j + 1] ?? "")) {
      let k = j + 1;
      while (/\d/.test(src[k] ?? "")) k++;
      return { end: k, kind: "step", text: src.slice(i, k), lo: n, hi: Infinity };
    }
    return { end: j, kind: "num", text: String(n), lo: n, hi: n };
  }
  if (c === "$") {
    const n = src[i + 1] ?? "";
    if (expands && /[{(A-Za-z_]/.test(n)) {
      let j = i + 1;
      if (n === "{" || n === "(") {
        const open = n, close = n === "{" ? "}" : ")";
        let d = 0;
        for (j = i + 1; j < src.length; j++) {
          if (src[j] === open) d++;
          else if (src[j] === close && --d === 0) break;
        }
        j = Math.min(j + 1, src.length);
      } else {
        while (/\w/.test(src[j] ?? "")) j++;
      }
      return { end: j, kind: "var", text: src.slice(i, j), lo: null, hi: null };
    }
    return { end: i + 1, kind: "last", text: "$", lo: Infinity, hi: Infinity };
  }
  if (c === "/" || c === "\\") {
    const d = c === "\\" ? src[i + 1] : "/";
    let j = i + (c === "\\" ? 2 : 1);
    while (j < src.length && src[j] !== d) j += src[j] === "\\" ? 2 : 1;
    j++;
    while (/[IM]/.test(src[j] ?? "")) j++;
    return { end: j, kind: "re", text: src.slice(i, j), lo: null, hi: null };
  }
  return null;
}

// Preskočí text príkazu s, y, a, i, c a pod. Vráti index za príkazom.
function skipCommand(src, i, c) {
  const n = src.length;
  if (c === "s" || c === "y") {
    const d = src[i + 1];
    let j = i + 2;
    for (let part = 0; part < 2 && j < n; part++) {
      while (j < n && src[j] !== d) j += src[j] === "\\" ? 2 : 1;
      j++;
    }
    while (j < n && !/[;\n}]/.test(src[j])) {
      if (src[j] === "w") { while (j < n && src[j] !== "\n") j++; break; }
      j++;
    }
    return j;
  }
  if (c === "a" || c === "i" || c === "c" || /[rRwW:]/.test(c)) {
    let j = i + 1;
    while (j < n && !(src[j] === "\n" && src[j - 1] !== "\\")) j++;
    return j;
  }
  let j = i + 1;
  while (j < n && !/[;\n}]/.test(src[j])) j++;
  return j;
}

// Príkazy skriptu sed: [{ addr, cmd }], addr null pre príkaz bez adresy.
export function sedCommands(src, expands = false) {
  const out = [];
  const stack = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    while (i < n && /[\s;]/.test(src[i])) i++;
    if (i >= n) break;
    if (src[i] === "}") { stack.pop(); i++; continue; }
    if (src[i] === "#") { while (i < n && src[i] !== "\n") i++; continue; }
    let addr = null;
    const a1 = parseAddr(src, i, expands);
    if (a1) {
      addr = a1;
      i = a1.end;
      if (src[i] === ",") {
        i++;
        let a2 = parseAddr(src, i, expands);
        if (!a2 && /[+~]/.test(src[i] ?? "")) {
          let j = i + 1;
          while (/\d/.test(src[j] ?? "")) j++;
          a2 = { end: j, kind: "rel", lo: null, hi: null };
        }
        if (a2) {
          i = a2.end;
          let hi = a2.kind === "num" ? a2.hi : a2.kind === "last" ? Infinity : null;
          const zero = a1.kind === "num" && a1.lo === 0;
          addr = { kind: a1.kind === "re" || (zero && hi === null) ? "re" : "range", text: src.slice(a1.end - a1.text.length, i), lo: a1.lo, hi, var: a1.kind === "var" };
        }
      }
    }
    while (i < n && /[\s!]/.test(src[i])) i++;
    const c = src[i];
    if (c === undefined) break;
    if (c === "{") { stack.push(addr); i++; continue; }
    const eff = addr ?? [...stack].reverse().find(Boolean) ?? null;
    out.push({ addr: eff, cmd: c });
    i = skipCommand(src, i, c);
  }
  return out;
}

// --- argumenty príkazu sed --------------------------------------------------

export function parseSed(args) {
  const r = { inplace: false, quiet: false, scripts: [], files: [], scriptFile: false };
  let haveScript = false;
  const vals = args.map((a) => a.val);
  for (let k = 0; k < args.length; k++) {
    const v = vals[k];
    if (v === "--") { for (k++; k < args.length; k++) addPos(args[k]); break; }
    if (v === "--in-place" || v.startsWith("--in-place=")) { r.inplace = true; continue; }
    if (v === "--quiet" || v === "--silent") { r.quiet = true; continue; }
    if (v === "--expression" && args[k + 1]) { r.scripts.push(args[++k]); haveScript = true; continue; }
    if (v.startsWith("--expression=")) { r.scripts.push({ val: v.slice(13), exp: args[k].exp.slice(13) }); haveScript = true; continue; }
    if (v === "--file" || v.startsWith("--file=")) { r.scriptFile = true; if (v === "--file") k++; continue; }
    if (v.startsWith("--")) continue;
    if (/^-[A-Za-z]/.test(v)) {
      for (let j = 1; j < v.length; j++) {
        const ch = v[j];
        if (ch === "n") r.quiet = true;
        else if (ch === "i") {
          r.inplace = true;
          if (j === v.length - 1 && args[k + 1] && vals[k + 1] === "") k++; // BSD: -i ''
          break;
        } else if (ch === "e") {
          haveScript = true;
          if (j + 1 < v.length) r.scripts.push({ val: v.slice(j + 1), exp: args[k].exp.slice(j + 1) });
          else if (args[k + 1]) r.scripts.push(args[++k]);
          break;
        } else if (ch === "f") {
          r.scriptFile = true;
          if (j + 1 >= v.length) k++;
          break;
        } else if (ch === "l") {
          if (j + 1 >= v.length) k++;
          break;
        }
      }
      continue;
    }
    addPos(args[k]);
  }
  function addPos(a) {
    if (!haveScript && !r.scriptFile) { r.scripts.push(a); haveScript = true; }
    else r.files.push(a.val);
  }
  return r;
}

// --- výpis riadkov ----------------------------------------------------------

// Intervaly riadkov, ktoré príkaz vypíše: [{ lo, hi, text }], hi Infinity pre koniec.
function printed(it) {
  const out = [];
  if (it.head === "sed") {
    const s = parseSed(it.args);
    if (s.inplace) return { files: [], spans: out };
    for (const sc of s.scripts) {
      for (const { addr, cmd } of sedCommands(sc.val, /\$/.test(sc.exp))) {
        if (cmd !== "p") continue;
        out.push(addr ? { lo: addr.lo, hi: addr.hi, text: addr.text, kind: addr.kind } : { lo: 1, hi: Infinity, text: "", kind: "all" });
      }
    }
    return { files: s.files.map(normPath), spans: out };
  }
  if (/^(?:g|m)?awk$/.test(it.head)) {
    const vals = it.args.map((a) => a.val);
    let prog = null;
    const files = [];
    for (let k = 0; k < vals.length; k++) {
      const v = vals[k];
      if (v === "-f") { k++; prog = ""; continue; }
      if (v === "-v" || v === "-F") { k++; continue; }
      if (/^-/.test(v)) continue;
      if (prog === null) prog = v; else files.push(v);
    }
    const p = prog ?? "";
    for (const m of p.matchAll(/NR\s*==\s*(\d+)\s*,\s*NR\s*==\s*(\d+)/g)) out.push({ lo: Number(m[1]), hi: Number(m[2]), text: "", kind: "range" });
    for (const m of p.matchAll(/NR\s*==\s*(\d+)/g)) out.push({ lo: Number(m[1]), hi: Number(m[1]), text: "", kind: "num" });
    const ge = /NR\s*(>=|>)\s*(\d+)/.exec(p);
    const le = /NR\s*(<=|<)\s*(\d+)/.exec(p);
    if (ge) out.push({ lo: Number(ge[2]) + (ge[1] === ">" ? 1 : 0), hi: le ? Number(le[2]) - (le[1] === "<" ? 1 : 0) : Infinity, text: "", kind: "range" });
    if (/\bEND\b/.test(p)) out.push({ lo: Infinity, hi: Infinity, text: "$", kind: "last" });
    return { files: files.map(normPath), spans: out };
  }
  return { files: [], spans: out };
}

const normPath = (p) => normalize(p).replace(/^\.\//, "");

// Pokrýva výpis `span` adresu `addr`?
function covers(span, addr) {
  if (span.kind === "all") return true;
  if (addr.kind === "var" || addr.var) return span.text === addr.text;
  if (addr.kind === "last") return span.hi === Infinity;
  if (addr.kind === "step") return span.text === addr.text || (span.kind !== "last" && span.lo <= addr.lo && span.hi === Infinity);
  // num a range: pokryť treba celý rozsah, neznámy koniec (regex, +N) stačí od začiatku
  const hi = addr.hi === null ? addr.lo : addr.hi;
  return span.lo <= addr.lo && span.hi >= hi && span.lo !== Infinity;
}

// Vráti [{ addr, cmd, file }] pre rizikové úpravy bez výpisu, alebo [].
export function lineEditsWithoutPrint(raw) {
  const items = simpleCommands(raw);
  const bad = [];
  items.forEach((it, idx) => {
    if (it.head !== "sed") return;
    const s = parseSed(it.args);
    if (!s.inplace || s.scriptFile || !s.files.length) return;
    for (const sc of s.scripts) {
      for (const { addr, cmd } of sedCommands(sc.val, /\$/.test(sc.exp))) {
        if (!addr || !DANGEROUS.has(cmd)) continue;
        if (!["num", "range", "last", "step", "var"].includes(addr.kind)) continue;
        for (const f of s.files) {
          const file = normPath(f);
          const seen = items.slice(0, idx).some((p) => {
            const pr = printed(p);
            return pr.files.includes(file) && pr.spans.some((sp) => covers(sp, addr));
          });
          if (!seen) bad.push({ addr: addr.text, cmd, file: f });
        }
      }
    }
  });
  return bad;
}

export const MESSAGE =
  "`sed -i` s číslom riadku mení riadok, ktorý si v tom istom príkaze nevypísal. Číslo pochádza z predošlého výpisu a súbor sa medzitým " +
  "mohol zmeniť, sed potom prepíše iný riadok, než si myslíš (chyba 22. 10. 2026: `sed -i '6s|.*|...|'` zmazal riadok `:root` v CSS).";

export const POSTUP =
  "vypíš riadok v tom istom príkaze (`sed -n '6p' f && sed -i '6s|...|...|' f`) alebo meň podľa obsahu " +
  "(`sed -i 's|starý|nový|' f`, nástroj Edit).";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  if (input.tool_name !== "Bash") process.exit(0);
  const bad = lineEditsWithoutPrint(String((input.tool_input || {}).command || ""));
  if (bad.length) denyTool(`${MESSAGE} Adresa: ${bad[0].addr}${bad[0].cmd}, súbor: ${bad[0].file}.`, POSTUP);
}
