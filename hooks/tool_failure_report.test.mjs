// tool_failure_report.mjs: zlyhaný spoločný nástroj (prípad Lea, browser.sh
// kód 2) zastaví Stop a SubagentStop, po hlásení prejde, príkaz mimo
// spoločných ciest, test a `tk` neblokuje, stop_hook_active nezacyklí.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { sharedTool, isReport, unreported } from "./tool_failure_report.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "tool_failure_report.mjs");
const BROWSER = "/opt/agentic-workflow/browser.sh --gaps http://127.0.0.1:8801/";
const ERR = "Exit code 2\nbrowser.sh: spúšťa sa pod rootom (runuser vyžaduje root)";

let n = 0;
const user = (text) => ({ type: "user", message: { role: "user", content: text } });
const call = (cmd) => {
  const id = `t${++n}`;
  return [id, { type: "assistant", message: { content: [{ type: "tool_use", id, name: "Bash", input: { command: cmd } }] } }];
};
const result = (id, text, err) => ({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: err }] } });
// Dvojica záznamov: príkaz a jeho výsledok.
const run = (cmd, text, err = false) => {
  const [id, a] = call(cmd);
  return [a, result(id, text, err)];
};
const fail = (cmd, text = ERR) => run(cmd, text, true);
const ok = (cmd) => run(cmd, "ok", false);

test("prípad Lea: browser.sh kód 2 bez hlásenia je nahlásiteľné", () => {
  const f = unreported([user("urob úlohu"), ...fail(BROWSER), ...ok("node /tmp/browser.mjs --gaps x")]);
  assert.equal(f?.code, "2");
  assert.equal(f.project, "agenti");
  assert.match(f.tool, /browser\.sh$/);
});

test("hlásenie po zlyhaní ho uzavrie: tk, tasker aj ask_agent.sh", () => {
  for (const rep of [
    'AGENT_NAME=dan /opt/agentic-workflow/bin/tk task add --project agenti --title x --body y',
    'tasker task add --project agenti --title x',
    "runuser -u tasker-svc -- tasker task add --project agenti --title x",
    "/opt/agentic-workflow/bin/ask_agent.sh adam browser <<'EOF'\ntext\nEOF",
  ]) {
    assert.equal(unreported([user("x"), ...fail(BROWSER), ...ok(rep)]), null, rep);
  }
});

test("hlásenie pred zlyhaním, neúspešné hlásenie a čítanie správ nestačia", () => {
  assert.ok(unreported([user("x"), ...ok("tk task add --project agenti --title x"), ...fail(BROWSER)]));
  assert.ok(unreported([user("x"), ...fail(BROWSER), ...fail("tasker task add --project agenti", "Exit code 1\nchyba")]));
  assert.ok(unreported([user("x"), ...fail(BROWSER), ...ok("/opt/agentic-workflow/bin/ask_agent.sh --replies")]));
  assert.ok(unreported([user("x"), ...fail(BROWSER), ...ok('echo "tk task add"')]));
});

test("druhé zlyhanie po hlásení potrebuje nové hlásenie", () => {
  const rep = "tk task add --project agenti --title x";
  assert.equal(unreported([user("x"), ...fail(BROWSER), ...ok(rep)]), null);
  assert.ok(unreported([user("x"), ...fail(BROWSER), ...ok(rep), ...fail("/opt/agentic-workflow/bin/ask_agent.sh boris t")]));
});

test("príkaz mimo spoločných ciest neblokuje", () => {
  for (const cmd of [
    "cat /opt/agentic-workflow/nie-je.txt",
    "grep -rn x /opt/agentic-workflow/",
    "ls /opt/tasker/",
    "git -C /opt/agentic-workflow fetch",
    "/root/adam/skripty/x.sh",
    "false",
    "npm test",
  ]) {
    assert.equal(unreported([user("x"), ...fail(cmd, "Exit code 1\nx")]), null, cmd);
  }
});

