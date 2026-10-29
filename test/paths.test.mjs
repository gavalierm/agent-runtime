// Test lib/paths.mjs a lib/paths.sh: obe knižnice dávajú rovnaké cesty.
// Spustenie: node --test test/paths.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { brainGlobalDir, decisionsDir, workflowDir } from "../lib/paths.mjs";

const SH = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "paths.sh");

test("workflowDir: premenná, Mac, server", () => {
  assert.equal(workflowDir({ AGENT_WORKFLOW: "/x/wf" }, "linux"), "/x/wf");
  assert.equal(workflowDir({ AGENT_WORKFLOW: "/x/wf", HOME: "/Users/m" }, "darwin"), "/x/wf");
  assert.equal(workflowDir({ HOME: "/Users/m" }, "darwin"), "/Users/m/Work/agentic-workflow");
  assert.equal(workflowDir({}, "linux"), "/opt/agentic-workflow");
});

test("brainGlobalDir: premenná, Mac, server", () => {
  assert.equal(brainGlobalDir({ AGENT_BRAIN_GLOBAL: "/x/bg" }, "linux"), "/x/bg");
  assert.equal(brainGlobalDir({ HOME: "/Users/m" }, "darwin"), "/Users/m/Work/agentic-brain-global");
  assert.equal(brainGlobalDir({}, "linux"), "/opt/agentic-brain-global");
});

test("decisionsDir: decisions v spoločnom mozgu", () => {
  assert.equal(decisionsDir({ AGENT_BRAIN_GLOBAL: "/x/bg" }, "linux"), "/x/bg/decisions");
  assert.equal(decisionsDir({}, "linux"), "/opt/agentic-brain-global/decisions");
  assert.equal(decisionsDir({ HOME: "/Users/m" }, "darwin"), "/Users/m/Work/agentic-brain-global/decisions");
});

// Shell: prázdne prostredie bez premenných, výstup funkcie sa porovná s mjs na tomto stroji.
const sh = (fn, env) => spawnSync("bash", ["-c", `. "${SH}"; ${fn}`], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });

test("paths.sh dáva rovnaké cesty ako paths.mjs", () => {
  const mac = process.platform === "darwin";
  const env = { HOME: "/home/test" };
  assert.equal(sh("workflow_dir", env).stdout, workflowDir(env, process.platform));
  assert.equal(sh("brain_global_dir", env).stdout, brainGlobalDir(env, process.platform));
  assert.equal(sh("decisions_dir", env).stdout, decisionsDir(env, process.platform));
  assert.equal(sh("workflow_dir", env).stdout, mac ? "/home/test/Work/agentic-workflow" : "/opt/agentic-workflow");
});

test("paths.sh: premenné prekryjú predvolené cesty", () => {
  const env = { AGENT_WORKFLOW: "/x/wf", AGENT_BRAIN_GLOBAL: "/x/bg" };
  assert.equal(sh("workflow_dir", env).stdout, "/x/wf");
  assert.equal(sh("brain_global_dir", env).stdout, "/x/bg");
  assert.equal(sh("decisions_dir", env).stdout, "/x/bg/decisions");
});
