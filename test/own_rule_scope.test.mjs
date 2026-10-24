// Test hooku own_rule_scope.mjs. Hook sa spúšťa ako proces s HOME a AR_STATE
// v dočasnom priečinku, živý stav (~/.local/state/agent-rules) a repá agentov
// sa nemenia: hook cieľové súbory len číta. Replay chyby 23. 10. 2026: Edit
// z prepisu vlákna agenta (relácia d7cf1c50, záznam 20:43:42) do CLAUDE.md jeho repa,
// vstup je skopírovaný sem (cesta v domovskom priečinku skúšky), prepis sa môže rotovať.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { agentRepoOf } from "../hooks/own_rule_scope.mjs";

const HOOK = new URL("../hooks/own_rule_scope.mjs", import.meta.url).pathname;
const RULES = resolve(HOOK, "../..");
const LIVE_STATE = join(homedir(), ".local/state/agent-rules");

// Skutočný vstup Edit z prepisu, riadok s časom 2026-10-23T20:43:42.
const REAL = {
  session_id: "d7cf1c50-01b2-4786-913b-8f066bb67299",
  cwd: "@HOME@/adam",
  tool_name: "Edit",
  tool_input: {
    replace_all: false,
    file_path: "@HOME@/adam/CLAUDE.md",
    old_string: "- Pred zadaním úlohy sub-agentovi pozriem posledné udalosti `work`",
    new_string: "- Úlohu, ktorú robím sám alebo cez sub-agenta, zakladám s `--assign adam`.\n  Bez riešiteľa ju po dokončení blokérov nikto nezobudí a web ukáže \"bez\n  riešiteľa\" pri histórii práce. Chyba 23. 10. 2026: úloha 427 stála 52\n  minút, operátor to rozporoval. Kontrola je úloha 454 (`tasker work` priradí\n  úlohu bez riešiteľa volajúcemu vláknu).\n- Pred zadaním úlohy sub-agentovi pozriem posledné udalosti `work`",
  },
};

function env() {
  const root = mkdtempSync(join(tmpdir(), "ors-"));
  const e = { PATH: process.env.PATH, HOME: join(root, "home"), AR_STATE: join(root, "state"), AGENT_TASKER_USER: "tasker-svc" };
  // Repo agenta v domovskom priečinku s PERSONA.md (živý /root/<meno> sa nepoužije).
  mkdirSync(join(e.HOME, "adam"), { recursive: true });
  writeFileSync(join(e.HOME, "adam/PERSONA.md"), "# Adam\n");
  for (const p of [e.HOME, e.AR_STATE]) assert.ok(p.startsWith(tmpdir()) && !p.startsWith(LIVE_STATE) && !p.startsWith("/root/"), `živá cesta ${p}`);
  return { e, root };
}
// Skutočný vstup s @HOME@ nahradeným domovským priečinkom skúšky.
const real = (e) => JSON.parse(JSON.stringify(REAL).replaceAll("@HOME@", e.HOME));
const run = (e, input) => {
  const r = spawnSync("node", [HOOK], { input: JSON.stringify(input), encoding: "utf8", env: e });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput : null;
};
const edit = (file, old_string, new_string, session_id = "s1") => ({ session_id, cwd: "/tmp", tool_name: "Edit", tool_input: { file_path: file, old_string, new_string } });

