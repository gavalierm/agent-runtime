// Test env/hooks.mjs: tabuľka sedí s hooks/, výsledok pre každý druh nesie dnešné
// hooky (zoznam z dnešných zápisov install.sh a env/mac/settings.json),
// zlúčenie nahradí naše skupiny a cudzie nechá, druhý beh nič nezmení.
// Test píše len do mktemp, žiadny živý settings.json.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TABLE, HELPERS, applySettings, driftProblems, hooksFor, isOurs, mergeSettings, settingsFor, tableProblems, withBase } from "./hooks.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS = "/w/hooks";
const WF = "/w";

// Zoznam "udalosť|matcher|timeout|súbor" v poradí zápisu.
const flat = (hooks) =>
  Object.entries(hooks).flatMap(([ev, groups]) => groups.flatMap((g) => g.hooks.map((h) => `${ev}|${g.matcher ?? ""}|${h.timeout ?? ""}|${h.command.replace(/^node "?/, "").replace(/"?( .*)?$/, "").split("/").pop()}`)));
const byEvent = (list) => {
  const out = {};
  for (const l of list) (out[l.split("|")[0]] ??= []).push(l);
  return out;
};

const MAIN = `SessionStart|||unslop.mjs
SessionStart|||identity.mjs
SessionStart|||memory_context.mjs
SessionStart|||clear_bridge.mjs
SessionStart|||rozhodnutia_context.mjs
UserPromptSubmit|||context_warning.mjs
UserPromptSubmit|||agreement_scope.mjs
UserPromptSubmit|||rules_delta.mjs
UserPromptSubmit|||tasker_work.mjs
PreToolUse|Bash||no_model_wait.mjs
PreToolUse|Bash||foreign_git.mjs
PreToolUse|Bash||git_pull.mjs
PreToolUse|Bash||tasker_root.mjs
PreToolUse|Bash||web_review.mjs
PreToolUse|Bash||human_question.mjs
PreToolUse|Bash||own_mechanism.mjs
PreToolUse|Bash||task_title.mjs
PreToolUse|Bash||task_concurrency.mjs
PreToolUse|Bash||project_branch.mjs
PreToolUse|Bash||tool_failure_block.mjs
PreToolUse|Bash||rm_target.mjs
PreToolUse|Bash||sed_line.mjs
PreToolUse|Bash||secret_read.mjs
PreToolUse|Bash||agreement_send.mjs
PreToolUse|^(Edit|Write|MultiEdit|NotebookEdit|Bash)$||deploy_readonly.mjs
PreToolUse|^(Bash|Monitor)$|3|subagent_foreground.mjs
PreToolUse|^(Bash|Edit|Write|MultiEdit|NotebookEdit)$|3|sonnet_delegation.mjs
PreToolUse|Bash|3|no_retest.mjs
PreToolUse|^(Write|Edit|MultiEdit|NotebookEdit|Bash)$||rozhodnutia_guard.mjs
PreToolUse|^(Write|Edit|MultiEdit|Bash)$||own_rule_scope.mjs
PreToolUse|^(Agent|Task)$|3|tasker_work.mjs
PreToolUse|^(Agent|Task)$|3|implementator_model.mjs
PreToolUse|^(Bash|Edit|Write|MultiEdit|NotebookEdit)$|10|tasker_work.mjs
Stop|||reply_guard.mjs
Stop|||todo_after_comment.mjs
Stop|||done_related.mjs
Stop|||objection_fix.mjs
Stop||10|tool_failure_report.mjs
Stop||5|dokonci_open.mjs
SubagentStop||3|tasker_work.mjs
SubagentStop||10|tool_failure_report.mjs
PostToolUseFailure|Bash|5|tool_failure_log.mjs
PreCompact||3|compact_block.mjs`.split("\n");

const RUNS = `Stop||10|tool_failure_report.mjs
Stop||5|dokonci_open.mjs
SubagentStop||10|tool_failure_report.mjs
PreToolUse|Bash||own_mechanism.mjs
PreToolUse|Bash||task_title.mjs
PreToolUse|Bash||task_concurrency.mjs
PreToolUse|Bash||project_branch.mjs
PreToolUse|Bash||tool_failure_block.mjs
PreToolUse|Bash||rm_target.mjs
PreToolUse|Bash||sed_line.mjs
PreToolUse|Bash||secret_read.mjs
PreToolUse|^(Edit|Write|MultiEdit|NotebookEdit|Bash)$||deploy_readonly.mjs
PostToolUseFailure|Bash|5|tool_failure_log.mjs
PreCompact||3|compact_block.mjs`.split("\n");

