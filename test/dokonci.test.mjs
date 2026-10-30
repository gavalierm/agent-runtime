// Test skillu dokonci (úloha Taskera 617). Dočasné repá v /tmp, falošný tasker,
// žiadny živý Tasker ani hooky repa (GIT_CONFIG_GLOBAL=/dev/null).
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "dokonci", "scripts", "dokonci.sh");
const GIT_ENV = {
  GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
};

function git(cwd, ...args) {
  const r = spawnSync("git", ["-C", cwd, ...args], { env: { ...process.env, ...GIT_ENV }, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

const TMPS = [];
after(() => { for (const t of TMPS) rmSync(t, { recursive: true, force: true }); });

// Origin (bare) s main a jedným commitom, klon v `kde` (s /projekty/ alebo bez).
function setup(underProjekty) {
  const tmp = mkdtempSync(join(tmpdir(), "dokonci-test-"));
  TMPS.push(tmp);
  const origin = join(tmp, "origin.git");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin], { env: { ...process.env, ...GIT_ENV } });
  const parent = underProjekty ? join(tmp, "projekty") : join(tmp, "ine");
  mkdirSync(parent, { recursive: true });
  const clone = join(parent, "klon");
  spawnSync("git", ["clone", "-q", origin, clone], { env: { ...process.env, ...GIT_ENV } });
  writeFileSync(join(clone, "README.md"), "x\n");
  git(clone, "add", "README.md");
  git(clone, "commit", "-q", "-m", "prvy");
  git(clone, "push", "-q", "origin", "main");
  const tasker = join(tmp, "tasker.sh");
  const log = join(tmp, "tasker.log");
  writeFileSync(tasker, '#!/bin/bash\n{ echo CALL; for a in "$@"; do printf "ARG<<%s>>\\n" "$a"; done; } >> "$TASKER_LOG"\nexit 0\n');
  chmodSync(tasker, 0o755);
  const ledgerDir = join(tmp, "ledger");
  const env = { ...process.env, ...GIT_ENV, DOKONCI_TASKER: tasker, DOKONCI_LEDGER_DIR: ledgerDir, TASKER_LOG: log };
  const dok = (...args) => {
    const r = spawnSync("bash", [SCRIPT, ...args], { cwd: clone, env, encoding: "utf8" });
    return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
  };
  return { tmp, origin, clone, log, ledgerDir, env, dok };
}

function commit(clone, name) {
  writeFileSync(join(clone, name), name + "\n");
  git(clone, "add", name);
  git(clone, "commit", "-q", "-m", "zmena " + name);
}

function expectFail(r, re) {
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^Správny postup:/m, r.out);
  if (re) assert.match(r.out, re, r.out);
}

test("bez argumentov vypíše použitie a Správny postup", () => {
  const r = spawnSync("bash", [SCRIPT], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Použitie:/);
  assert.match(r.stderr, /^Správny postup:/m);
});

test("start vytvorí dev, ledger a hlavičku (politika dev podľa /projekty/)", () => {
  const s = setup(true);
  const r = s.dok("start", "617");
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /politika: dev/);
  assert.equal(git(s.clone, "rev-parse", "--abbrev-ref", "HEAD"), "dev");
  const led = readFileSync(join(s.ledgerDir, "dokonci-617.md"), "utf8");
  assert.match(led, /^@start\t.*\tpolitika=dev\tvetva=dev\tbase=[0-9a-f]{40}/m);
});

test("start odmietne neprázdny strom a neplatné číslo úlohy", () => {
  const s = setup(true);
  writeFileSync(join(s.clone, "spina.txt"), "x");
  expectFail(s.dok("start", "617"), /strom nie je čistý/);
  expectFail(s.dok("start", "abc"));
});

test("koniec bez commitu, bez dôkazu a bez posudku zlyhá", () => {
  const s = setup(true);
  assert.equal(s.dok("start", "617").status, 0);
  expectFail(s.dok("koniec", "617", "--vysledok", "V"), /žiadny commit/);
  commit(s.clone, "a.txt");
  expectFail(s.dok("koniec", "617", "--vysledok", "V"), /dôkaz/);
  assert.equal(s.dok("dokaz", "617", "--popis", "test", "--", "true").status, 0);
  expectFail(s.dok("koniec", "617", "--vysledok", "V"), /posudok/);
  assert.equal(git(s.origin, "rev-list", "--count", "main"), "1");
});