test("replay chyby: prvý Edit do CLAUDE.md repa agenta zamietnutý, rovnaký druhý prejde", () => {
  const { e } = env();
  const first = run(e, real(e));
  assert.equal(first.permissionDecision, "deny");
  assert.match(first.permissionDecisionReason, /iný agent alebo rola/);
  assert.match(first.permissionDecisionReason, /env\/<prostredie>\/CLAUDE\.md, global\/CLAUDE\.md alebo roles\//);
  assert.match(first.permissionDecisionReason, /\nSprávny postup: /);
  assert.equal(run(e, real(e)), null);
});

test("iná relácia alebo iný text sa zamietne znova", () => {
  const { e } = env();
  assert.ok(run(e, real(e)));
  assert.equal(run(e, real(e)), null);
  assert.ok(run(e, { ...real(e), session_id: "iná" }));
  const changed = real(e);
  changed.tool_input.new_string += "\n- Ďalšie pravidlo";
  assert.ok(run(e, changed));
});

test("zápis do agent-rules (env/server/CLAUDE.md) prejde hneď", () => {
  const { e } = env();
  for (const f of [join(RULES, "env/server/CLAUDE.md"), "/opt/agent-rules/env/server/CLAUDE.md", "/root/agent-rules/global/CLAUDE.md"]) {
    assert.equal(run(e, { ...real(e), tool_input: { ...real(e).tool_input, file_path: f } }), null, f);
  }
});

test("zmazanie riadku a preformulovanie bez prírastku prejde hneď", () => {
  const { e } = env();
  const line = "- Úlohu, ktorú robím sám alebo cez sub-agenta, zakladám s `--assign adam`.\n";
  assert.equal(run(e, edit(join(e.HOME, "adam/CLAUDE.md"), line + "- Pred zadaním", "- Pred zadaním")), null);
  assert.equal(run(e, edit(join(e.HOME, "adam/CLAUDE.md"), "- Úlohu zakladám s `--assign adam` vždy.", "- Úlohu zakladám s `--assign adam`.")), null);
  assert.equal(run(e, edit(join(e.HOME, "adam/CLAUDE.md"), "- Úlohu zakladám s riešiteľom.", "- Úlohu zakladám s riešiteľom adam.")), null);
});

test("Write a MultiEdit: pridanie zamietne, Write kratšieho obsahu prejde", () => {
  const { e, root } = env();
  const target = join(e.HOME, "Work/agent-boris/CLAUDE.md");
  mkdirSync(join(e.HOME, "Work/agent-boris"), { recursive: true });
  writeFileSync(target, "# Boris\n\n- jedno\n- dve\n");
  const w = (content) => ({ session_id: "w", cwd: "/tmp", tool_name: "Write", tool_input: { file_path: target, content } });
  assert.equal(run(e, w("# Boris\n\n- jedno\n")), null);
  assert.ok(run(e, w("# Boris\n\n- jedno\n- dve\n- tri\n")));
  const m = { session_id: "m", cwd: "/tmp", tool_name: "MultiEdit", tool_input: { file_path: target, edits: [{ old_string: "- jedno", new_string: "- jedno" }, { old_string: "- dve", new_string: "- dve\n- nové pravidlo" }] } };
  assert.ok(run(e, m));
  assert.equal(run(e, m), null);
  assert.ok(root);
});

test("ostatné nástroje, projekty a iné súbory hook nechá tak", () => {
  const { e } = env();
  assert.equal(run(e, { ...real(e), tool_name: "Bash", tool_input: { command: "echo" } }), null);
  for (const f of [join(e.HOME, "adam/memory/MEMORY.md"), join(e.HOME, "CLAUDE.md"), join(e.HOME, ".claude/CLAUDE.md"), "/tmp/projekt/CLAUDE.md", join(e.HOME, "agent-rules/CLAUDE.md"), join(e.HOME, "adam/docs/x.md")]) {
    assert.equal(run(e, { ...real(e), tool_input: { ...real(e).tool_input, file_path: f } }), null, f);
  }
});

test("agentRepoOf: server, tasker-svc, Mac, worktree, projekt", () => {
  const ex = (set) => (p) => set.includes(p);
  const o = { home: "/Users/m", exists: ex(["/root/adam/PERSONA.md"]), taskerUser: "tasker-svc" };
  assert.equal(agentRepoOf("/root/adam/CLAUDE.md", o), "/root/adam");
  assert.equal(agentRepoOf("/root/adam/PERSONA.md", o), "/root/adam");
  assert.equal(agentRepoOf("/root/adam/.worktrees/x/CLAUDE.md", o), "/root/adam");
  assert.equal(agentRepoOf("/root/tasker/CLAUDE.md", o), null);
  assert.equal(agentRepoOf("/home/tasker-svc/agenti/viktor/CLAUDE.md", o), "/home/tasker-svc/agenti/viktor");
  assert.equal(agentRepoOf("/Users/m/Work/agent-cyril/PERSONA.md", o), "/Users/m/Work/agent-cyril");
  assert.equal(agentRepoOf("/Users/m/Work/agenti/cyril/CLAUDE.md", o), "/Users/m/Work/agenti/cyril");
  assert.equal(agentRepoOf("/home/tasker-svc/agenti/viktor/CLAUDE.md", { ...o, taskerUser: undefined }), null, "bez AGENT_TASKER_USER sa nekontroluje");
  assert.equal(agentRepoOf("/Users/m/Work/agent-rules/CLAUDE.md", o), null);
  assert.equal(agentRepoOf("/Users/m/Work/projekt/CLAUDE.md", o), null);
  assert.equal(agentRepoOf("/opt/agent-rules/CLAUDE.md", o), null);
});

test("používateľ behov úloh z runtime.env agenta (AGENT_TASKER_USER), bez neho sa /home/<používateľ>/agenti nekontroluje", () => {
  const { e } = env();
  mkdirSync(join(e.HOME, ".config/adam"), { recursive: true });
  writeFileSync(join(e.HOME, ".config/adam/runtime.env"), "AGENT_TASKER_USER=tasker-svc\n");
  const input = { session_id: "t", cwd: "/tmp", tool_name: "Write", tool_input: { file_path: "/home/tasker-svc/agenti/viktor/CLAUDE.md", content: "- nové pravidlo, ktoré má viac ako štyridsať znakov navyše" } };
  const { AGENT_TASKER_USER, ...bez } = e;
  assert.equal(run({ ...bez, AGENT_NAME: "adam" }, input)?.permissionDecision, "deny");
  assert.equal(run({ ...bez, AGENT_NAME: "iny" }, { ...input, session_id: "t2" }), null);
});
