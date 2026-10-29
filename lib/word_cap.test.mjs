#!/usr/bin/env node
// Test lib/word_cap.mjs v dočasnom repe: pod stropom prejde, nad stropom,
// zvýšený strop v pracovnej kópii a zvýšený strop v histórii zlyhajú.

import "./git_isolate.mjs";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wordCapProblems } from "./word_cap.mjs";

const dir = mkdtempSync(join(tmpdir(), "word-cap-"));
const git = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "ignore" });
const put = (f, t) => writeFileSync(join(dir, f), t);
let fail = 0;
const expect = (name, ok) => {
  const p = wordCapProblems(dir);
  const pass = ok ? p.length === 0 : p.length > 0;
  if (!pass) fail++;
  console.log(`${pass ? "✓" : "✗"} ${name}${p.length ? `: ${p.join("; ")}` : ""}`);
};
try {
  mkdirSync(join(dir, "global"));
  mkdirSync(join(dir, "lib"));
  git("init", "-q");
  put("global/CLAUDE.md", "jedna dva tri");
  put("lib/global_word_cap.txt", "5\n");
  git("add", ".");
  git("commit", "-qm", "a");
  expect("pod stropom", true);
  put("global/CLAUDE.md", "jedna dva tri štyri päť šesť");
  expect("nad stropom", false);
  put("lib/global_word_cap.txt", "6\n");
  expect("zvýšený strop v pracovnej kópii", false);
  git("commit", "-qam", "b");
  expect("zvýšený strop v histórii", false);
  git("reset", "-q", "--hard", "HEAD~1");
  put("global/CLAUDE.md", "jedna dva");
  put("lib/global_word_cap.txt", "3\n");
  git("commit", "-qam", "c");
  expect("znížený strop", true);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