test("dôkaz pred posledným commitom a dôkaz s kódom ≠ 0 nestačia", () => {
  const s = setup(true);
  s.dok("start", "617");
  commit(s.clone, "a.txt");
  assert.equal(s.dok("dokaz", "617", "--popis", "stary", "--", "true").status, 0);
  commit(s.clone, "b.txt");
  assert.equal(s.dok("posudok", "617", "--kolo", "1", "--verdikt", "ok", "--text", "ok").status, 0);
  expectFail(s.dok("koniec", "617", "--vysledok", "V"), /dôkaz/);
  const f = s.dok("dokaz", "617", "--popis", "padá", "--", "bash", "-c", "echo zle; exit 3");
  assert.equal(f.status, 3);
  expectFail(s.dok("koniec", "617", "--vysledok", "V"), /dôkaz/);
  const led = readFileSync(join(s.ledgerDir, "dokonci-617.md"), "utf8");
  assert.match(led, /prikaz=bash -c echo zle; exit 3\tkod=3/);
  assert.match(led, /^ {4}zle$/m);
});

test("dokaz --subor overí, že súbor existuje a nie je prázdny", () => {
  const s = setup(true);
  s.dok("start", "617");
  const snimka = join(s.tmp, "snimka.png");
  expectFail(s.dok("dokaz", "617", "--popis", "web", "--subor", snimka), /neexistuje/);
  writeFileSync(snimka, "");
  expectFail(s.dok("dokaz", "617", "--popis", "web", "--subor", snimka), /prázdny/);
  writeFileSync(snimka, "png");
  assert.equal(s.dok("dokaz", "617", "--popis", "web", "--subor", snimka).status, 0);
  commit(s.clone, "a.txt");
  s.dok("posudok", "617", "--kolo", "1", "--verdikt", "ok", "--text", "ok");
  assert.equal(s.dok("koniec", "617", "--vysledok", "Web hotový").status, 0);
});

test("celý beh: dôkaz, posudok ok, koniec zlúči dev do main, pushne a ohlási úlohu", () => {
  const s = setup(true);
  s.dok("start", "617");
  commit(s.clone, "a.txt");
  assert.equal(s.dok("dokaz", "617", "--popis", "test prejde", "--", "true").status, 0);
  s.dok("rozhodnutie", "617", "--text", "zvolil som najmenšiu zmenu");
  assert.equal(s.dok("posudok", "617", "--kolo", "1", "--verdikt", "ok", "--text", "nič nezlyhá").status, 0);
  const r = s.dok("koniec", "617", "--vysledok", "Pridaný a.txt", "--otvorene", "dokumentácia");
  assert.equal(r.status, 0, r.out);
  assert.equal(git(s.origin, "rev-list", "--merges", "--count", "main"), "1");
  assert.match(git(s.origin, "log", "-1", "--format=%s", "main"), /^Merge dev: Pridaný a\.txt \(úloha 617\)$/);
  assert.equal(git(s.origin, "rev-parse", "dev"), git(s.clone, "rev-parse", "dev"));
  const log = readFileSync(s.log, "utf8");
  assert.match(log, /CALL\nARG<<comment>>\nARG<<617>>\nARG<<--body>>\nARG<<Výsledok: Pridaný a\.txt\nDôkaz: test prejde \(kód 0\)\nOtvorené: dokumentácia\n/);
  assert.match(log, /Rozhodnutia: zvolil som najmenšiu zmenu/);
  assert.match(log, /Posudok: kolo 1 ok/);
  assert.match(log, /CALL\nARG<<result>>\nARG<<done>>\nARG<<--summary>>\nARG<<Pridaný a\.txt>>\n/);
});

// DOKONCI_TASKER môže byť príkaz s argumentmi ("node /opt/tasker/bin/tasker", úloha 628,
// beh 128 Lea): koniec aj otazka ho musia rozdeliť na slová.
test("DOKONCI_TASKER s argumentmi (node <skript>): koniec aj otazka prejdú", () => {
  const s = setup(true);
  const fake = join(s.tmp, "fake-tasker.mjs");
  writeFileSync(fake, 'import { appendFileSync } from "node:fs";\nappendFileSync(process.env.TASKER_LOG, "CALL\\n" + process.argv.slice(2).map((a) => `ARG<<${a}>>\\n`).join(""));\n');
  const dok = (...args) => {
    const r = spawnSync("bash", [SCRIPT, ...args], { cwd: s.clone, env: { ...s.env, DOKONCI_TASKER: `node ${fake}` }, encoding: "utf8" });
    return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
  };
  assert.equal(dok("start", "617").status, 0);
  commit(s.clone, "a.txt");
  assert.equal(dok("dokaz", "617", "--popis", "test", "--", "true").status, 0);
  assert.equal(dok("posudok", "617", "--kolo", "1", "--verdikt", "ok", "--text", "ok").status, 0);
  const r = dok("koniec", "617", "--vysledok", "Hotovo");
  assert.equal(r.status, 0, r.out);
  const q = dok("otazka", "617", "--summary", "Q? A) a B) b");
  assert.equal(q.status, 0, q.out);
  const log = readFileSync(s.log, "utf8");
  assert.match(log, /CALL\nARG<<comment>>\nARG<<617>>/);
  assert.match(log, /CALL\nARG<<result>>\nARG<<done>>\nARG<<--summary>>\nARG<<Hotovo>>\n/);
  assert.match(log, /CALL\nARG<<result>>\nARG<<needs_human>>\nARG<<--summary>>\nARG<<Q\? A\) a B\) b>>\n/);
});

