#!/usr/bin/env node
// Testy topic.mjs. Spúšťa hook ako proces s dočasným stavom v TOPIC_STATE_DIR
// a pamäťou v TOPIC_MEMORY_DIR, skutočný .scratch/topics sa nemení. Repo agenta
// je dočasný priečinok v CLAUDE_PROJECT_DIR, nie repo pravidiel, v ktorom
// hook leží (chyba 19. 10. 2026, hooks/agent_repo.mjs).

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "topic.mjs");
const T = mkdtempSync(join(tmpdir(), "topic-"));
const AGENT = join(T, "agent");
mkdirSync(AGENT);
const env = { ...process.env, CLAUDE_PROJECT_DIR: AGENT, AGENT_OPERATOR_NAME: "Oskar", TOPIC_STATE_DIR: join(T, "state"), TOPIC_MEMORY_DIR: join(T, "memory") };
const A = "aaaaaaaa-1111-2222-3333-444444444444";
const B = "bbbbbbbb-1111-2222-3333-444444444444";

// PID neexistujúceho procesu: relácia, ktorej vlákno už nebeží.
const DEAD = "999999";
const cli = (id, ...args) => cliPid(id, DEAD, ...args);
const cliPid = (id, pid, ...args) =>
  spawnSync("node", [HOOK, ...args], { env: { ...env, CLAUDE_CODE_SESSION_ID: id, CLAUDE_PID: pid }, encoding: "utf8" });
const check = (id, tool, input = {}) => {
  const r = spawnSync("node", [HOOK, "check"], {
    env,
    input: JSON.stringify({ session_id: id, tool_name: tool, tool_input: input }),
    encoding: "utf8",
  });
  return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason : "";
};

let bad = 0;
let n = 0;
const ok = (name, cond, detail = "") => {
  n++;
  if (!cond) {
    bad++;
    console.log(`✗ ${name} ${detail}`);
  }
};

const write = { file_path: "/x" };
ok("bez témy zápis zamietnutý", check(A, "Write", write).includes("nemá tému"));
ok("bez témy Bash zamietnutý", check(A, "Bash", { command: "git status" }).includes("nemá tému"));
ok("bez témy čítanie povolené", check(A, "Read", write) === "");
for (const t of ["Monitor", "SendMessage", "EnterWorktree", "mcp__directus__items", "mcp__claude_ai_Claude_Docs__batch", "mcp__t3-code__preview_click", "NovyNastroj"])
  ok(`bez témy ${t} zamietnutý`, check(A, t, {}).includes("nemá tému"));
for (const t of ["Grep", "Glob", "Agent", "ToolSearch", "mcp__claude_ai_Claude_Docs__read"]) ok(`bez témy ${t} povolený`, check(A, t, {}) === "");
ok("bez ID relácie zápis zamietnutý", check("", "Write", write).includes("nedostal ID"));
ok("bez ID relácie čítanie povolené", check("", "Read", write) === "");
ok("bez témy set povolený", check(A, "Bash", { command: "node hooks/topic.mjs set temy" }) === "");
ok("bez témy set s absolútnou cestou povolený", check(A, "Bash", { command: `node ${HOOK} set temy` }) === "");
ok("bez témy set s cestou v úvodzovkách povolený", check(A, "Bash", { command: `node "${HOOK}" set temy` }) === "");
ok("bez témy set --take povolený", check(A, "Bash", { command: "node hooks/topic.mjs set temy --take" }) === "");
ok("bez témy list povolený", check(A, "Bash", { command: "node hooks/topic.mjs list" }) === "");
for (const c of [
  "node hooks/topic.mjs list; rm -rf x",
  "node hooks/topic.mjs set temy && git push",
  "node hooks/topic.mjs set temy\ngit push",
  "node hooks/topic.mjs set temy | sh",
  "echo node hooks/topic.mjs list",
  "node hooks/topic.mjs set $(rm x)",
  "node hooks/topic.mjs set temy > /etc/x",
  // Nálezy auditu 16. 10. 2026: substitúcia v ceste, cudzí súbor, nový riadok.
  'node "$(touch /tmp/pwned)/hooks/topic.mjs" list',
  "node \"`touch /tmp/pwned`/hooks/topic.mjs\" list",
  "node /tmp/evil/hooks/topic.mjs list",
  "node\nhooks/topic.mjs list",
  "node hooks/topic.mjs list\n",
  "NODE_OPTIONS=--require=x node hooks/topic.mjs list",
  "node --require x hooks/topic.mjs list",
])
  ok(`reťazený príkaz bez témy zamietnutý: ${JSON.stringify(c)}`, check(A, "Bash", { command: c }).includes("nemá tému"));

ok("set zlé meno zlyhá", cli(A, "set", "Zlé-Meno").status === 1);
ok("set bez ID relácie zlyhá", cli("", "set", "temy").status === 1);
ok("set bez ID nezapíše", check(A, "Write", write).includes("nemá tému"));

let r = cli(A, "set", "temy");
ok("set temy", r.status === 0 && r.stdout.includes("Nová téma"), r.stderr);
ok("s témou zápis povolený", check(A, "Write", write) === "");
ok("whoami", cli(A, "whoami").stdout.trim() === "temy");

