// rules_delta.mjs: prvý prompt len zapíše HEAD, zmena sledovanej cesty
// (RULES.md, env/<prostredie>/) ide do kontextu raz, zmena inde nie, dlhý diff sa skráti.
import "../lib/git_isolate.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync as mkdtempRaw, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { delta, MAX_BYTES } from "../hooks/rules_delta.mjs";

// Dočasné priečinky testu sa na konci zmažú (úloha 701).
const tmpDirs = [];
const mkdtempSync = (prefix) => { const d = mkdtempRaw(prefix); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

function repo() {
  const root = mkdtempSync(join(tmpdir(), "rd-"));
  const clone = join(root, "clone");
  mkdirSync(clone, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  for (const k of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"]) delete env[k];
  const git = (...a) => { const r = spawnSync("git", ["-C", clone, ...a], { encoding: "utf8", env }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git("init", "-q");
  const commit = (file, text, msg) => { mkdirSync(join(clone, file, ".."), { recursive: true }); writeFileSync(join(clone, file), text); git("add", "-A"); git("commit", "-q", "-m", msg); return git("rev-parse", "HEAD"); };
  commit("RULES.md", "v1\n", "prvy");
  return { clone, stateDir: join(root, "state"), commit, git };
}

test("prvý prompt zapíše HEAD bez textu, zmena RULES.md ide do kontextu raz", () => {
  const { clone, stateDir, commit } = repo();
  const a = { clone, stateDir, sessionId: "s1", paths: ["RULES.md", "env/server/"] };
  assert.equal(delta(a), null);
  assert.ok(existsSync(join(stateDir, "s1")));
  const head = commit("RULES.md", "v2\n", "nove pravidlo");
  const text = delta(a);
  assert.match(text, /^\[pravidlá\] Zmena pravidiel [0-9a-f]{7}\.\.[0-9a-f]{7}\. Platí hneď/);
  assert.match(text, /nove pravidlo/);
  assert.match(text, /\+v2/);
  assert.equal(readFileSync(join(stateDir, "s1"), "utf8").trim(), head);
  assert.equal(delta(a), null, "druhýkrát nič");
  // Iná relácia má vlastný stav.
  assert.equal(delta({ ...a, sessionId: "s2" }), null);
});

test("zmena mimo RULES.md a env/<prostredie> text nedá, stav sa posunie", () => {
  const { clone, stateDir, commit } = repo();
  const a = { clone, stateDir, sessionId: "s1", paths: ["RULES.md", "env/server/"] };
  delta(a);
  commit("skills/x/SKILL.md", "x\n", "skill");
  assert.equal(delta(a), null);
  commit("env/mac/RULES.md", "m\n", "mac");
  assert.equal(delta(a), null, "iné prostredie");
  commit("env/server/RULES.md", "s\n", "server");
  const text = delta(a);
  assert.match(text, /\+s$/m);
  assert.doesNotMatch(text, /skill/);
  assert.equal(delta({ ...a, paths: ["RULES.md", "env/mac/"], sessionId: "m1" }), null);
});

test("dlhý diff sa skráti na strop, zlé id relácie nerobí nič", () => {
  const { clone, stateDir, commit } = repo();
  const a = { clone, stateDir, sessionId: "s1", paths: ["RULES.md", "env/server/"] };
  delta(a);
  commit("RULES.md", "x".repeat(30_000) + "\n", "velke");
  const text = delta(a);
  assert.ok(Buffer.byteLength(text) < MAX_BYTES + 300);
  assert.match(text, /\[skrátené, celý diff: git -C /);
  assert.equal(delta({ ...a, sessionId: "../zle" }), null);
  assert.equal(delta({ ...a, sessionId: "" }), null);
});

test("hook: sleduje RULES.md klonu kódu a RULES.md a env/<prostredie>/ mozgu, nie env/ klonu kódu", () => {
  const code = repo();
  const brain = repo();
  const state = join(mkdtempSync(join(tmpdir(), "rd-st-")), "state");
  const home = mkdtempSync(join(tmpdir(), "rd-home-"));
  const env = { ...process.env, HOME: home, AR_STATE: state, AGENT_WORKFLOW: code.clone, AGENT_BRAIN_GLOBAL: brain.clone, AR_ENV: "server" };
  delete env.AR_ROZHODNUTIA;
  const prompt = () => {
    const r = spawnSync("node", [join(import.meta.dirname, "..", "hooks", "rules_delta.mjs")], { input: JSON.stringify({ session_id: "h1" }), encoding: "utf8", env });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.additionalContext : "";
  };
  assert.equal(prompt(), "");
  code.commit("RULES.md", "kod v2\n", "zmena pravidiel kodu");
  assert.match(prompt(), /zmena pravidiel kodu/);
  assert.equal(prompt(), "");
  brain.commit("RULES.md", "mozog v2\n", "zmena pravidiel mozgu");
  assert.match(prompt(), /zmena pravidiel mozgu/);
  brain.commit("env/server/RULES.md", "s\n", "zmena servera v mozgu");
  assert.match(prompt(), /zmena servera v mozgu/);
  brain.commit("env/mac/RULES.md", "m\n", "zmena macu v mozgu");
  assert.equal(prompt(), "");
  code.commit("env/server/install.sh", "#!/bin/sh\n", "kod prostredia");
  assert.equal(prompt(), "");
});