test("testy a tk neblokujú, spustenie skriptu inak áno", () => {
  for (const cmd of [
    "node --test /opt/agentic-workflow/test/",
    "cd /opt/agentic-workflow && node --test",
    "node /opt/agentic-workflow/test/x.test.mjs",
    "cd /opt/agentic-workflow && node check.mjs",
    "/opt/agentic-workflow/bin/tk task show 999999",
    "tasker task show 9",
    "bash /opt/agentic-workflow/env/server/tests/run.sh",
  ]) {
    assert.equal(sharedTool(cmd), null, cmd);
  }
  for (const cmd of [
    BROWSER,
    "node /opt/agentic-workflow/browser.mjs --gaps x",
    "AGENT_NAME=dan bash /opt/agentic-workflow/bin/uloha-webu.sh --project p",
    "timeout 60 /opt/agentic-workflow/reply.sh abc",
    "cd /opt/agentic-workflow && ./browser.sh --gaps x",
    "runuser -u tasker-svc -- /opt/tasker/bin/tasker-x",
    "echo hotovo && /opt/agentic-workflow/browser.sh x",
  ]) {
    assert.ok(sharedTool(cmd), cmd);
  }
  assert.equal(sharedTool("/opt/tasker/bin/x").project, "tasker");
});

test("úspešný príkaz, nulový kód a zlyhanie predošlého ťahu neblokujú", () => {
  assert.equal(unreported([user("x"), ...ok(BROWSER)]), null);
  assert.equal(unreported([user("x"), ...fail(BROWSER, "Command timed out")]), null);
  assert.equal(unreported([user("x"), ...fail(BROWSER), user("ďalší pokyn"), ...ok("ls")]), null);
  // spätná väzba hooku je isMeta a ťah nezačína
  const meta = { ...user("Stop hook feedback:\nx"), isMeta: true };
  assert.ok(unreported([user("x"), ...fail(BROWSER), meta]));
});

test("sub-agent: vlákno sub-agenta sa posudzuje cez prepis sub-agenta", () => {
  const side = (e) => ({ ...e, isSidechain: true });
  const e = [user("zadanie"), ...fail(BROWSER), ...ok("ls")].map(side);
  assert.equal(unreported(e), null); // hlavný prepis vlákna sub-agentov nečíta
  assert.ok(unreported(e, { sidechain: true }));
});