r = cli(B, "set", "prihlasenie");
ok("druhá relácia, iná téma", check(B, "Write", write) === "" && check(A, "Write", write) === "");

// A drží tému v bežiacom procese (PID tohto testu), B ju bez --take nevezme.
cliPid(A, String(process.pid), "set", "temy");
r = cli(B, "set", "temy");
ok("tému bežiaceho vlákna bez --take nevezme", r.status === 1 && r.stderr.includes("--take"), r.stderr);
ok("A po odmietnutom set stále píše", check(A, "Write", write) === "");
r = cli(B, "set", "temy", "--take");
ok("prevzatie hlási pôvodnú reláciu", r.stdout.includes("Prevzatá od relácie aaaaaaaa"));
ok("prevzatá relácia nezapisuje", check(A, "Write", write).includes("prevzala iná relácia"));
ok("prevzatá relácia nespustí Bash", check(A, "Bash", { command: "ls" }).includes("prevzala"));
ok("nový držiteľ zapisuje", check(B, "Write", write) === "");
ok("téma, ktorú B opustil, ostáva B", cli(A, "list").stdout.includes("prihlasenie: relácia bbbbbbbb"));
ok("mŕtvy proces list označí", cli(A, "list").stdout.includes("proces nebeží"));

cli(B, "set", "dalsia");
ok("A po odchode B z temy bez set nezapíše", check(A, "Write", write).includes("prevzala"));
ok("téma mŕtveho procesu sa vezme bez --take", cli(A, "set", "temy").status === 0 && check(A, "Write", write) === "");
ok("set zlý prepínač zlyhá", cli(A, "set", "temy", "--force").status === 1);

// /clear: nová relácia C z procesu 4242 zdedí tému relácie D z toho istého procesu.
const C = "cccccccc-1111-2222-3333-444444444444";
const D = "dddddddd-1111-2222-3333-444444444444";
cliPid(D, "4242", "set", "po_clear");
const startPid = (id, source, pid) =>
  JSON.parse(
    spawnSync("node", [HOOK, "start"], { env: { ...env, CLAUDE_PID: pid }, input: JSON.stringify({ session_id: id, source }), encoding: "utf8" }).stdout,
  ).hookSpecificOutput.additionalContext;
ok("po /clear iný proces tému nezdedí", startPid(C, "clear", "4343").includes("nemá tému"));
ok("po startup tému nezdedí", startPid(C, "startup", "4242").includes("nemá tému"));
ok("po /clear ten istý proces tému zdedí", startPid(C, "clear", "4242").includes("Po /clear pokračuje téma po_clear"));
ok("zdedená relácia zapisuje", check(C, "Write", write) === "");
ok("stará relácia po /clear nezapisuje", check(D, "Write", write).includes("prevzala"));

// Zdieľaný checkout: git príkazy, ktoré zahodia prácu inej relácie.
const G = "git";
for (const c of ["stash", "stash push -m x", "reset --hard", "checkout -- PERSONA.md", "checkout .", "restore x", "clean -fd", "pull --rebase --autostash"])
  ok(`zdieľaný git zamietnutý: ${c}`, check(C, "Bash", { command: `${G} ${c}` }).includes("zdieľajú"));
ok("zdieľaný git za cd zamietnutý", check(C, "Bash", { command: `cd x && ${G} stash pop` }).includes("zdieľajú"));
for (const c of ["status", "pull --rebase", "checkout -b x", "log --oneline"])
  ok(`bežný git povolený: ${c}`, check(C, "Bash", { command: `${G} ${c}` }) === "");
ok("commit povolený", check(C, "Bash", { command: `${G} add a b && ${G} commit -m x` }) === "");

ok("cudzie ID s lomkou sa nečíta", check("../../etc/passwd", "Write", write).includes("nedostal ID"));

mkdirSync(join(T, "memory", "topics"), { recursive: true });
writeFileSync(
  join(T, "memory", "topics", "temy.md"),
  "# Témy\n\n## Stav\n\n- nie\n\n## Čaká na Oskara\n\n- súhlas s plánom (rozhodnutie)\n- snímka (tvoj účet)\n\n## Ďalej\n\n- nie\n",
);
r = cli(A, "list");
ok("list zbiera Čaká na Oskara", r.stdout.includes("  - súhlas s plánom (rozhodnutie)") && r.stdout.includes("  - snímka (tvoj účet)"), r.stdout);
ok("list neberie iné sekcie", !r.stdout.includes("- nie"), r.stdout);
ok("set existujúcej témy odkáže na stav", cli(B, "set", "temy").stdout.includes("prečítaj ho"));

const start = (id) =>
  JSON.parse(spawnSync("node", [HOOK, "start"], { env, input: JSON.stringify({ session_id: id }), encoding: "utf8" }).stdout)
    .hookSpecificOutput.additionalContext;