test("koniec --stop pushne len dev a doplní Otvorené", () => {
  const s = setup(true);
  s.dok("start", "617");
  commit(s.clone, "a.txt");
  s.dok("dokaz", "617", "--popis", "ok", "--", "true");
  s.dok("posudok", "617", "--kolo", "1", "--verdikt", "ok", "--text", "ok");
  const mainPred = git(s.origin, "rev-parse", "main");
  const r = s.dok("koniec", "617", "--stop", "--vysledok", "Hotové na dev");
  assert.equal(r.status, 0, r.out);
  assert.equal(git(s.origin, "rev-parse", "main"), mainPred);
  assert.equal(git(s.origin, "rev-parse", "dev"), git(s.clone, "rev-parse", "dev"));
  assert.match(readFileSync(s.log, "utf8"), /Otvorené: merge dev do main\n/);
});

test("posudok: kolo 4 zlyhá, verdikt zmeny blokuje koniec, kolo 2 ok ho pustí", () => {
  const s = setup(true);
  s.dok("start", "617");
  commit(s.clone, "a.txt");
  s.dok("dokaz", "617", "--popis", "ok", "--", "true");
  expectFail(s.dok("posudok", "617", "--kolo", "4", "--verdikt", "ok", "--text", "x"), /rozpočet[^]*dokonci\.sh otazka 617 --summary/);
  expectFail(s.dok("posudok", "617", "--kolo", "1", "--verdikt", "možno", "--text", "x"));
  assert.equal(s.dok("posudok", "617", "--kolo", "1", "--verdikt", "zmeny", "--text", "chýba test").status, 0);
  expectFail(s.dok("koniec", "617", "--vysledok", "V"), /žiada zmeny[^]*dokonci\.sh otazka 617 --summary/);
  assert.equal(s.dok("posudok", "617", "--kolo", "2", "--verdikt", "ok", "--text", "teraz ok").status, 0);
  assert.equal(s.dok("koniec", "617", "--vysledok", "V").status, 0);
});

test("neúspešný tasker po pushi dá Správny postup", () => {
  const s = setup(true);
  s.dok("start", "617");
  commit(s.clone, "a.txt");
  s.dok("dokaz", "617", "--popis", "ok", "--", "true");
  s.dok("posudok", "617", "--kolo", "1", "--verdikt", "ok", "--text", "ok");
  const zly = join(s.tmp, "zly.sh");
  writeFileSync(zly, "#!/bin/bash\nexit 7\n");
  chmodSync(zly, 0o755);
  const r = spawnSync("bash", [SCRIPT, "koniec", "617", "--vysledok", "V"], { cwd: s.clone, env: { ...s.env, DOKONCI_TASKER: zly }, encoding: "utf8" });
  expectFail({ status: r.status, out: r.stdout + r.stderr }, /komentár/);
});