// Hook ako proces: prepis v dočasnom súbore, živý Tasker ani schránky sa nevolajú.
function hook(entries, input = {}) {
  const dir = mkdtempSync(join(tmpdir(), "tfr-"));
  try {
    const path = join(dir, "t.jsonl");
    writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    const sub = input.hook_event_name === "SubagentStop";
    const stdin = JSON.stringify({ ...(sub ? { agent_transcript_path: path } : { transcript_path: path }), hook_event_name: "Stop", ...input });
    const r = spawnSync("node", [HOOK], { input: stdin, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout ? JSON.parse(r.stdout) : null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Stop zablokuje s dôvodom po slovensky, po hlásení prejde", () => {
  const out = hook([user("x"), ...fail(BROWSER)]);
  assert.equal(out.decision, "block");
  assert.match(out.reason, /Spoločný nástroj .*browser\.sh zlyhal \(kód 2/);
  assert.match(out.reason, /spúšťa sa pod rootom/);
  assert.match(out.reason, /Správny postup: .*task add --project agenti/);
  assert.equal(hook([user("x"), ...fail(BROWSER), ...ok("tk task add --project agenti --title x")]), null);
});

test("Stop mimo spoločných ciest a s stop_hook_active mlčí", () => {
  assert.equal(hook([user("x"), ...fail("cat /opt/agentic-workflow/nie-je", "Exit code 1\nx")]), null);
  assert.equal(hook([user("x"), ...fail(BROWSER)], { stop_hook_active: true }), null);
});

test("SubagentStop číta prepis sub-agenta", () => {
  const e = [user("zadanie"), ...fail(BROWSER)].map((x) => ({ ...x, isSidechain: true }));
  const out = hook(e, { hook_event_name: "SubagentStop" });
  assert.equal(out.decision, "block");
  assert.equal(hook(e, { hook_event_name: "SubagentStop", stop_hook_active: true }), null);
});

test("hook bez prepisu a s rozbitým vstupom mlčí", () => {
  const r = spawnSync("node", [HOOK], { input: "nie json", encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  assert.equal(spawnSync("node", [HOOK], { input: JSON.stringify({ transcript_path: "/nie/je" }), encoding: "utf8" }).stdout, "");
});

test("isReport pozná len skutočné hlásenie", () => {
  assert.ok(isReport("AGENT_NAME=x /opt/agentic-workflow/bin/tk task add --project p"));
  assert.ok(!isReport("tk task show 5"));
  assert.ok(!isReport("tk comment 5 --body 'tk task add'"));
  assert.ok(!isReport("ask_agent.sh --replies"));
});

// Úloha 593: zlyhanie sa nepripíše nástroju, ktorého meno je len text, ani signálu zabitého shellu.
const KILL144 = 'pkill -f "serve --port 28589"; cd /opt/agentic-workflow && node --test komponenty.test.mjs; '
  + "/opt/agentic-workflow/browser.sh --exec 'x'; /opt/agentic-workflow/browser.sh --gaps http://127.0.0.1:28589/";

test("replay behu 114 úlohy 589: pkill zabil vlastný shell (kód 144), browser.sh skončil kódom 0, nehlási sa", () => {
  const out = "Exit code 144\nok 1 - komponenty.test.mjs";
  assert.equal(unreported([user("x"), ...fail(KILL144, out)]), null);
  assert.equal(hook([user("x"), ...fail(KILL144, out)]), null);
  for (const code of [137, 143, 144]) {
    assert.equal(unreported([user("x"), ...fail(`kill $PID; ${BROWSER}`, `Exit code ${code}\nx`)]), null, String(code));
    assert.equal(unreported([user("x"), ...fail(`killall node && ${BROWSER}`, `Exit code ${code}\nx`)]), null, String(code));
  }
});

test("kill v príkaze neskryje obyčajné zlyhanie nástroja ani signál bez kill", () => {
  assert.ok(unreported([user("x"), ...fail(`pkill -f x; ${BROWSER}`, ERR)]));
  assert.ok(unreported([user("x"), ...fail(BROWSER, "Exit code 143\nTerminated")]));
  assert.ok(unreported([user("x"), ...fail(`echo "pkill x"; ${BROWSER}`, "Exit code 144\nx")]));
});

test("meno nástroja len v texte, argumente alebo hľadaní nie je spustený nástroj", () => {
  for (const cmd of [
    "grep browser.sh x; false",
    "cd /opt/agentic-workflow && grep browser.sh x; false",
    "echo /opt/agentic-workflow/browser.sh; false",
    "grep -n /opt/agentic-workflow/browser.sh x.txt; false",
    "cat /opt/agentic-workflow/browser.sh | head; false",
    "git commit -m 'oprava /opt/agentic-workflow/browser.sh'; false",
    "command -v /opt/agentic-workflow/browser.sh; false",
    "cd /opt/agentic-workflow && command -v browser.sh; false",
    "bash -n /opt/agentic-workflow/browser.sh; false",
    "node --check /opt/agentic-workflow/browser.mjs; false",
  ]) {
    assert.equal(sharedTool(cmd), null, cmd);
    assert.equal(unreported([user("x"), ...fail(cmd, "Exit code 1\nx")]), null, cmd);
  }
});

// Úloha 593: kód skončenia patrí poslednému vykonanému úseku.
test("kód patrí poslednému úseku: pri `;` a novom riadku sa hlási len nástroj v poslednom", () => {
  const code1 = (cmd) => unreported([user("x"), ...fail(cmd, "Exit code 1\nnot ok 1 - x.test.mjs")]);
  // nástroj prvý, zlyhal test: kód je testu
  assert.equal(code1(`${BROWSER}; node --test x.test.mjs`), null);
  assert.equal(code1(`${BROWSER}\nnode --test x.test.mjs`), null);
  assert.equal(code1(`${BROWSER}; false`), null);
  assert.equal(code1(`cd /opt/agentic-workflow && ./browser.sh --gaps x; node --test x.test.mjs`), null);
  // nástroj posledný: kód je jeho
  assert.ok(code1(`node x; ${BROWSER}`));
  assert.ok(code1(`node --test x.test.mjs\n${BROWSER}`));
  assert.ok(code1(`false; echo a; ${BROWSER}`));
  assert.ok(code1(`cd /opt/agentic-workflow; ./browser.sh --gaps x`));
});

test("kód pri &&, ||, rúre a zloženom príkaze", () => {
  const code1 = (cmd) => unreported([user("x"), ...fail(cmd, "Exit code 1\nx")]);
  // && : kód môže patriť ktorémukoľvek úseku reťazca
  assert.ok(code1(`${BROWSER} && node x`));
  assert.ok(code1(`node x && ${BROWSER}`));
  assert.ok(code1(`echo a; ${BROWSER} && node x`));
  assert.equal(code1(`${BROWSER}; node x && node y`), null);
  // || : chyba pred ním je ošetrená, platí úsek za posledným ||
  assert.equal(code1(`${BROWSER} || node x`), null);
  assert.equal(code1(`${BROWSER} && node y || node x`), null);
  assert.ok(code1(`node x || ${BROWSER}`));
  // rúra: platí posledný príkaz rúry
  assert.equal(code1(`${BROWSER} | head`), null);
  assert.equal(code1(`${BROWSER} 2>&1 | tail -5`), null);
  assert.ok(code1(`node x | ${BROWSER}`));
  assert.ok(code1(`echo a && ${BROWSER} 2>&1`));
  // zložený príkaz (if, for, podshell): bez rozlišovania úsekov, hlási sa nástroj kdekoľvek
  assert.ok(code1(`if true; then ${BROWSER}; fi`));
  assert.ok(code1(`for i in 1; do ${BROWSER}; done`));
  assert.ok(code1(`(${BROWSER}; true)`));
});

// Úloha 608: replay z prepisu, príkaz `$T done 605` skončil kódom 64 a hook ho pripísal `sys.stdin`.
const REPLAY_CMD = "cd /opt/agentic-workflow && git log --oneline -1 0a38886 && grep -c \"operatorSection\" morning.mjs && T=/opt/agentic-workflow/bin/tk && $T done 605 --summary \"Kontrola. Funguje: commit 0a38886 v agentic-workflow, node --test 385 testov, 0 fail; živé počty pre okno do 26. 10. 07:00: 2 úlohy od operátora (582, 587), 0 posunov poradia, 9 komentárov za operátora (2 navyše sú Ninine citácie operátora na 541), 41 správ operátora v T3. Sedí s plánom: časť Zásahy operátora v build() za Rozložením práce, persona b1a30e1. Jednoduché: jedna funkcia a jeden test, nič navyše. Ďalšie analytické časti robí úloha 607.\" >/dev/null && $T task show 607 --json | python3 -c \"import json,sys;d=json.load(sys.stdin);print(d['status'],d['blockers'])\"";
const REPLAY_OUT = "Exit code 64\n0a38886 Ranný súhrn: zásahy operátora za 24 h z Taskera a T3 (úloha 605)\n3\ntk nevie, ktorý agent volá Tasker (AGENT_NAME, TASKER_USER ani PERSONA.md v /opt/agentic-workflow)\nSprávny postup: AGENT_NAME=<meno> tk ...";

test("replay úlohy 608: tk s kódom 64 a python3 -c nie je zlyhanie spoločného nástroja", () => {
  assert.equal(unreported([user("x"), ...fail(REPLAY_CMD, REPLAY_OUT)]), null);
  assert.equal(hook([user("x"), ...fail(REPLAY_CMD, REPLAY_OUT)]), null);
});

test("608 bod 1: kód python, node, perl a ruby sa nedelí ako shell", () => {
  const py = 'import json,sys;d=json.load(sys.stdin);print(d["a"])';
  for (const cmd of [
    `cd /opt/agentic-workflow && /root/adam/x.sh | python3 -c "${py}"`,
    `cd /opt/agentic-workflow && /root/adam/x.sh | python3 -I -c '${py}'`,
    `cd /opt/agentic-workflow && /root/adam/x.sh | node -e "const d=JSON.parse(require('fs').readFileSync(0));console.log(d.a)"`,
    `cd /opt/agentic-workflow && /root/adam/x.sh | node --print "process.stdin.fd"`,
    `cd /opt/agentic-workflow && /root/adam/x.sh | perl -e 'print sys.stdin'`,
    `cd /opt/agentic-workflow && /root/adam/x.sh | ruby -e "puts a.b(c)"`,
  ]) {
    assert.equal(sharedTool(cmd), null, cmd);
    assert.equal(unreported([user("x"), ...fail(cmd, "Exit code 1\nx")]), null, cmd);
  }
  // `bash -c` ostáva shell a nástroj v ňom sa hlási, rovnako python3 s nástrojom mimo reťazca
  assert.ok(sharedTool(`bash -c "cd /opt/agentic-workflow && ./browser.sh --gaps x"`));
  assert.ok(sharedTool(`python3 -c "print(1)" && ${BROWSER}`));
  assert.ok(sharedTool(`cd /opt/agentic-workflow && python3 -c "print(1)"; ./browser.sh x`));
});

test("608 bod 2: premenná s cestou nástroja sa v mene príkazu rozvinie", () => {
  for (const cmd of [
    "T=/opt/agentic-workflow/x.sh; $T done 5",
    "T=/opt/agentic-workflow/x.sh && $T done 5",
    "export T=/opt/agentic-workflow/x.sh; ${T} done 5",
    "cd /root/adam && T=/opt/agentic-workflow/x.sh && $T done 5 2>&1",
  ]) {
    const f = unreported([user("x"), ...fail(cmd, "Exit code 2\nboom")]);
    assert.equal(f?.tool, "/opt/agentic-workflow/x.sh", cmd);
    assert.equal(f.code, "2");
  }
  // tk cez premennú je chyba volajúceho ako `tk` priamo, nepriradená premenná nič nehlási
  assert.equal(sharedTool("T=/opt/agentic-workflow/bin/tk && $T done 605"), null);
  assert.equal(sharedTool("$T done 5"), null);
});

test("608 bod 3: výstup s riadkom Správny postup je chyba volajúceho, nie nástroja", () => {
  const caller = "Exit code 64\ntk nevie, ktorý agent volá Tasker\nSprávny postup: AGENT_NAME=<meno> tk ...";
  assert.equal(unreported([user("x"), ...fail("/opt/agentic-workflow/reply.sh abc", caller)]), null);
  assert.equal(unreported([user("x"), ...fail("/opt/agentic-workflow/bin/kontext.sh spanok", caller)]), null);
  assert.ok(unreported([user("x"), ...fail("/opt/agentic-workflow/reply.sh abc", "Exit code 64\ntk nevie, ktorý agent volá Tasker")]));
  // text "Správny postup:" v strede riadka nie je odmietnutie
  assert.ok(unreported([user("x"), ...fail("/opt/agentic-workflow/reply.sh abc", "Exit code 1\nvýpis Správny postup: x")]));
});

test("608 bod 4: output hlásenia je posledný neprázdny riadok výstupu", () => {
  const f = unreported([user("x"), ...fail("/opt/agentic-workflow/x.sh", "Exit code 1\nstarý riadok\n\nchyba: nemám token\n\n")]);
  assert.equal(f.output, "chyba: nemám token");
  assert.equal(unreported([user("x"), ...fail("/opt/agentic-workflow/x.sh", "Exit code 1")]).output, "");
});

// Úloha 611: replay z prepisu c1c3e54a, `git commit -- <nový súbor> && ... && kontext.sh`
// skončil kódom 1 s "error: pathspec", kontext.sh sa nespustil.
const REPLAY_611 = "cat > memory/topics/navrh-overenie.md <<'EOF'\n---\nname: navrh-overenie\n---\ntext\nEOF\n"
  + "echo '- [Overenie návrhu](topics/navrh-overenie.md) — b7c6c6e' >> memory/MEMORY.md\n"
  + "git commit -q -m \"Pamäť: pravidlo overeného návrhu, čaká Mac\" -- memory/MEMORY.md memory/topics/navrh-overenie.md"
  + " && git fetch -q origin && git rebase -q origin/main && git push -q origin HEAD:main && git status --short"
  + " && /opt/agentic-workflow/bin/kontext.sh spanok --stav \"b7c6c6e nasadené, čaká Mac\"";
const OUT_611 = "Exit code 1\nerror: pathspec 'memory/topics/navrh-overenie.md' did not match any file(s) known to git";

test("replay úlohy 611: git commit zlyhal v reťazci &&, kontext.sh sa nehlási", () => {
  assert.equal(unreported([user("x"), ...fail(REPLAY_611, OUT_611)]), null);
  assert.equal(hook([user("x"), ...fail(REPLAY_611, OUT_611)]), null);
  assert.equal(sharedTool("git commit -- x && /opt/agentic-workflow/bin/kontext.sh spanok", OUT_611), null);
  // ten istý reťazec bez podpisu git vo výstupe: kód môže byť nástroja, hlási sa
  assert.ok(sharedTool("git commit -- x && /opt/agentic-workflow/bin/kontext.sh spanok", "Exit code 1\nx"));
  assert.ok(unreported([user("x"), ...fail("git commit -- x && /opt/agentic-workflow/bin/kontext.sh spanok", "Exit code 1\nx")]));
});

test("611: podpis iného úseku reťazca && patrí jemu, podpis nástroja nástroju", () => {
  const tool = "/opt/agentic-workflow/reply.sh abc";
  const cases = [
    // [príkaz, výstup, hlási sa nástroj]
    [`cat x.md && ${tool}`, "Exit code 1\ncat: x.md: No such file or directory", false],
    [`mkdir /a/b && ${tool}`, "Exit code 1\nmkdir: cannot create directory '/a/b': No such file or directory", false],
    [`nieje && ${tool}`, "Exit code 127\n/bin/bash: line 1: nieje: command not found", false],
    [`node x.mjs && ${tool}`, "Exit code 1\nError: boom\n    at main (/root/adam/x.mjs:3:9)", false],
    [`python3 x.py && ${tool}`, "Exit code 1\nTraceback (most recent call last):\n  File \"x.py\", line 1\nKeyError: 'a'", false],
    [`npm run build && ${tool}`, "Exit code 1\nnpm ERR! missing script: build", false],
    [`git push -q && ${tool}`, "Exit code 1\nfatal: could not read from remote repository", false],
    // úsek za nástrojom: jeho podpis znamená, že nástroj prešiel
    [`${tool} && git commit -- x`, "Exit code 1\nerror: pathspec 'x' did not match any file(s) known to git", false],
    // podpis nástroja: kód je jeho, aj keď git je v reťazci
    [`git commit -- x && ${tool}`, "Exit code 1\nreply.sh: správa abc nie je v schránke", true],
    [`git commit -- x && node /opt/agentic-workflow/x.mjs`, "Exit code 1\nError: boom\n    at run (/opt/agentic-workflow/x.mjs:5:3)", true],
    // git pred || je ošetrené, jeho podpis vo výstupe nezbaví nástroj kódu
    [`git commit -- x || ${tool}`, "Exit code 1\nerror: pathspec 'x' did not match any file(s) known to git", true],
    // iný príkaz v inom úseku oddelenom `;` kód nemá, podpis tam nerozhoduje
    [`git commit -- x; ${tool}`, "Exit code 1\nerror: pathspec 'x' did not match any file(s) known to git", true],
  ];
  for (const [cmd, out, reported] of cases) {
    assert.equal(Boolean(unreported([user("x"), ...fail(cmd, out)])), reported, cmd);
  }
});
