#!/usr/bin/env node
// rm_target.mjs — `rm` s cieľom z `$(...)`, spätných apostrofov alebo z premennej
// bez `:?` zamietne hook skôr, než sa spýta poistka Claude Code. Verzia 2.1.310
// má poistku dangerousRemoval s bypassImmune: pýta sa človeka aj v režime
// bypassPermissions a beh agenta v T3 stojí na schválení (beh 118 Lea,
// `rm -rf "$(cat /tmp/e2e-dir)" /tmp/e2e-dir`). Poistka berie
// strážený tvar `${VAR:?}` ako bezpečný, `$(...)` stráž nemá. Úloha Taskera 599.
//
// PreToolUse pre Bash. Rozbor: úseky oddelené `;`, `&`, `|`, novým riadkom
// a zátvorkami, hlava úseku po predponách (sudo, env, time, runuser, xargs ...),
// `sh -c '...'` sa rozoberie rekurzívne. Text v úvodzovkách, heredoci, `grep rm`
// a `rm` s doslovnou cestou pustí; v spornom prípade radšej pustí.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { stripHeredocs } from "./no_model_wait.mjs";
import { denyTool } from "../lib/deny.mjs";

// Rozdelí príkaz na úseky tokenov {val, exp}. val je slovo bez úvodzoviek,
// exp slovo, v ktorom zostal len text, ktorý shell rozvinie (bez '...' a `\$`).
export function segments(cmd) {
  const segs = [];
  let toks = [];
  let val = "", exp = "", has = false;
  const endTok = () => { if (has) toks.push({ val, exp }); val = ""; exp = ""; has = false; };
  // sep: znak, ktorým úsek skončil (`;`, `|`, `&`, nový riadok), `||` a `&&` ako dvojica.
  // Slúži lib/shell_cmd.mjs na rozpoznanie rúry; rm_target ho nečíta.
  const endSeg = (sep = "") => { endTok(); if (toks.length) { toks.sep = sep; segs.push(toks); } toks = []; };
  const s = String(cmd);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") {
      const n = s[i + 1] ?? "";
      if (n === "\n") { i++; continue; }
      val += n; has = true; if (n !== "$" && n !== "`") exp += n; i++;
    } else if (c === "'") {
      const j = s.indexOf("'", i + 1);
      const end = j < 0 ? s.length : j;
      val += s.slice(i + 1, end); exp += "x"; has = true; i = end;
    } else if (c === '"') {
      has = true; i++;
      for (; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === "\\" && i + 1 < s.length) {
          const n = s[++i];
          val += n; if (n !== "$" && n !== "`") exp += n;
        } else { val += s[i]; exp += s[i]; }
      }
    } else if (c === "$" && s[i + 1] === "(") {
      let d = 0, j = i + 1;
      for (; j < s.length; j++) { if (s[j] === "(") d++; else if (s[j] === ")" && --d === 0) break; }
      const part = s.slice(i, j + 1);
      val += part; exp += part; has = true; i = j;
    } else if (c === "`") {
      const j = s.indexOf("`", i + 1);
      const end = j < 0 ? s.length : j;
      const part = s.slice(i, end + 1);
      val += part; exp += part; has = true; i = end;
    } else if (/\s/.test(c) && c !== "\n") endTok();
    else if (c === ";" || c === "&" || c === "|" || c === "\n" || c === "(" || c === ")") endSeg((c === "|" || c === "&") && s[i + 1] === c ? c + c : c);
    else { val += c; exp += c; has = true; }
  }
  endSeg();
  return segs;
}

// Cieľ je nebezpečný, keď po odstránení strážených `${VAR:?...}` ostane `$(`,
// `$VAR`, `${VAR}` alebo spätný apostrof.
export function unsafeTarget(exp) {
  const rest = exp.replace(/\$\{[A-Za-z_]\w*:\?[^}]*\}/g, "");
  return /`|\$[({A-Za-z_@*#?!0-9]/.test(rest);
}

const WRAP = new Set(["env", "time", "nohup", "command", "exec", "nice", "ionice", "stdbuf", "!", "{", "if", "then", "elif", "else", "do", "while", "until", "sudo", "runuser", "su", "timeout", "xargs"]);
const SHELL = /^(?:ba|da|z)?sh$/;
const base = (t) => t.replace(/^.*\//, "");

// Cieľ nebezpečného rm v úseku: vráti token, alebo null.
function badInSegment(toks, depth) {
  let i = 0;
  while (i < toks.length) {
    const t = toks[i].val;
    const b = base(t);
    if (/^[A-Za-z_]\w*=/.test(t)) { i++; continue; }
    if (WRAP.has(b)) {
      i++;
      while (i < toks.length && /^-/.test(toks[i].val)) {
        const o = toks[i].val;
        i++;
        // voľby s hodnotou: sudo -u X, runuser -u X, xargs -n N / -I X
        if (/^-(u|g|n|I|P|s|l|L|d|E|a)$/.test(o) && !(b === "su")) i++;
      }
      if ((b === "runuser" || b === "su") && i < toks.length && toks[i].val !== "--" && !SHELL.test(base(toks[i].val)) && base(toks[i].val) !== "rm") i++;
      if (b === "timeout" && /^\d/.test(toks[i]?.val ?? "")) i++;
      if (b === "runuser" || b === "su") {
        const c = toks.findIndex((x, k) => k >= i && x.val === "-c");
        if (c >= 0 && toks[c + 1] && depth < 3) return scriptBad(toks[c + 1].val, depth + 1);
      }
      if (toks[i]?.val === "--") i++;
      continue;
    }
    if (SHELL.test(b)) {
      const c = toks.findIndex((x, k) => k > i && /^-[a-z]*c$/.test(x.val));
      if (c >= 0 && toks[c + 1] && depth < 3) return scriptBad(toks[c + 1].val, depth + 1);
      return null;
    }
    if (b !== "rm") return null;
    let opts = true;
    for (let k = i + 1; k < toks.length; k++) {
      const x = toks[k];
      if (opts && x.val === "--") { opts = false; continue; }
      if (opts && /^-/.test(x.val)) continue;
      if (/^\d*[<>]/.test(x.val)) { k++; continue; }
      if (unsafeTarget(x.exp)) return x.val;
    }
    return null;
  }
  return null;
}

function scriptBad(script, depth) {
  for (const seg of segments(stripHeredocs(script))) {
    const r = badInSegment(seg, depth);
    if (r) return r;
  }
  return null;
}

// Vráti nebezpečný cieľ `rm` z príkazu, alebo null.
export function badRmTarget(raw) {
  return scriptBad(String(raw), 0);
}

export const MESSAGE =
  "`rm` s cieľom z `$(...)`, spätných apostrofov alebo z premennej bez `:?` zamietnem: poistka Claude Code (dangerousRemoval, " +
  "platí aj v režime bypassPermissions) by sa pýtala človeka a beh by stál na schválení.";

export const POSTUP =
  "cestu najprv vypíš (`cat <súbor>`) a zmaž ju doslovnou cestou (`rm -rf /tmp/x`), alebo zapíš premennú strážene ako `\"${VAR:?}\"`.";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  if (input.tool_name !== "Bash") process.exit(0);
  const bad = badRmTarget(String((input.tool_input || {}).command || ""));
  if (bad) denyTool(`${MESSAGE} Cieľ: ${bad}`, POSTUP);
}
