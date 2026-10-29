#!/usr/bin/env node
// requires: none
// secret_read.mjs — tajomstvo sa nevypisuje na obrazovku. Čo príkaz Bash vypíše,
// ide do prepisu relácie a do databázy T3 a tam ostane. Chyba 23. 10. 2026
// (úloha 449): dvaja agenti vypísali dlhodobý token Claude (`claude setup-token`
// a obsah súboru s tokenom) do prepisu a do databázy T3. Pravidlo v persone
// nestačilo (global §4), preto hook.
//
// PreToolUse pre Bash. Zamietne dve veci.
//  a) Program, ktorý vypíše obsah súboru (`cat`, `head`, `tail`, `less`, `more`,
//     `bat`, `tac`, `nl`, `od`, `hexdump`, `xxd`, `strings`, `base64`, `cut`,
//     `sed` bez -i, `grep`, `awk`, `find -exec cat`, `python -c ... open(`,
//     `node -e ... readFile`), a súbor je tajomstvo: cesta pod `~/.config/`,
//     `/root/.config/`, `/home/<x>/.config/` alebo `.ssh/` (súkromný kľúč), alebo
//     meno súboru je `runtime.env`, končí na `.env` či začína `.env`, obsahuje
//     `token`, `secret`, `credential` (nie pri zdrojových a dokumentačných
//     príponách .mjs .js .ts .css .md .html .py .sh a podobne), `.pem`, alebo je
//     to `id_ed25519` či `id_rsa` bez `.pub`.
//  b) `claude setup-token` spustené priamo (len cez `setup_token.sh`).
// Prejde: ls, stat, test, [ -f, chmod, chown, wc, md5sum, sha256sum, file, source,
// priradenie `X=$(cat f)`, `read x < f`, `grep -c/-l/-L/-q`, rúra do wc alebo
// kontrolného súčtu, presmerovanie výstupu do súboru, kľúče `.pub`, settings.json
// a cesta v texte (echo, heredoc, komentár, správa commitu).
// Rozbor príkazu: lib/shell_cmd.mjs. Test: hooks/secret_read.test.mjs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, posix } from "node:path";
import { workflowDir } from "../lib/paths.mjs";
import { simpleCommands, base } from "../lib/shell_cmd.mjs";
import { parseSed } from "./sed_line.mjs";
import { denyTool } from "../lib/deny.mjs";

const HOME_ROOT = String.raw`(?:~|\$HOME|\$\{HOME\}|/root|/home/[^/]+|/Users/[^/]+)`;
const UNDER_CONFIG = new RegExp(`^${HOME_ROOT}/\\.config(?:/|$)`);
const UNDER_SSH = new RegExp(`^${HOME_ROOT}/\\.ssh/(.+)$`);
const SSH_PUBLIC = new Set(["known_hosts", "known_hosts.old", "config", "authorized_keys"]);
// Zdrojové a dokumentačné súbory: meno so slovom token či secret nie je tajomstvo
// (hooks/secret_read.mjs, tokens.css, docs/token-audit.html).
const SOURCE_EXT = /\.(?:mjs|cjs|js|jsx|ts|tsx|css|scss|less|md|html|htm|py|sh|php|vue|svelte|go|rs|java|rb|yml|yaml|toml|tsv|lock|svg)$/i;
const ENV_SAMPLE = /\.(?:example|sample|dist|template|tpl)$/i;
const KEYS = /^id_(?:ed25519|rsa|ecdsa|dsa)/;

// Je cesta tajomstvo? Vráti dôvod alebo null.
export function secretReason(path) {
  const p = String(path);
  if (!p || /^-/.test(p)) return null;
  const name = posix.basename(p.replace(/\/+$/, ""));
  if (name === "settings.json" || name === "settings.local.json") return null;
  if (/\.pub$/.test(name)) return null;
  if (UNDER_CONFIG.test(p)) return "cesta pod .config";
  const ssh = UNDER_SSH.exec(p);
  if (ssh && !SSH_PUBLIC.has(posix.basename(ssh[1]))) return "súkromný kľúč v .ssh";
  if (name === "runtime.env" || /\.env$/.test(name) || name.startsWith(".env")) return ENV_SAMPLE.test(name) ? null : "súbor env";
  if (KEYS.test(name)) return "súkromný kľúč";
  if (name.includes(".pem")) return "súbor .pem";
  if (/token|secret|credential/i.test(name) && !SOURCE_EXT.test(name)) return "meno súboru nesie token, secret alebo credential";
  return null;
}