ok("start bez témy žiada set", start("eeeeeeee-1111-2222-3333-444444444444").includes("nemá tému"));
ok("start s témou ju ohlási", start(B).includes("Téma tejto relácie je temy"));
ok("start prevzatej relácie žiada set", start(D).includes("nemá tému"));
ok("start pridá zoznam tém", start(B).includes("temy: relácia bbbbbbbb"));

// Súbory témy: relácia s témou temy nezapisuje do súboru, ktorý si vyhradila
// téma projekty (replay 16. 10. 2026, kubo_rancher začal refaktor kánonu).
writeFileSync(join(T, "memory", "topics", "projekty.md"), "# Téma projekty\n\n## Súbory témy\n\n- `STRUCTURE.md`\n- `TEMPLATES/`\n\n## Čaká na Oskara\n");
const REPO = AGENT;
ok("Edit cudzieho súboru zamietnutý", check(B, "Edit", { file_path: join(REPO, "STRUCTURE.md") }).includes("patrí téme projekty"));
ok("Write do cudzieho priečinka zamietnutý", check(B, "Write", { file_path: join(REPO, "TEMPLATES/x.md") }).includes("patrí téme projekty"));
ok("Bash sed -i cudzieho súboru zamietnutý", check(B, "Bash", { command: "sed -i '' 's/a/b/' STRUCTURE.md" }).includes("patrí téme projekty"));
ok("Bash čítanie cudzieho súboru povolené", check(B, "Bash", { command: "grep -n vyvoj STRUCTURE.md" }) === "");
ok("Edit vlastného súboru povolený", check(B, "Edit", { file_path: join(REPO, "DECISIONS.md") }) === "");
ok("zápis do súboru témy inej témy povolený", check(B, "Edit", { file_path: join(REPO, "memory/topics/projekty.md") }) === "");
// Vyhradenie platí v hlavnom checkoute aj v každom worktree (.worktrees/<úloha>),
// test prejde z oboch miest.
const MAIN = resolve(REPO).replace(/\/\.worktrees\/[^/]+$/, "");
ok("Edit cudzieho súboru v hlavnom checkoute zamietnutý", check(B, "Edit", { file_path: join(MAIN, "STRUCTURE.md") }).includes("patrí téme projekty"));
ok("Edit cudzieho súboru v inom worktree zamietnutý", check(B, "Edit", { file_path: join(MAIN, ".worktrees/iny/STRUCTURE.md") }).includes("patrí téme projekty"));
ok("Bash cp do cudzieho súboru v inom worktree zamietnutý", check(B, "Bash", { command: `cp x ${join(MAIN, ".worktrees/iny/STRUCTURE.md")}` }).includes("patrí téme projekty"));
ok("bez témy set s cestou hooku v repe pravidiel povolený", check(A, "Bash", { command: `node ${HOOK} set temy` }) === "");
ok("bez témy set s cestou hooku cez ~ povolený", check(A, "Bash", { command: `node ${HOOK.replace(process.env.HOME, "~")} set temy` }) === "");
ok("bez témy set cudzieho topic.mjs zamietnutý", check(A, "Bash", { command: "node ~/iny/hooks/topic.mjs set temy" }) !== "");
cli(B, "set", "projekty");
ok("vlastník tému smie zapisovať", check(B, "Edit", { file_path: join(REPO, "STRUCTURE.md") }) === "");

// Bez TOPIC_STATE_DIR a TOPIC_MEMORY_DIR berie hook stav a pamäť z repa agenta
// v CLAUDE_PROJECT_DIR, aj z jeho worktree (replay 19. 10. 2026).
{
  const own = { ...process.env, CLAUDE_PROJECT_DIR: AGENT, AGENT_OPERATOR_NAME: "Oskar" };
  delete own.TOPIC_STATE_DIR;
  delete own.TOPIC_MEMORY_DIR;
  mkdirSync(join(AGENT, "memory", "topics"), { recursive: true });
  writeFileSync(join(AGENT, "memory", "topics", "agent_tema.md"), "# Téma\n\n## Čaká na Oskara\n\n- vec agenta\n");
  const run = (dir, ...args) => spawnSync("node", [HOOK, ...args], { cwd: dirname(HOOK), env: { ...own, CLAUDE_PROJECT_DIR: dir, CLAUDE_CODE_SESSION_ID: A, CLAUDE_PID: DEAD }, encoding: "utf8" });
  ok("set zapíše stav do repa agenta", run(AGENT, "set", "agent_tema").status === 0 && existsSync(join(AGENT, ".scratch", "topics", "locks", "agent_tema")));
  const l = run(AGENT, "list").stdout;
  ok("list číta pamäť repa agenta", l.includes("agent_tema") && l.includes("vec agenta"), l);
  ok("whoami z worktree repa agenta", run(join(AGENT, ".worktrees", "x"), "whoami").stdout.includes("agent_tema"));
  ok("repo kódu stav nedostane", !existsSync(join(dirname(HOOK), "..", ".scratch", "topics", "locks", "agent_tema")));
}

rmSync(T, { recursive: true, force: true });
console.log(bad ? `${bad}/${n} zlyhalo` : `${n} prípadov v poriadku`);
process.exit(bad ? 1 : 0);
