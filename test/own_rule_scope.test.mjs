// Test hooku own_rule_scope.mjs. Hook sa spúšťa ako proces s HOME a AR_STATE
// v dočasnom priečinku, živý stav (~/.local/state/agentic-workflow) a repá agentov
// sa nemenia: hook cieľové súbory len číta. Replay chyby 23. 10. 2026: Edit
// z prepisu vlákna agenta (relácia d7cf1c50, záznam 20:43:42) do CLAUDE.md jeho repa,
// vstup je skopírovaný sem (cesta v domovskom priečinku skúšky), prepis sa môže rotovať.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, basename } from "node:path";
import { brainGlobalDir, workflowDir } from "../lib/paths.mjs";
import { spawnSync } from "node:child_process";
import { agentRepoOf, check, chybaOdsek, seenBefore } from "../hooks/own_rule_scope.mjs";

const HOOK = new URL("../hooks/own_rule_scope.mjs", import.meta.url).pathname;
const RULES = resolve(HOOK, "../..");
const LIVE_STATE = join(homedir(), ".local/state/agentic-workflow");

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
const realRaw = (e) => JSON.parse(JSON.stringify(REAL).replaceAll("@HOME@", e.HOME));
// Pôvodný text nesie odsek s dátumom chyby, ktorý od úlohy 613 zamieta iné pravidlo (test "613 replay").
// Pravidlo o rozsahu (iný agent alebo rola) sa preto skúša s neutrálnym dátumom.
const real = (e) => JSON.parse(JSON.stringify(realRaw(e)).replaceAll("Chyba 23. 10. 2026", "Oprava z 23. 10. 2026"));
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
  assert.match(first.permissionDecisionReason, /RULES\.md, env\/<prostredie>\/RULES\.md alebo roles\//);
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

test("zápis do agentic-workflow (env/server/CLAUDE.md) prejde hneď", () => {
  const { e } = env();
  for (const f of [join(RULES, "env/server/CLAUDE.md"), "/opt/agentic-workflow/env/server/CLAUDE.md", "/root/agentic-workflow/env/CLAUDE.md"]) {
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
  for (const f of [join(e.HOME, "adam/memory/MEMORY.md"), join(e.HOME, "CLAUDE.md"), join(e.HOME, ".claude/CLAUDE.md"), "/tmp/projekt/CLAUDE.md", join(e.HOME, "agentic-workflow/CLAUDE.md"), join(e.HOME, "adam/docs/x.md")]) {
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
  assert.equal(agentRepoOf("/Users/m/Work/agentic-workflow/CLAUDE.md", o), null);
  assert.equal(agentRepoOf("/Users/m/Work/projekt/CLAUDE.md", o), null);
  assert.equal(agentRepoOf("/opt/agentic-workflow/CLAUDE.md", o), null);
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

// Úloha 613: chyba agenta patrí do registra (error.sh), nie ako odsek "Chyba <dátum>"
// do CLAUDE.md alebo PERSONA.md. Volanie check() priamo, stav a čítanie súborov v tmp.
function direct() {
  const stateDir = join(mkdtempSync(join(tmpdir(), "ors-direct-")), "state");
  assert.ok(stateDir.startsWith(tmpdir()) && !stateDir.startsWith(LIVE_STATE));
  return { stateDir, exists: () => true };
}
const bash = (command, session_id = "b") => ({ session_id, cwd: "/tmp", tool_name: "Bash", tool_input: { command } });
const CHYBA_DOVOD = /^Odsek Chyba .* nejde, chyba patrí do registra \(skill error\)\./;

test("613 a: Edit s novým odsekom Chyba <dátum> je zamietnutý trvalo, druhý pokus tiež", () => {
  const o = direct();
  const input = edit("/root/adam/CLAUDE.md", "x", "x\n\nChyba 27. 10. 2026: x");
  assert.match(check(input, o), CHYBA_DOVOD);
  assert.match(check(input, o), CHYBA_DOVOD, "zopakovaný pokus neprejde");
  assert.match(check({ ...input, tool_input: { ...input.tool_input, file_path: "/root/agentic-workflow/env/server/CLAUDE.md" } }, o), CHYBA_DOVOD);
  const m = { session_id: "m", cwd: "/tmp", tool_name: "MultiEdit", tool_input: { file_path: "/root/adam/PERSONA.md", edits: [{ old_string: "a", new_string: "a" }, { old_string: "b", new_string: "b\nChyba 5.1.2026: y" }] } };
  assert.match(check(m, o), CHYBA_DOVOD);
  assert.match(check(m, o), CHYBA_DOVOD);
});

test("613 b: Edit, ktorý riadok Chyba ponechá a mení iný text, prejde", () => {
  const o = direct();
  const line = "Chyba 22. 10. 2026: y";
  assert.equal(check(edit("/root/adam/CLAUDE.md", `${line} a`, `${line} b`), o), null);
  assert.equal(check(edit("/root/adam/CLAUDE.md", line, ""), o), null, "zmazanie odseku prejde");
});

test("613 c: Write s o jeden odsek Chyba viac než súbor je zamietnutý, s rovnakým počtom nie týmto pravidlom", () => {
  const o = direct();
  const cur = "# Adam\n\nChyba 22. 10. 2026: y\n";
  const w = (content) => ({ session_id: "w", cwd: "/tmp", tool_name: "Write", tool_input: { file_path: "/root/adam/PERSONA.md", content } });
  o.read = () => cur;
  assert.match(check(w(cur + "\nChyba 27. 10. 2026: x\n"), o), CHYBA_DOVOD);
  assert.equal(chybaOdsek(w(cur.replace("# Adam", "# Adam II")), o.read), null);
  assert.equal(check(w(cur.replace("# Adam", "# Adam II")), o), null);
});

test("613 d: Bash zápis odseku Chyba do CLAUDE.md alebo PERSONA.md je zamietnutý, čítanie a echo prejdú", () => {
  const o = direct();
  const deny = [
    "cat >> /root/adam/CLAUDE.md <<'EOF'\n- Chyba 27. 10. 2026: x\nEOF",
    "sed -i 's|^## Git|Chyba 27. 10. 2026: x\\n## Git|' /root/adam/CLAUDE.md",
    "printf 'Chyba 27. 10. 2026: x\\n' >> /root/agentic-workflow/env/server/CLAUDE.md",
    "echo 'Chyba 27. 10. 2026: x' | tee -a /root/adam/PERSONA.md",
    "perl -pi -e 's/^## Git/Chyba 27. 10. 2026: x\\n## Git/' /root/adam/CLAUDE.md",
    "python3 -c \"open('/root/adam/PERSONA.md','a').write('Chyba 27. 10. 2026: x')\"",
    "echo 'Chyba 27. 10. 2026: x' > CLAUDE.md",
  ];
  for (const c of deny) {
    assert.match(check(bash(c, "d"), o) || "", CHYBA_DOVOD, c);
    assert.match(check(bash(c, "d"), o) || "", CHYBA_DOVOD, `trvalo: ${c}`);
  }
  const pass = [
    "echo 'Chyba 27. 10. 2026: x'",
    "grep -n 'Chyba 27. 10. 2026' /root/adam/CLAUDE.md",
    "grep -n 'Chyba 27. 10. 2026' /root/adam/CLAUDE.md | tee /tmp/vystup.txt",
    "sed -n '1,5p' /root/adam/CLAUDE.md",
    "cat >> /root/adam/CLAUDE.md <<'EOF'\n- nové pravidlo bez dátumu\nEOF",
    "echo 'Chyba 27. 10. 2026: x' >> /tmp/poznamky.md",
  ];
  for (const c of pass) assert.equal(check(bash(c, "p"), o), null, c);
});

test("613 d: hook ako proces zamietne Bash zápis s postupom error.sh --mechanism", () => {
  const { e } = env();
  const r = run(e, bash("cat >> /root/adam/CLAUDE.md <<'EOF'\nChyba 27. 10. 2026: x\nEOF"));
  assert.equal(r.permissionDecision, "deny");
  assert.match(r.permissionDecisionReason, CHYBA_DOVOD);
  assert.match(r.permissionDecisionReason, /\nSprávny postup: spusti \/opt\/agentic-workflow\/skills\/error\/scripts\/error\.sh --class <trieda> --file <súbor s opravou> --mechanism <hook\|test\|deny\|decision>:<cesta alebo id>/);
  assert.equal(run(e, bash("grep -n 'Chyba 27. 10. 2026' /root/adam/CLAUDE.md")), null);
  assert.equal(run(e, bash("echo 'Chyba 27. 10. 2026: x'")), null);
});

test("613 replay: pôvodný Edit s odsekom Chyba 23. 10. 2026 je teraz zamietnutý trvalo ako chyba pre register", () => {
  const { e } = env();
  for (let i = 0; i < 2; i++) {
    const r = run(e, realRaw(e));
    assert.equal(r.permissionDecision, "deny");
    assert.match(r.permissionDecisionReason, CHYBA_DOVOD);
  }
});

test("613 e: pôvodné správanie ostáva (repo agenta zamietne prvý pokus, druhý rovnaký prejde)", () => {
  const o = direct();
  const bez = edit("/root/adam/CLAUDE.md", "x", "x\n- Úloha so zakladaním s riešiteľom, ktorá bez neho nikoho nezobudí.", "orig");
  assert.match(check(bez, o), /iný agent alebo rola/);
  assert.equal(check(bez, o), null);
  assert.equal(agentRepoOf("/root/adam/CLAUDE.md", { exists: () => true }), "/root/adam");
  assert.equal(seenBefore({ stateDir: o.stateDir, session: "orig", file: "/root/adam/CLAUDE.md", text: "iný text" }), false);
  assert.equal(seenBefore({ stateDir: o.stateDir, session: "orig", file: "/root/adam/CLAUDE.md", text: "iný text" }), true);
});

// Úloha 625: Bash, ktorý odsek Chyba <dátum> zo súboru maže alebo preformuluje, prejde.
// Zamietne len odsek, ktorý v cieľovom súbore ešte nie je. Súbor je v tmp, hook ho len číta.
function fixtura(obsah) {
  const dir = mkdtempSync(join(tmpdir(), "ors-625-"));
  assert.ok(dir.startsWith(tmpdir()) && !dir.startsWith(LIVE_STATE));
  writeFileSync(join(dir, "CLAUDE.md"), obsah);
  return dir;
}
const bashIn = (cwd, command) => ({ session_id: "u625", cwd, tool_name: "Bash", tool_input: { command } });
const SUBOR = "# Adam\n\n- pravidlo\n\nChyba 23. 10. 2026: x\n\n- iné pravidlo\n";
const PY = (text) =>
  `python3 - <<'EOF'\np = open('CLAUDE.md').read()\np = p.replace('''${text}''', '')\nwith open('CLAUDE.md', 'w') as f:\n    f.write(p)\nEOF`;

test("625 1: python s open('CLAUDE.md','w'), odsek je v súbore a skript ho nahrádza prázdnym: prejde", () => {
  const dir = fixtura(SUBOR);
  const c = PY("Chyba 23. 10. 2026: x\n\n");
  assert.equal(check(bashIn(dir, c), direct()), null);
  const { e } = env();
  assert.equal(run(e, bashIn(dir, c)), null, "ako proces hooku");
});

test("625 2: sed -i 's/Chyba 23. 10. 2026: x//' pri súbore s tým odsekom prejde", () => {
  const dir = fixtura(SUBOR);
  const c = "sed -i 's/Chyba 23. 10. 2026: x//' CLAUDE.md";
  assert.equal(check(bashIn(dir, c), direct()), null);
  assert.equal(check(bashIn(dir, "sed -i '/^Chyba 23. 10. 2026: x$/d' " + join(dir, "CLAUDE.md")), direct()), null, "absolútna cesta");
  const { e } = env();
  assert.equal(run(e, bashIn(dir, c)), null, "ako proces hooku");
});

test("625 3: ten istý python s odsekom, ktorý v súbore nie je: zamietne", () => {
  const dir = fixtura(SUBOR);
  assert.match(check(bashIn(dir, PY("Chyba 27. 10. 2026: y\n\n")), direct()), CHYBA_DOVOD);
  assert.match(check(bashIn(dir, "sed -i 's/Chyba 23. 10. 2026: x//; s/^- pravidlo/Chyba 27. 10. 2026: y\\n&/' CLAUDE.md"), direct()), CHYBA_DOVOD, "mazanie spolu s pridaním nového");
  assert.match(check(bashIn(dir, PY("Chyba 23. 10. 2026: iný text")), direct()), CHYBA_DOVOD, "rovnaký dátum, iný text je nový odsek");
  const { e } = env();
  assert.equal(run(e, bashIn(dir, PY("Chyba 27. 10. 2026: y\n\n"))).permissionDecision, "deny");
});

test("625 4: printf >> CLAUDE.md s novým odsekom zamietne ako dnes, append, neexistujúci súbor a python len s módom a tiež", () => {
  const dir = fixtura(SUBOR);
  assert.match(check(bashIn(dir, "printf 'Chyba 27. 10. 2026: y' >> CLAUDE.md"), direct()), CHYBA_DOVOD);
  assert.match(check(bashIn(dir, "printf 'Chyba 23. 10. 2026: x' >> CLAUDE.md"), direct()), CHYBA_DOVOD, "append ostáva zamietnutý aj pri odseku, ktorý v súbore je");
  assert.match(check(bashIn(dir, "sed -i 's/Chyba 23. 10. 2026: x//' PERSONA.md"), direct()), CHYBA_DOVOD, "súbor neexistuje");
  assert.match(check(bashIn(dir, "python3 -c \"open('CLAUDE.md','a').write('Chyba 23. 10. 2026: x')\""), direct()), CHYBA_DOVOD, "python len s módom a");
});

test("625 5: odsek zalomený v súbore na viac riadkov, repo pravidiel a cesta env/server/CLAUDE.md", () => {
  const dir = fixtura("- a\n\nChyba 23. 10. 2026: x začína\n  a pokračuje.\n");
  assert.equal(check(bashIn(dir, PY("Chyba 23. 10. 2026: x začína a pokračuje.")), direct()), null);
  const rules = fixtura(SUBOR);
  mkdirSync(join(rules, "env/server"), { recursive: true });
  writeFileSync(join(rules, "env/server/CLAUDE.md"), SUBOR);
  const c = `sed -i 's/Chyba 23. 10. 2026: x//' ${join(rules, "env/server/CLAUDE.md")}`;
  assert.equal(check(bashIn("/tmp", c), direct()), null, "mazanie v repe pravidiel prejde");
  assert.match(check(bashIn("/tmp", c.replace("23. 10. 2026: x", "27. 10. 2026: q")), direct()), CHYBA_DOVOD, "pridanie v repe pravidiel ostáva zamietnuté");
});

// Tvar D0197 (úloha 681): RULES.md vedľa PERSONA.md je súbor repa agenta.
test("681 a: RULES.md vedľa PERSONA.md v $HOME/adam je repo agenta, Edit s novým odsekom zamietne a druhý rovnaký prejde", () => {
  const { e } = env();
  const target = join(e.HOME, "adam/RULES.md");
  const input = edit(target, "- a", "- a\n- Úlohu zakladám s riešiteľom, ktorý ju po dokončení blokérov zobudí a nechá stopu v histórii.", "r681");
  const first = run(e, input);
  assert.equal(first.permissionDecision, "deny");
  assert.match(first.permissionDecisionReason, /iný agent alebo rola/);
  assert.equal(run(e, input), null);
  const chyba = run(e, edit(target, "x", "x\n\nChyba 27. 10. 2026: x", "r681b"));
  assert.match(chyba.permissionDecisionReason, /Odsek Chyba 27\. 10\. 2026 do .*RULES\.md nejde/);
});

test("681 b: agentRepoOf pre RULES.md: bez PERSONA.md null vo všetkých vetvách, repo kódu a mozgu null aj s PERSONA.md", () => {
  const ex = (l) => (p) => l.includes(p);
  const o = { home: "/Users/m", exists: ex(["/root/adam/PERSONA.md", "/Users/m/Work/agent-cyril/PERSONA.md", "/Users/m/Work/agenti/cyril/PERSONA.md", "/home/tasker-svc/agenti/viktor/PERSONA.md"]), taskerUser: "tasker-svc" };
  assert.equal(agentRepoOf("/root/adam/RULES.md", o), "/root/adam");
  assert.equal(agentRepoOf("/root/adam/.worktrees/x/RULES.md", o), "/root/adam");
  assert.equal(agentRepoOf("/Users/m/Work/agent-cyril/RULES.md", o), "/Users/m/Work/agent-cyril");
  assert.equal(agentRepoOf("/Users/m/Work/agenti/cyril/RULES.md", o), "/Users/m/Work/agenti/cyril");
  assert.equal(agentRepoOf("/home/tasker-svc/agenti/viktor/RULES.md", o), "/home/tasker-svc/agenti/viktor");
  // bez PERSONA.md vedľa
  assert.equal(agentRepoOf("/root/boris/RULES.md", o), null);
  assert.equal(agentRepoOf("/Users/m/Work/agent-dana/RULES.md", o), null);
  assert.equal(agentRepoOf("/Users/m/Work/agenti/dana/RULES.md", o), null);
  assert.equal(agentRepoOf("/home/tasker-svc/agenti/eva/RULES.md", o), null);
  // CLAUDE.md a PERSONA.md sa správajú ako dnes
  assert.equal(agentRepoOf("/Users/m/Work/agent-dana/CLAUDE.md", o), "/Users/m/Work/agent-dana");
  assert.equal(agentRepoOf("/root/boris/PERSONA.md", o), "/root/boris");
  assert.equal(agentRepoOf("/root/boris/CLAUDE.md", o), null);
  // repo kódu a mozgu s PERSONA.md vedľa seba
  const all = { ...o, exists: () => true };
  const wf = basename(workflowDir());
  const br = basename(brainGlobalDir());
  for (const d of [`/root/${wf}`, `/root/${br}`, `/Users/m/Work/agenti/${wf}`, `/Users/m/Work/agenti/${br}`, `/home/tasker-svc/agenti/${wf}`, workflowDir(), brainGlobalDir()]) {
    assert.equal(agentRepoOf(`${d}/RULES.md`, all), null, d);
  }
});

test("681 c: Bash cat >> RULES.md s odsekom Chyba <dátum> je zamietnutý, bez dátumu a čítanie prejdú", () => {
  const o = direct();
  assert.match(check(bash("cat >> /root/adam/RULES.md <<'EOF'\nChyba 1. 1. 2026: x\nEOF", "r1"), o) || "", CHYBA_DOVOD);
  assert.match(check(bash("cat >> RULES.md <<'EOF'\nChyba 1. 1. 2026: x\nEOF", "r2"), o) || "", CHYBA_DOVOD);
  assert.match(check(bash("echo 'Chyba 1. 1. 2026: x' | tee -a /root/adam/RULES.md", "r3"), o) || "", CHYBA_DOVOD);
  assert.match(check(bash("sed -i 's|^## A|Chyba 1. 1. 2026: x\\n## A|' /root/adam/RULES.md", "r4"), o) || "", CHYBA_DOVOD);
  assert.equal(check(bash("cat >> /root/adam/RULES.md <<'EOF'\n- pravidlo bez dátumu\nEOF", "r5"), o), null);
  assert.equal(check(bash("grep -n 'Chyba 1. 1. 2026' /root/adam/RULES.md", "r6"), o), null);
});