const PRINTERS = new Set(["cat", "head", "tail", "less", "more", "bat", "batcat", "tac", "nl", "od", "hexdump", "xxd", "strings", "base64", "cut", "rev", "sed", "grep", "egrep", "fgrep", "rg", "awk", "gawk", "mawk"]);
const GREP = new Set(["grep", "egrep", "fgrep", "rg"]);
const AWK = new Set(["awk", "gawk", "mawk"]);
// Voľby, ktorých hodnota je v ďalšom argumente (nie je to súbor na výpis).
const VALUE_OPTS = {
  head: ["-n", "-c", "--lines", "--bytes"],
  tail: ["-n", "-c", "--lines", "--bytes", "-s", "--sleep-interval", "--pid"],
  cut: ["-d", "-f", "-c", "-b", "--delimiter", "--fields", "--characters", "--bytes"],
  od: ["-A", "-t", "-N", "-j", "-w"],
  xxd: ["-l", "-s", "-c", "-g", "-o"],
  strings: ["-n", "-t", "-e"],
  base64: ["-w", "--wrap"],
  bat: ["-l", "--language", "--style", "--theme", "--color", "-r", "--line-range"],
  grep: ["-m", "-A", "-B", "-C", "--max-count", "--after-context", "--before-context", "--context", "--include", "--exclude", "--exclude-dir", "--color", "-d", "-D", "--binary-files"],
  awk: ["-F", "-v", "--field-separator", "--assign"],
  nl: ["-b", "-d", "-f", "-h", "-i", "-l", "-n", "-s", "-v", "-w"],
  hexdump: ["-n", "-s", "-e", "-f"],
};
// Za rúrou sa obsah len spočíta alebo odošle, na obrazovku nejde.
const CONSUMERS = new Set(["wc", "md5sum", "sha1sum", "sha256sum", "sha512sum", "b2sum", "cksum", "curl", "wget", "nc", "ncat", "openssl", "gpg", "ssh", "scp"]);
const SKIP_EXTRACT = new Set(["c", "l", "L", "q"]);

// Súbory, ktorých obsah príkaz vypíše: [{ path }]. Pole prázdne, keď nič nevypisuje.
function printedFiles(it) {
  const h = it.head;
  const vals = it.args.map((a) => a.val);
  const files = [...it.stdin];
  if (h === "sed") {
    const s = parseSed(it.args);
    if (s.inplace) return [];
    return [...files, ...s.files];
  }
  if (GREP.has(h)) {
    for (const v of vals) {
      if (/^--(count|files-with-matches|files-without-match|quiet|silent)$/.test(v)) return [];
      if (/^-[A-Za-z]+$/.test(v) && [...v.slice(1)].some((c) => SKIP_EXTRACT.has(c))) return [];
    }
  }
  const valOpts = new Set(VALUE_OPTS[GREP.has(h) ? "grep" : AWK.has(h) ? "awk" : h] || []);
  let pattern = !(GREP.has(h) || AWK.has(h)); // true = vzor či program už je za nami
  const out = [...files];
  for (let k = 0; k < vals.length; k++) {
    const v = vals[k];
    if (v === "--") { for (k++; k < vals.length; k++) { if (!pattern) pattern = true; else out.push(vals[k]); } break; }
    if (/^-./.test(v)) {
      if ((GREP.has(h) && (v === "-e" || v === "--regexp" || v === "-f" || v === "--file")) || (AWK.has(h) && v === "-f")) { pattern = true; k++; continue; }
      if (valOpts.has(v)) k++;
      continue;
    }
    if (!pattern) { pattern = true; continue; }
    out.push(v);
  }
  return out;
}

