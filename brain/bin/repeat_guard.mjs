#!/usr/bin/env node
// PreToolUse hook for Bash in Claude Code. It rejects the third different manual
// run of the same program in one session: a mechanical step belongs in a script.
//
// The input on stdin is JSON with `session_id` and `tool_input.command`.
// Exit code 0 allows the command, exit code 2 rejects it and the agent gets stderr.
// On any error (bad input, unreadable state) it exits with code 0,
// so the hook never blocks a command by mistake.
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const LIMIT = 3;
const KEYWORDS_SKIP_SEGMENT = new Set(["for", "case", "function", "done", "fi", "esac", "select"]);
const KEYWORDS_STRIP = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{", "(", "time"]);
const EXEMPT = [/(^|\/)agentic-brain\/bin\//, /(^|\/)skills\/[^/]+\/scripts\//];

// Splits a command into segments at unquoted &&, ||, ;, |, & and newlines.
export function splitSegments(cmd) {
  const out = [];
  let cur = "";
  let q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (q) {
      cur += c;
      if (c === "\\" && q === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else if (c === q) q = null;
      continue;
    }
    if (c === "\\" && i + 1 < cmd.length) { cur += c + cmd[++i]; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (c === "&" && (cmd[i - 1] === ">" || cmd[i - 1] === "<" || cmd[i + 1] === ">")) { cur += c; continue; }
    if (c === ";" || c === "|" || c === "&" || c === "\n") {
      if ((c === "|" || c === "&") && cmd[i + 1] === c) i++;
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// Splits a segment into words, quotes stay in the word.
export function splitWords(seg) {
  const words = [];
  let cur = "";
  let q = null;
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (q) {
      cur += c;
      if (c === "\\" && q === '"' && i + 1 < seg.length) cur += seg[++i];
      else if (c === q) q = null;
      continue;
    }
    if (c === "\\" && i + 1 < seg.length) { cur += c + seg[++i]; continue; }
    if (c === "'" || c === '"') { q = c; cur += c; continue; }
    if (/\s/.test(c)) { if (cur) words.push(cur); cur = ""; continue; }
    cur += c;
  }
  if (cur) words.push(cur);
  return words;
}

const SUDO_WITH_VALUE = new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U"]);

// Returns { program, args, exempt } or null when the segment is not a command.
export function parseSegment(seg) {
  let w = splitWords(seg);
  for (;;) {
    if (!w.length) return null;
    const first = w[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first)) { w = w.slice(1); continue; }
    if (first === "sudo") {
      w = w.slice(1);
      while (w.length && w[0].startsWith("-")) w = SUDO_WITH_VALUE.has(w[0]) ? w.slice(2) : w.slice(1);
      continue;
    }
    if (KEYWORDS_STRIP.has(first)) { w = w.slice(1); continue; }
    if (first.length > 1 && /^[({]/.test(first)) { w[0] = first.slice(1); continue; }
    if (KEYWORDS_SKIP_SEGMENT.has(first)) return null;
    break;
  }
  const prog = w[0].replace(/^["']|["']$/g, "");
  const exempt = w.some((t) => !t.includes("://") && EXEMPT.some((re) => re.test(t.replace(/^["']|["']$/g, ""))));
  return { program: basename(prog), args: w.slice(1).join(" "), exempt };
}

export function loadAllow(file) {
  return new Set(
    readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")),
  );
}

// Returns { blocked: program|null, state } for a command and the state so far.
export function evaluate(command, state, allow) {
  const next = {};
  for (const [k, v] of Object.entries(state)) next[k] = [...v];
  for (const seg of splitSegments(command)) {
    const p = parseSegment(seg);
    if (!p || p.exempt || allow.has(p.program)) continue;
    const seen = (next[p.program] ||= []);
    if (seen.includes(p.args)) continue;
    if (seen.length + 1 >= LIMIT) return { blocked: p.program, state };
    seen.push(p.args);
  }
  return { blocked: null, state: next };
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return 0;
  }
  const command = input?.tool_input?.command;
  if (typeof command !== "string" || !command.trim()) return 0;
  const sid = String(input.session_id ?? "no-session").replace(/[^A-Za-z0-9_-]/g, "_");
  const stateFile = join(tmpdir(), `agentic-brain-repeat-${sid}.json`);
  let state = {};
  try { state = JSON.parse(readFileSync(stateFile, "utf8")); } catch { state = {}; }
  if (!state || typeof state !== "object" || Array.isArray(state)) state = {};
  const allow = loadAllow(fileURLToPath(new URL("./repeat_guard.allow", import.meta.url)));
  const res = evaluate(command, state, allow);
  if (res.blocked) {
    console.error(
      `The third manual run of \`${res.blocked}\` in this session is a mechanical step and belongs in a script in ` +
        "`agentic-brain/skills/<name>/scripts/`. Write it and run it.",
    );
    return 2;
  }
  try { writeFileSync(stateFile, JSON.stringify(res.state)); } catch { /* the state is only a helper */ }
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let code = 0;
  try { code = main(); } catch { code = 0; }
  process.exit(code);
}
