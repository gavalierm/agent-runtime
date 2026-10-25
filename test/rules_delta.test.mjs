// rules_delta.mjs: prvý prompt len zapíše HEAD, zmena global/ alebo
// env/<prostredie>/ ide do kontextu raz, zmena inde nie, dlhý diff sa skráti.
import "../lib/git_isolate.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { delta, MAX_BYTES } from "../hooks/rules_delta.mjs";

function repo() {
  const root = mkdtempSync(join(tmpdir(), "rd-"));
  const clone = join(root, "clone");
  mkdirSync(join(clone, "global"), { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
  for (const k of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"]) delete env[k];
  const git = (...a) => { const r = spawnSync("git", ["-C", clone, ...a], { encoding: "utf8", env }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  git("init", "-q");
  const commit = (file, text, msg) => { mkdirSync(join(clone, file, ".."), { recursive: true }); writeFileSync(join(clone, file), text); git("add", "-A"); git("commit", "-q", "-m", msg); return git("rev-parse", "HEAD"); };
  commit("global/CLAUDE.md", "v1\n", "prvy");
  return { clone, stateDir: join(root, "state"), commit, git };
}

test("prvý prompt zapíše HEAD bez textu, zmena global ide do kontextu raz", () => {
  const { clone, stateDir, commit } = repo();
  const a = { clone, stateDir, sessionId: "s1", envName: "server" };
  assert.equal(delta(a), null);
  assert.ok(existsSync(join(stateDir, "s1")));
  const head = commit("global/CLAUDE.md", "v2\n", "nove pravidlo");
  const text = delta(a);
  assert.match(text, /^\[pravidlá\] Zmena pravidiel [0-9a-f]{7}\.\.[0-9a-f]{7}\. Platí hneď/);
  assert.match(text, /nove pravidlo/);
  assert.match(text, /\+v2/);
  assert.equal(readFileSync(join(stateDir, "s1"), "utf8").trim(), head);
  assert.equal(delta(a), null, "druhýkrát nič");
  // Iná relácia má vlastný stav.
  assert.equal(delta({ ...a, sessionId: "s2" }), null);
});

test("zmena mimo global a env/<prostredie> text nedá, stav sa posunie", () => {
  const { clone, stateDir, commit } = repo();
  const a = { clone, stateDir, sessionId: "s1", envName: "server" };
  delta(a);
  commit("skills/x/SKILL.md", "x\n", "skill");
  assert.equal(delta(a), null);
  commit("env/mac/CLAUDE.md", "m\n", "mac");
  assert.equal(delta(a), null, "iné prostredie");
  commit("env/server/CLAUDE.md", "s\n", "server");
  const text = delta(a);
  assert.match(text, /\+s$/m);
  assert.doesNotMatch(text, /skill/);
  assert.equal(delta({ ...a, envName: "mac", sessionId: "m1" }), null);
});

test("dlhý diff sa skráti na strop, zlé id relácie nerobí nič", () => {
  const { clone, stateDir, commit } = repo();
  const a = { clone, stateDir, sessionId: "s1", envName: "server" };
  delta(a);
  commit("global/CLAUDE.md", "x".repeat(30_000) + "\n", "velke");
  const text = delta(a);
  assert.ok(Buffer.byteLength(text) < MAX_BYTES + 300);
  assert.match(text, /\[skrátené, celý diff: git -C /);
  assert.equal(delta({ ...a, sessionId: "../zle" }), null);
  assert.equal(delta({ ...a, sessionId: "" }), null);
});