// Reťazcové literály skriptu python alebo node.
function literals(script) {
  return [...script.matchAll(/(['"])((?:\\.|(?!\1)[^\\])*)\1/g)].map((m) => m[2]);
}

// Vráti { path, why, head } pre prvý vypísaný súbor, ktorý je tajomstvo, alebo
// { setupToken: true }, alebo null.
export function secretOutput(raw) {
  let cwd = null;
  const abs = (p) => {
    if (cwd && !/^([~/$])/.test(p)) return posix.join(cwd, p);
    return p;
  };
  for (const it of simpleCommands(raw)) {
    if (it.head === "cd" || it.head === "pushd") {
      const t = it.args.map((a) => a.val).find((v) => !v.startsWith("-"));
      cwd = t === undefined ? null : abs(t);
      continue;
    }
    if (it.head === "claude") {
      const first = it.args.map((a) => a.val).find((v) => !v.startsWith("-"));
      if (first === "setup-token") return { setupToken: true };
      continue;
    }
    if (/^python[\d.]*$/.test(it.head) || it.head === "node" || it.head === "nodejs") {
      if (it.captured || it.stdoutFile) continue;
      const vals = it.args.map((a) => a.val);
      const k = vals.findIndex((v) => (it.head.startsWith("python") ? v === "-c" : v === "-e" || v === "-p" || v === "--eval" || v === "--print"));
      if (k < 0 || vals[k + 1] === undefined) continue;
      const script = vals[k + 1];
      const reads = it.head.startsWith("python") ? /\bopen\s*\(|read_text|read_bytes/.test(script) : /readFile|createReadStream/.test(script);
      if (!reads) continue;
      for (const lit of literals(script)) {
        const why = secretReason(abs(lit));
        if (why) return { path: lit, why, head: it.head };
      }
      continue;
    }
    if (it.head === "find") {
      const vals = it.args.map((a) => a.val);
      const e = vals.findIndex((v) => /^-(?:exec|execdir|ok|okdir)$/.test(v));
      if (e >= 0 && PRINTERS.has(base(vals[e + 1] || "")) && !it.captured && !it.stdoutFile) {
        const roots = [];
        for (const v of vals) { if (v.startsWith("-") || v === "(" || v === "!") break; roots.push(v); }
        for (const r of roots) {
          const why = secretReason(abs(r));
          if (why) return { path: r, why, head: "find -exec " + vals[e + 1] };
        }
      }
      continue;
    }
    if (!PRINTERS.has(it.head)) continue;
    if (it.captured || it.stdoutFile) continue;
    if (it.pipeNext && CONSUMERS.has(it.pipeNext)) continue;
    for (const f of printedFiles(it)) {
      const why = secretReason(abs(f));
      if (why) return { path: f, why, head: it.head };
    }
  }
  return null;
}

export const MESSAGE =
  "Tajomstvo sa nevypisuje: čo príkaz vypíše, ide do prepisu relácie a do databázy T3 a tam ostane " +
  "(chyba 23. 10. 2026, úloha 449: dlhodobý token Claude vypísaný do prepisu aj do databázy T3).";

export const POSTUP =
  "tajomstvo nikdy nevypisuj: použi ho priradením do premennej (`T=$(cat <súbor>)`) alebo skriptom (`" + join(workflowDir(), "setup_token.sh") + "`), " +
  "existenciu over `test -f <súbor>` a práva `stat -c %a <súbor>`.";

export const SETUP_MESSAGE =
  "`claude setup-token` vypíše dlhodobý token na obrazovku a odtiaľ ide do prepisu relácie a do databázy T3 " +
  "(chyba 23. 10. 2026, úloha 449).";

export const SETUP_POSTUP =
  "token vymieňaj skriptom `" + join(workflowDir(), "setup_token.sh") + "` (start vypíše odkaz, finish zapíše token do súboru env bez výpisu), " +
  "obrazovku ani súbor s tokenom nevypisuj.";

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  if (input.tool_name !== "Bash") process.exit(0);
  const r = secretOutput(String((input.tool_input || {}).command || ""));
  if (!r) process.exit(0);
  if (r.setupToken) denyTool(SETUP_MESSAGE, SETUP_POSTUP);
  else denyTool(`${MESSAGE} Súbor: ${r.path} (${r.why}, príkaz ${r.head}).`, POSTUP);
}