const MAC = `SessionStart|||check.mjs
SessionStart|||unslop.mjs
SessionStart|||rozhodnutia_context.mjs
PreToolUse|^(Write|Edit|MultiEdit|NotebookEdit|Bash)$||guard.mjs
PreToolUse|Bash||no_model_wait.mjs
PreToolUse|Bash||git_pull.mjs
PreToolUse|Bash||sed_line.mjs
PreToolUse|Bash||secret_read.mjs
PreToolUse|Bash||agreement_send.mjs
PreToolUse|^(Write|Edit|MultiEdit|NotebookEdit|Bash)$||rozhodnutia_guard.mjs
PreToolUse|^(Write|Edit|MultiEdit|Bash)$||own_rule_scope.mjs
PreToolUse|^(Agent|Task)$|3|tasker_work.mjs
SubagentStop||3|tasker_work.mjs
Stop|||reply_guard.mjs
Stop|||todo_after_comment.mjs
Stop|||objection_fix.mjs
UserPromptSubmit|||agreement_scope.mjs
UserPromptSubmit|||rules_delta.mjs
PreCompact||3|compact_block.mjs`.split("\n");

test("main: dnešných 43 hookov rootu, po udalostiach v dnešnom poradí", () => {
  const got = flat(hooksFor("main", HOOKS, WF));
  assert.equal(got.length, 43);
  assert.deepEqual(byEvent(got), byEvent(MAIN));
});

test("runs: dnešných 14 hookov používateľa behov", () => {
  const got = flat(hooksFor("runs", HOOKS, WF));
  assert.equal(got.length, 14);
  assert.deepEqual(byEvent(got), byEvent(RUNS));
});

test("mac: dnešných 19 hookov Macu", () => {
  const got = flat(hooksFor("mac", HOOKS, WF, { home: "/Users/x" }));
  assert.equal(got.length, 19);
  assert.deepEqual(byEvent(got), byEvent(MAC));
});

test("skupiny: Bash hooky rootu sú v jednej skupine, tasker_work s iným timeoutom v inej", () => {
  const pre = hooksFor("main", HOOKS, WF).PreToolUse;
  assert.equal(pre[0].matcher, "Bash");
  assert.equal(pre[0].hooks.length, 15);
  const tw = pre.filter((g) => g.hooks.some((h) => h.command.endsWith("/tasker_work.mjs")));
  assert.deepEqual(tw.map((g) => [g.matcher, g.hooks.find((h) => h.command.endsWith("/tasker_work.mjs")).timeout]), [["^(Agent|Task)$", 3], ["^(Bash|Edit|Write|MultiEdit|NotebookEdit)$", 10]]);
});

test("Mac: cesta pod domovom je v úvodzovkách s $HOME, check.mjs ide z koreňa klonu s --quiet", () => {
  const h = hooksFor("mac", "/Users/x/Work/wf/hooks", "/Users/x/Work/wf", { home: "/Users/x" });
  const cmds = Object.values(h).flatMap((gs) => gs.flatMap((g) => g.hooks.map((x) => x.command)));
  assert.ok(cmds.includes('node "$HOME/Work/wf/check.mjs" --quiet'));
  assert.ok(cmds.includes('node "$HOME/Work/wf/hooks/unslop.mjs"'));
  const main = hooksFor("main", "/opt/wf/hooks", "/opt/wf");
  assert.ok(Object.values(main).flatMap((gs) => gs.flatMap((g) => g.hooks.map((x) => x.command))).includes("node /opt/wf/hooks/unslop.mjs"));
});

test("kľúče: main a mac nesú compact, attribution, output style a AR_ROZHODNUTIA, runs len compact a štýl", () => {
  for (const k of ["main", "mac"]) {
    const s = settingsFor(k, HOOKS, WF);
    assert.equal(s.autoCompactEnabled, false);
    assert.equal(s.outputStyle, "operator");
    assert.deepEqual(s.attribution, { commit: "", pr: "", sessionUrl: false });
    assert.equal(s.env.AR_ROZHODNUTIA, "1");
  }
  const r = settingsFor("runs", HOOKS, WF);
  assert.equal(r.autoCompactEnabled, false);
  assert.equal(r.outputStyle, "operator");
  assert.equal(r.attribution, undefined);
  assert.equal(r.env, undefined);
  assert.throws(() => settingsFor("x", HOOKS, WF));
});