test("repo mimo /projekty/ bez dev má politiku main a koniec pushne main", () => {
  const s = setup(false);
  const st = s.dok("start", "617");
  assert.equal(st.status, 0, st.out);
  assert.match(st.out, /politika: main/);
  assert.equal(git(s.clone, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  expectFail(s.dok("koniec", "617", "--stop", "--vysledok", "V"), /--stop/);
  commit(s.clone, "a.txt");
  s.dok("dokaz", "617", "--popis", "ok", "--", "true");
  expectFail(s.dok("koniec", "617", "--vysledok", "V"), /posudok/);
  s.dok("posudok", "617", "--kolo", "1", "--verdikt", "ok", "--text", "ok");
  const r = s.dok("koniec", "617", "--vysledok", "Opravené");
  assert.equal(r.status, 0, r.out);
  assert.equal(git(s.origin, "rev-parse", "main"), git(s.clone, "rev-parse", "HEAD"));
  assert.equal(git(s.origin, "rev-list", "--count", "main"), "2");
  assert.match(readFileSync(s.log, "utf8"), /ARG<<result>>\nARG<<done>>/);
});

// Prostredie bez DOKONCI_LEDGER_DIR, HOME a XDG_STATE_HOME v dočasnom priečinku
// (nikdy skutočný ~/.local/state).
function stateEnv(s, xdg) {
  const env = { ...s.env, HOME: join(s.tmp, "home") };
  delete env.DOKONCI_LEDGER_DIR;
  delete env.XDG_STATE_HOME;
  if (xdg) env.XDG_STATE_HOME = xdg;
  return env;
}

test("ledger predvolene v stavovom priečinku, repo zostane čisté", () => {
  const s = setup(false);
  const env = stateEnv(s);
  const r = spawnSync("bash", [SCRIPT, "start", "617"], { cwd: s.clone, env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const ledger = join(s.tmp, "home", ".local", "state", "agentic-workflow", "dokonci-617.md");
  assert.ok(r.stdout.includes(`ledger: ${ledger}`), r.stdout);
  assert.ok(existsSync(ledger));
  assert.equal(git(s.clone, "status", "--short"), "");
});

test("XDG_STATE_HOME má prednosť pred HOME", () => {
  const s = setup(false);
  const xdg = join(s.tmp, "xdg");
  const r = spawnSync("bash", [SCRIPT, "start", "617"], { cwd: s.clone, env: stateEnv(s, xdg), encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(join(xdg, "agentic-workflow", "dokonci-617.md")));
  assert.ok(!existsSync(join(s.tmp, "home", ".local")));
});

test("dokonci.sh start a hook dokonci_open.mjs ukazujú na ten istý súbor", () => {
  const s = setup(false);
  const env = stateEnv(s);
  const st = spawnSync("bash", [SCRIPT, "start", "617"], { cwd: s.clone, env, encoding: "utf8" });
  assert.equal(st.status, 0, st.stderr);
  const hook = join(dirname(SCRIPT), "..", "..", "..", "hooks", "dokonci_open.mjs");
  const h = spawnSync("node", [hook], { input: JSON.stringify({ cwd: "/tmp" }), env: { ...env, TASKER_TASK_ID: "617" }, encoding: "utf8" });
  assert.equal(h.status, 0, h.stderr);
  const ledger = st.stdout.match(/ledger: (\S+)/)[1];
  assert.equal(JSON.parse(h.stdout).decision, "block");
  assert.ok(JSON.parse(h.stdout).reason.includes(ledger), h.stdout);
});

// Repo, kde vetvu dev drží druhý worktree a beh pracuje v treťom worktree z origin/main
// (Tasker: run-N-tasker). Hlavný klon drží main. Vráti dok() bežiaci v tom treťom.
function setupWorktrees(devAhead) {
  const s = setup(true);
  git(s.clone, "branch", "dev");
  if (devAhead) {
    git(s.clone, "checkout", "-q", "dev");
    commit(s.clone, "d.txt");
    git(s.clone, "checkout", "-q", "main");
  }
  git(s.clone, "push", "-q", "origin", "dev");
  s.wtDev = join(s.tmp, "wt-dev");
  s.wtRun = join(s.tmp, "wt-run");
  git(s.clone, "worktree", "add", "-q", s.wtDev, "dev");
  git(s.clone, "worktree", "add", "-q", "-b", "run-1", s.wtRun, "origin/main");
  s.run = (...args) => {
    const r = spawnSync("bash", [SCRIPT, ...args], { cwd: s.wtRun, env: s.env, encoding: "utf8" });
    return { status: r.status, out: (r.stdout || "") + (r.stderr || "") };
  };
  return s;
}

function dokonciBeh(s, uloha) {
  commit(s.wtRun, "b.txt");
  assert.equal(s.run("dokaz", uloha, "--popis", "test", "--", "true").status, 0);
  assert.equal(s.run("posudok", uloha, "--kolo", "1", "--verdikt", "ok", "--text", "ok").status, 0);
  return s.run("koniec", uloha, "--vysledok", "Pridaný b.txt");
}

test("worktree: dev drží iný worktree, vetva behu z main ostane a koniec zlúči dev aj main", () => {
  const s = setupWorktrees(false);
  const devPred = git(s.wtDev, "rev-parse", "HEAD");
  const st = s.run("start", "624");
  assert.equal(st.status, 0, st.out);
  assert.match(st.out, /politika: dev/);
  assert.equal(git(s.wtRun, "rev-parse", "--abbrev-ref", "HEAD"), "run-1");
  const led = readFileSync(join(s.ledgerDir, "dokonci-624.md"), "utf8");
  assert.match(led, /^@start\t.*\tpolitika=dev\tvetva=run-1\tzaklad=dev\tbase=[0-9a-f]{40}/m);
  const r = dokonciBeh(s, "624");
  assert.equal(r.status, 0, r.out);
  for (const v of ["main", "dev"]) assert.equal(git(s.origin, "show", `${v}:b.txt`), "b.txt");
  // dva merge commity: vetva behu do dev a dev do main
  assert.equal(git(s.origin, "rev-list", "--merges", "--count", "main"), "2");
  assert.match(git(s.origin, "log", "-1", "--format=%s", "main"), /^Merge dev: Pridaný b\.txt \(úloha 624\)$/);
  assert.equal(git(s.wtDev, "rev-parse", "HEAD"), devPred);
  assert.equal(git(s.wtDev, "status", "--short"), "");
  assert.equal(git(s.wtRun, "rev-parse", "--abbrev-ref", "HEAD"), "run-1");
  assert.equal(git(s.clone, "worktree", "list").split("\n").length, 3);
  assert.match(readFileSync(s.log, "utf8"), /ARG<<result>>\nARG<<done>>/);
});

test("worktree: dev je pred main, beh založí vetvu dokonci-<úloha> z dev", () => {
  const s = setupWorktrees(true);
  const st = s.run("start", "624");
  assert.equal(st.status, 0, st.out);
  assert.equal(git(s.wtRun, "rev-parse", "--abbrev-ref", "HEAD"), "dokonci-624");
  assert.equal(git(s.wtRun, "show", "HEAD:d.txt"), "d.txt");
  assert.match(readFileSync(join(s.ledgerDir, "dokonci-624.md"), "utf8"), /\tvetva=dokonci-624\tzaklad=dev\t/);
  const r = dokonciBeh(s, "624");
  assert.equal(r.status, 0, r.out);
  for (const v of ["main", "dev"]) {
    assert.equal(git(s.origin, "show", `${v}:b.txt`), "b.txt");
    assert.equal(git(s.origin, "show", `${v}:d.txt`), "d.txt");
  }
  assert.equal(git(s.clone, "worktree", "list").split("\n").length, 3);
});

test("worktree: koniec --stop pushne len dev a nechá main", () => {
  const s = setupWorktrees(false);
  assert.equal(s.run("start", "624").status, 0);
  commit(s.wtRun, "b.txt");
  s.run("dokaz", "624", "--popis", "ok", "--", "true");
  s.run("posudok", "624", "--kolo", "1", "--verdikt", "ok", "--text", "ok");
  const mainPred = git(s.origin, "rev-parse", "main");
  const r = s.run("koniec", "624", "--stop", "--vysledok", "Na dev");
  assert.equal(r.status, 0, r.out);
  assert.equal(git(s.origin, "rev-parse", "main"), mainPred);
  assert.equal(git(s.origin, "show", "dev:b.txt"), "b.txt");
});

test("otazka zapíše @otazka a falošný tasker dostane result needs_human --summary", () => {
  const s = setup(true);
  assert.equal(s.dok("start", "617").status, 0);
  const q = "Zlúčiť dev do main hneď? A) hneď B) až po kontrole. Odporúčam B.";
  const r = s.dok("otazka", "617", "--summary", q);
  assert.equal(r.status, 0, r.out);
  const led = readFileSync(join(s.ledgerDir, "dokonci-617.md"), "utf8");
  assert.match(led, /^@otazka\t\S+\tsummary=Zlúčiť dev do main hneď\? A\) hneď B\)/m);
  const calls = readFileSync(s.log, "utf8");
  assert.ok(calls.includes(`ARG<<result>>\nARG<<needs_human>>\nARG<<--summary>>\nARG<<${q}>>\n`), calls);
});

test("otazka bez start, bez --summary a pri zlyhaní Taskera dá Správny postup", () => {
  const s = setup(true);
  expectFail(s.dok("otazka", "617", "--summary", "Q?"), /start nebežal[^]*dokonci\.sh start 617/);
  assert.equal(s.dok("start", "617").status, 0);
  expectFail(s.dok("otazka", "617"), /chýba --summary/);
  const bad = join(s.tmp, "tasker-zly.sh");
  writeFileSync(bad, "#!/bin/bash\necho 'invalid run identity' >&2\nexit 1\n");
  chmodSync(bad, 0o755);
  const r = spawnSync("bash", [SCRIPT, "otazka", "617", "--summary", "Q? A) a B) b"], { cwd: s.clone, env: { ...s.env, DOKONCI_TASKER: bad }, encoding: "utf8" });
  expectFail({ status: r.status, out: r.stdout + r.stderr }, /tasker result needs_human zlyhal/);
});