test("zlúčenie: nahradí naše skupiny zo starej cesty, cudzie hooky a kľúče ostanú, druhý beh nič nezmení", () => {
  const old = {
    model: "x",
    permissions: { deny: ["Bash(mkfs *)"] },
    env: { INE: "1" },
    hooks: {
      SessionStart: [
        { hooks: [{ type: "command", command: "iny" }] },
        { hooks: [{ type: "command", command: "node /opt/stary/hooks/unslop.mjs" }] },
      ],
      Stop: [{ hooks: [{ type: "command", command: "node /opt/stary/hooks/reply_guard.mjs" }] }, { hooks: [{ type: "command", command: 'node "$HOME/x/hooks/tool_failure_report.mjs"' }] }],
      Notification: [{ hooks: [{ type: "command", command: "node /opt/stary/hooks/compact_block.mjs" }] }],
    },
  };
  const a = mergeSettings(old, "main", HOOKS, WF);
  const cmds = JSON.stringify(a.hooks);
  assert.ok(!cmds.includes("/opt/stary/"), "stará cesta zmizla");
  assert.ok(cmds.includes('"iny"'), "cudzí hook ostal");
  assert.equal(a.model, "x");
  assert.deepEqual(a.permissions, old.permissions);
  assert.deepEqual(a.env, { INE: "1", AR_ROZHODNUTIA: "1" });
  assert.equal(a.hooks.Notification, undefined, "prázdna udalosť sa zmaže");
  assert.equal(a.hooks.SessionStart.filter((g) => g.hooks[0].command === "iny").length, 1);
  assert.equal(flat(a.hooks).filter((l) => l.endsWith("|tool_failure_report.mjs")).length, 2, "tool_failure_report raz v Stop, raz v SubagentStop");
  const b = mergeSettings(a, "main", HOOKS, WF);
  assert.deepEqual(b, a);
  assert.deepEqual(driftProblems(a, "main", HOOKS, WF), []);
  assert.equal(driftProblems(old, "main", HOOKS, WF).length, 1);
});

test("isOurs pozná naše príkazy v oboch tvaroch a cudzie nie", () => {
  assert.ok(isOurs("node /opt/x/hooks/unslop.mjs"));
  assert.ok(isOurs('node "$HOME/Work/x/hooks/unslop.mjs"'));
  assert.ok(isOurs('node "$HOME/Work/x/check.mjs" --quiet'));
  assert.ok(!isOurs("node /opt/x/hooks/neznamy.mjs"));
  assert.ok(!isOurs("iny"));
  assert.ok(!isOurs("node /x/check.mjs"));
});

test("applySettings píše do súboru a base dopĺňa len chýbajúce kľúče", () => {
  const dir = mkdtempSync(join(tmpdir(), "hooks-test-"));
  try {
    const p = join(dir, "settings.json");
    const base = join(dir, "base.json");
    writeFileSync(p, JSON.stringify({ language: "x", env: { A: "1" } }));
    writeFileSync(base, JSON.stringify({ language: "y", theme: "dark", env: { A: "2", B: "3" }, hooks: { Stop: [] } }));
    applySettings(p, "mac", join(dir, "hooks"), dir, { baseFile: base, home: "/nikde" });
    const d = JSON.parse(readFileSync(p, "utf8"));
    assert.equal(d.language, "x");
    assert.equal(d.theme, "dark");
    assert.deepEqual(d.env, { A: "1", B: "3", AR_ROZHODNUTIA: "1" });
    assert.equal(d.hooks.Stop.length, 1);
    assert.deepEqual(withBase({ a: { b: 1 } }, { a: { b: 2, c: 3 } }), { a: { b: 1, c: 3 } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tabuľka: každý hook existuje, requires sedí s hlavičkou, každý hook v hooks/ je v tabuľke alebo má výnimku", () => {
  assert.deepEqual(tableProblems(REPO), []);
});

test("tableProblems zachytí hook mimo tabuľky, zlé requires a chýbajúci súbor", () => {
  const dir = mkdtempSync(join(tmpdir(), "hooks-test-"));
  try {
    mkdirSync(join(dir, "hooks"));
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "check.mjs"), "");
    writeFileSync(join(dir, "hooks", "unslop.mjs"), "#!/usr/bin/env node\n// requires: tasker\n");
    writeFileSync(join(dir, "hooks", "cudzi.mjs"), "#!/usr/bin/env node\n// requires: none\n");
    writeFileSync(join(dir, "hooks", HELPERS[0]), "x");
    const p = tableProblems(dir);
    assert.ok(p.some((l) => l.includes("unslop.mjs") && l.includes("nesedí s hlavičkou")));
    assert.ok(p.some((l) => l.includes("hooks/cudzi.mjs nie je v env/hooks.mjs")));
    assert.ok(p.some((l) => l.includes("hooks/identity.mjs neexistuje")));
    assert.ok(!p.some((l) => l.includes(HELPERS[0])));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tabuľka nesie každý riadok s platnou hodnotou kde beží a requires", () => {
  for (const r of TABLE) {
    assert.ok(r.where.length > 0, r.file);
    assert.ok(r.requires.length > 0, r.file);
  }
});
