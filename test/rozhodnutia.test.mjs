// Test lib/rozhodnutia.mjs a bin/rozhodni.sh. Všetko beží v dočasných
// priečinkoch a dočasnom repe s bare origin, skript dostane vždy
// AGENT_BRAIN_GLOBAL a nikdy ROZHODNI_SYNC_UNIT, takže nemá cestu na živý klon
// ani sync. Spustenie: node --test test/rozhodnutia.test.mjs
import "../lib/git_isolate.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { check, context, formatRecord, loadAll, parseRecord, problems, select } from "../lib/rozhodnutia.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const ROZSAHY = join(HERE, "fixtures", "rozhodnutia", "ROZSAHY.md");
const CLI = join(REPO, "lib", "rozhodnutia.mjs");
const SH = join(REPO, "bin", "rozhodni.sh");
const tmp = () => mkdtempSync(join(tmpdir(), "rozhodnutia-"));

const zaklad = {
  id: "D0001", nazov: "Sandbox ostáva zapnutý", stav: "platí", kluc: "server.t3.sandbox", rozsah: "server, t3", agenti: "alfa, beta",
  rozhodol: "Operátor", moc: "operator", zapisal: "Alfa", datum: "2026-10-22", zdroj: "vlákno Alfa, 22. 10.", uloha: "", nahradza: "",
  nahradene: "", alias: "R153.sandbox", subory: "", "zrusene-tvrdenie": "", telo: "Sandbox ostáva zapnutý, dôvod je bezpečnosť.", nezname: [],
};
const rec = (o) => ({ ...zaklad, ...o, file: `${o.id || zaklad.id}.md` });

// Priečinok decisions/ s kópiou ROZSAHY.md a danými záznamami.
function fixtura(records = [], { index = true } = {}) {
  const root = tmp();
  const dir = join(root, "decisions");
  mkdirSync(dir);
  copyFileSync(ROZSAHY, join(dir, "ROZSAHY.md"));
  // Ukážková tabuľka agentov: roles/agents.md patrí repu s rozhodnutiami, nie tomuto repu.
  mkdirSync(join(root, "roles"));
  writeFileSync(join(root, "roles", "agents.md"), "| Meno | Rola |\n|---|---|\n| Operátor | operátor |\n| Alfa | správca agentov |\n| Beta | správca servera, pracovný agent |\n| Gama | dizajnér |\n| Delta | zástupca operátora |\n");
  for (const r of records) writeFileSync(join(dir, `${r.id}.md`), formatRecord(r));
  if (index) cli(dir, "index");
  return { root, dir };
}
const cli = (dir, ...a) => spawnSync("node", [CLI, ...a, "--dir", dir], { encoding: "utf8", input: "" });

test("záznam prejde cez parse a format bez zmeny", () => {
  const r = parseRecord(formatRecord(rec({})), "D0001.md");
  assert.equal(r.kluc, "server.t3.sandbox");
  assert.equal(formatRecord(r), formatRecord(rec({})));
});

test("čistá fixtúra prejde kontrolou, prázdny priečinok bez INDEX.md tiež", () => {
  const { root, dir } = fixtura([rec({})]);
  try {
    assert.deepEqual(check(dir), []);
    assert.equal(cli(dir, "check").status, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
  const e = fixtura([], { index: false });
  try { assert.deepEqual(check(e.dir), []); } finally { rmSync(e.root, { recursive: true, force: true }); }
});

test("dva platné záznamy s rovnakým kľúčom bez nahradza zlyhajú", () => {
  const { root, dir } = fixtura([rec({}), rec({ id: "D0002", alias: "" })]);
  try {
    const r = cli(dir, "check");
    assert.equal(r.status, 1);
    assert.match(r.stdout, /server\.t3\.sandbox má viac platných záznamov: D0001, D0002/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("kontrola odmietne neznámy rozsah, nedostatočnú moc, zlý stav a index mimo súborov", () => {
  const { root, dir } = fixtura([
    rec({ id: "D0001", rozsah: "vymyslene", kluc: "a.a" }),
    rec({ id: "D0002", rozsah: "pravidla", moc: "spravca-servera", kluc: "a.b", alias: "" }),
    rec({ id: "D0003", stav: "hotovo", kluc: "a.c", alias: "" }),
    rec({ id: "D0004", rozhodol: "Operátor", zdroj: "povedal", kluc: "a.d", alias: "" }),
    rec({ id: "D0005", agenti: "neznamy", kluc: "a.e", alias: "" }),
    rec({ id: "D0006", subory: "global/neexistuje.md", kluc: "a.f", alias: "" }),
    rec({ id: "D0007", "zrusene-tvrdenie": "(", kluc: "a.g", alias: "" }),
  ], { index: false });
  try {
    writeFileSync(join(dir, "INDEX.md"), "zlý\n");
    const t = check(dir).join("\n");
    for (const re of [/rozsah 'vymyslene'/, /moc spravca-servera nestačí na rozsah pravidla/, /stav 'hotovo'/, /zdroj musí niesť/, /agent 'neznamy'/, /neexistuje\.md' neexistuje/, /platný regulárny výraz/, /INDEX\.md nesedí/])
      assert.match(t, re);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("nahradza a nahradene musia ukazovať na seba, alias musí byť jedinečný", () => {
  const { root, dir } = fixtura([
    rec({ id: "D0001", stav: "nahradené", nahradene: "D0002", kluc: "a.a" }),
    rec({ id: "D0002", nahradza: "", kluc: "a.a" }),
    rec({ id: "D0003", kluc: "a.b" }),
  ]);
  try {
    const t = check(dir).join("\n");
    assert.match(t, /nahradene D0002, ale D0002 nemá nahradza D0001/);
    assert.match(t, /alias R153\.sandbox má aj D0001/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("list filtruje podľa agenta, rozsahu a stavu, záznam v pravidle ukáže až --vsetky", () => {
  const { root, dir } = fixtura([
    rec({ id: "D0001", kluc: "a.a", alias: "" }),
    rec({ id: "D0002", kluc: "a.b", alias: "", agenti: "gama", rozsah: "dizajn" }),
    rec({ id: "D0003", kluc: "a.c", alias: "", agenti: "*", rozsah: "git", subory: "roles/ROLES.md" }),
    rec({ id: "D0004", kluc: "a.d", alias: "", stav: "zrušené", nahradene: "" }),
  ]);
  try {
    const ids = (a) => cli(dir, "list", ...a).stdout.split("\n").filter(Boolean).map((l) => l.split(" ")[0]);
    assert.deepEqual(ids([]), ["D0001", "D0002"]);
    assert.deepEqual(ids(["--agent", "beta"]), ["D0001"]);
    assert.deepEqual(ids(["--agent", "gama"]), ["D0002"]);
    assert.deepEqual(ids(["--rozsah", "dizajn"]), ["D0002"]);
    assert.deepEqual(ids(["--vsetky"]), ["D0001", "D0002", "D0003"]);
    assert.deepEqual(ids(["--agent", "beta", "--vsetky"]), ["D0001", "D0003"]);
    assert.deepEqual(ids(["--stav", "zrušené"]), ["D0004"]);
    assert.equal(select(loadAll(dir), { agent: "beta" }).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const zapisArgy = ["--nazov", "HDD sa nezapája", "--kluc", "server.disky.hdd", "--rozsah", "server", "--agenti", "beta", "--rozhodol", "Operátor", "--moc", "operator", "--zdroj", "vlákno Beta, 23. 10.", "--zapisal", "Beta", "--datum", "2026-10-23"];

test("zapis: dry-run nič nezapíše, zápis dá číslo, alias R153 sa nájde cez show", () => {
  const { root, dir } = fixtura([]);
  try {
    let r = cli(dir, "zapis", ...zapisArgy, "--telo", "HDD sa nezapája.", "--dry-run");
    assert.equal(r.status, 0);
    assert.match(r.stdout, /pridelené D0001/);
    assert.match(r.stdout, /kluc: server\.disky\.hdd/);
    assert.equal(existsSync(join(dir, "D0001.md")), false);
    r = cli(dir, "zapis", ...zapisArgy, "--alias", "R153", "--telo", "HDD sa nezapája, záloha ide mimo stroja.");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.split("\n")[0], "D0001");
    assert.deepEqual(check(dir), []);
    const s = cli(dir, "show", "R153");
    assert.equal(s.status, 0);
    assert.match(s.stdout, /^id: D0001$/m);
    assert.match(cli(dir, "show", "D0001").stdout, /záloha ide mimo stroja/);
    assert.equal(cli(dir, "show", "R999").status, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("zapis: rovnaký kľúč bez nahradza skončí a vypíše platné záznamy, s nahradza prepne starý", () => {
  const { root, dir } = fixtura([]);
  try {
    assert.equal(cli(dir, "zapis", ...zapisArgy, "--telo", "Prvé.").status, 0);
    let r = cli(dir, "zapis", ...zapisArgy, "--telo", "Druhé.");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /pridaj --nahradza D0001/);
    assert.match(r.stderr, /D0001 2026-10-23 server beta Operátor HDD sa nezapája/);
    assert.equal(existsSync(join(dir, "D0002.md")), false);
    r = cli(dir, "zapis", ...zapisArgy, "--nahradza", "D0001", "--telo", "Druhé.");
    assert.equal(r.status, 0, r.stderr);
    const stary = parseRecord(readFileSync(join(dir, "D0001.md"), "utf8"));
    assert.equal(stary.stav, "nahradené");
    assert.equal(stary.nahradene, "D0002");
    assert.deepEqual(check(dir), []);
    assert.equal(cli(dir, "list").stdout.split("\n").filter(Boolean).length, 1);
    r = cli(dir, "zapis", "--zrus", "D0002", "--dovod", "už neplatí");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(parseRecord(readFileSync(join(dir, "D0002.md"), "utf8")).stav, "zrušené");
    assert.deepEqual(check(dir), []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Dočasný repo s bare origin, hooky nemá, e-mail nastavený lokálne.
function repoSOrigin() {
  const root = tmp();
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  for (const k of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE"]) delete env[k];
  const git = (cwd, ...a) => execFileSync("git", a, { cwd, env, stdio: "pipe", encoding: "utf8" });
  const origin = join(root, "origin.git"), repo = join(root, "repo");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, repo);
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "Test");
  mkdirSync(join(repo, "decisions"));
  copyFileSync(ROZSAHY, join(repo, "decisions", "ROZSAHY.md"));
  git(repo, "add", "."); git(repo, "commit", "-qm", "init"); git(repo, "push", "-q", "origin", "HEAD:main");
  const sh = (cwd, args, input = "", extra = {}) => spawnSync("bash", [SH, ...args], {
    cwd, input, encoding: "utf8",
    env: { ...env, AGENT_BRAIN_GLOBAL: cwd, AGENT_NAME: "beta", ROZHODNI_STROJ: "test", ...extra },
  });
  return { root, repo, origin, git, sh };
}

test("rozhodni.sh: dry-run nezapíše nič, zápis commitne pod menom agenta a pushne do origin", () => {
  const t = repoSOrigin();
  try {
    const head = t.git(t.repo, "rev-parse", "HEAD");
    let r = t.sh(t.repo, [...zapisArgy.filter((_, i) => i < 14), "--dry-run"], "HDD sa nezapája.");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /dry-run/);
    assert.equal(t.git(t.repo, "status", "--short"), "");
    assert.equal(t.git(t.repo, "rev-parse", "HEAD"), head);
    assert.equal(t.git(t.origin, "rev-parse", "main"), head);

    r = t.sh(t.repo, zapisArgy.slice(0, 14), "HDD sa nezapája.");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "D0001");
    assert.equal(t.git(t.repo, "log", "-1", "--format=%an|%s").trim(), "Beta (test)|Rozhodnutie D0001: HDD sa nezapája");
    assert.equal(t.git(t.repo, "status", "--short"), "");
    assert.equal(t.git(t.origin, "rev-parse", "main"), t.git(t.repo, "rev-parse", "HEAD"));
    assert.match(t.git(t.origin, "show", "main:decisions/INDEX.md"), /D0001 /);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test("rozhodni.sh: číslo a kľúč z cudzieho pushu sa vezmú po fetchi, kolízia skončí chybou", () => {
  const t = repoSOrigin();
  try {
    const druhy = join(t.root, "druhy");
    t.git(t.root, "clone", "-q", t.origin, druhy);
    t.git(druhy, "config", "user.email", "t@t"); t.git(druhy, "config", "user.name", "Test");
    const r1 = t.sh(druhy, zapisArgy.slice(0, 14), "Cudzí zápis.");
    assert.equal(r1.status, 0, r1.stderr);
    // t.repo o cudzom zápise nevie, skript ho musí stiahnuť sám.
    let r = t.sh(t.repo, ["--nazov", "Iný", "--kluc", "server.iny", "--rozsah", "server", "--agenti", "beta", "--rozhodol", "Operátor", "--moc", "operator", "--zdroj", "vlákno Beta"], "Iný zápis.");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "D0002");
    r = t.sh(t.repo, zapisArgy.slice(0, 14), "Duplicita.");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /pridaj --nahradza D0001/);
    assert.equal(t.git(t.repo, "status", "--short"), "");
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

// Zástupný tasker: vypíše JSON úlohy zo súboru, živý Tasker sa nevolá.
function falosnyTasker(root, json, rc = 0) {
  const f = join(root, "tasker.sh");
  writeFileSync(f, `#!/bin/sh\n[ "$1 $2" = "task show" ] || exit 9\n[ ${rc} = 0 ] || exit ${rc}\ncat <<'EOF'\n${json}\nEOF\n`, { mode: 0o755 });
  return f;
}
const ULOHA_375 = JSON.stringify({ id: 375, title: "Farba plagátov v sandboxe", comments: [{ author: "operator", created_at: Date.UTC(2026, 9, 23, 10) }] });
const bezZdroja = ["--nazov", "Farba plagátov", "--kluc", "dizajn.plagat.farba", "--rozsah", "dizajn", "--agenti", "gama", "--rozhodol", "Operátor", "--moc", "operator"];

test("rozhodni.sh: --z-ulohy vyplní zdroj a úlohu z Taskera, explicitné --zdroj má prednosť, chyba Taskera skončí kódom 1 (replay S7, úloha 470)", () => {
  const t = repoSOrigin();
  try {
    const ok = { ROZHODNI_TASKER: falosnyTasker(t.root, ULOHA_375) };
    let r = t.sh(t.repo, [...bezZdroja, "--z-ulohy", "375", "--dry-run"], "Plagáty ostávajú tmavé.", ok);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^zdroj: úloha 375 "Farba plagátov v sandboxe", komentár operator 2026-10-23$/m);
    assert.match(r.stdout, /^uloha: 375$/m);

    r = t.sh(t.repo, [...bezZdroja, "--z-ulohy", "375"], "Plagáty ostávajú tmavé.", ok);
    assert.equal(r.status, 0, r.stderr);
    assert.match(t.git(t.origin, "show", "main:decisions/D0001.md"), /^uloha: 375$/m);

    r = t.sh(t.repo, [...bezZdroja.map((x) => (x === "dizajn.plagat.farba" ? "dizajn.plagat.iny" : x)), "--z-ulohy", "375", "--zdroj", "vlákno Gama", "--dry-run"], "Iné.", ok);
    assert.match(r.stdout, /^zdroj: vlákno Gama$/m);

    r = t.sh(t.repo, [...bezZdroja, "--z-ulohy", "375", "--dry-run"], "x", { ROZHODNI_TASKER: falosnyTasker(t.root, "", 1) });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /nepodarilo prečítať/);
    r = t.sh(t.repo, [...bezZdroja, "--z-ulohy", "abc", "--dry-run"], "x", ok);
    assert.equal(r.status, 2);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

const iny = ["--nazov", "Iný", "--kluc", "server.iny", "--rozsah", "server", "--agenti", "beta", "--rozhodol", "Operátor", "--moc", "operator", "--zdroj", "vlákno Beta"];

test("rozhodni.sh: offline zápis ostane lokálne, po cudzom zápise s rovnakým číslom sa prečísluje, commitne a pushne (replay S3 a S6, úloha 470)", () => {
  const t = repoSOrigin();
  try {
    const druhy = join(t.root, "druhy");
    t.git(t.root, "clone", "-q", t.origin, druhy);
    t.git(druhy, "config", "user.email", "t@t"); t.git(druhy, "config", "user.name", "Test");
    t.git(t.repo, "remote", "set-url", "origin", join(t.root, "nie-je.git"));
    let r = t.sh(t.repo, zapisArgy.slice(0, 14), "Offline zápis.");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /D0001 je commitnutý len lokálne/);
    assert.equal(t.git(t.repo, "log", "-1", "--format=%s").trim(), "Rozhodnutie D0001: HDD sa nezapája");
    r = t.sh(druhy, ["--nazov", "Cudzí", "--kluc", "server.cudzi", "--rozsah", "server", "--agenti", "beta", "--rozhodol", "Operátor", "--moc", "operator", "--zdroj", "vlákno Beta"], "Cudzí zápis.");
    assert.equal(r.status, 0, r.stderr);
    t.git(t.repo, "remote", "set-url", "origin", t.origin);
    r = t.sh(t.repo, iny, "Iný zápis.");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "D0003");
    assert.equal(existsSync(join(t.repo, ".git", "rebase-merge")), false);
    assert.equal(t.git(t.repo, "status", "--short"), "");
    assert.equal(t.git(t.origin, "rev-parse", "main"), t.git(t.repo, "rev-parse", "HEAD"));
    const log = t.git(t.repo, "log", "--format=%an|%s", "-3").trim().split("\n");
    assert.deepEqual(log, ["Beta (test)|Rozhodnutie D0003: Iný", "Beta (test)|Rozhodnutie D0002: HDD sa nezapája", "Beta (test)|Rozhodnutie D0001: Cudzí"]);
    const idx = t.git(t.origin, "show", "main:decisions/INDEX.md");
    for (const id of ["D0001", "D0002", "D0003"]) assert.match(idx, new RegExp(`^${id} `, "m"));
    assert.deepEqual(cli(join(t.repo, "decisions"), "check").stdout, "");
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test("rozhodni.sh: prečíslovanie s rovnakým kľúčom nepôjde, klon sa vráti na pôvodný lokálny commit (replay S3, úloha 470)", () => {
  const t = repoSOrigin();
  try {
    const druhy = join(t.root, "druhy");
    t.git(t.root, "clone", "-q", t.origin, druhy);
    t.git(druhy, "config", "user.email", "t@t"); t.git(druhy, "config", "user.name", "Test");
    t.git(t.repo, "remote", "set-url", "origin", join(t.root, "nie-je.git"));
    t.sh(t.repo, zapisArgy.slice(0, 14), "Offline zápis.");
    const lokalny = t.git(t.repo, "rev-parse", "HEAD");
    const r1 = t.sh(druhy, zapisArgy.slice(0, 14), "Opačný zápis.");
    assert.equal(r1.status, 0, r1.stderr);
    t.git(t.repo, "remote", "set-url", "origin", t.origin);
    const r = t.sh(t.repo, iny, "Iný zápis.");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /pridaj --nahradza D0001/);
    assert.equal(t.git(t.repo, "rev-parse", "HEAD"), lokalny);
    assert.equal(t.git(t.repo, "status", "--short"), "");
    assert.equal(existsSync(join(t.repo, ".git", "rebase-merge")), false);
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test("rozhodni.sh: commit odmietnutý hookom nechá klon čistý, ďalší zápis prejde (replay S2, úloha 404)", () => {
  const t = repoSOrigin();
  try {
    const hook = join(t.repo, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\necho odmietnuté >&2\nexit 1\n", { mode: 0o755 });
    let r = t.sh(t.repo, zapisArgy.slice(0, 14), "Zápis.");
    assert.equal(r.status, 1);
    assert.equal(t.git(t.repo, "status", "--short"), "");
    rmSync(hook);
    r = t.sh(t.repo, zapisArgy.slice(0, 14), "Zápis.");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), "D0001");
  } finally { rmSync(t.root, { recursive: true, force: true }); }
});

test("check: moc musí držať ten, kto rozhodol; Gama s mocou operator na rozsah pravidla je odmietnutá (replay S8, úloha 470)", () => {
  const { root, dir } = fixtura([
    rec({ id: "D0001", rozhodol: "Gama", moc: "operator", rozsah: "pravidla", kluc: "a.a", alias: "", agenti: "gama", zapisal: "Gama" }),
    rec({ id: "D0002", rozhodol: "Gama", moc: "operator", rozsah: "dizajn", kluc: "a.b", alias: "", agenti: "gama", zapisal: "Gama" }),
    rec({ id: "D0003", rozhodol: "Operátor", moc: "operator", rozsah: "pravidla", kluc: "a.c", alias: "", zapisal: "Gama" }),
    rec({ id: "D0004", rozhodol: "Alfa", moc: "spravca-agentov", rozsah: "pravidla", kluc: "a.d", alias: "" }),
    rec({ id: "D0005", rozhodol: "Beta", moc: "pracovny-agent", rozsah: "dizajn", kluc: "a.e", alias: "" }),
    rec({ id: "D0006", rozhodol: "Alfa", moc: "operator", rozsah: "dizajn", kluc: "a.f", alias: "" }),
    rec({ id: "D0007", stav: "zrušené", rozhodol: "Delta", moc: "spravca-agentov", rozsah: "dizajn", kluc: "a.g", alias: "" }),
  ]);
  try {
    const t = check(dir).filter((l) => /nemá/.test(l));
    assert.equal(t.length, 3, t.join("\n"));
    assert.match(t[0], /^D0001\.md: moc operator nemá Gama podľa roles\/agents\.md/);
    assert.match(t[1], /^D0002\.md: moc operator nemá Gama/);
    assert.match(t[2], /^D0006\.md: moc operator nemá Alfa/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("check: rovnaký názov pri rôznych kľúčoch je upozornenie, kód ostáva 0 (replay S9, úloha 470)", () => {
  const { root, dir } = fixtura([
    rec({ id: "D0001", nazov: "Behy Taskera bežia v druhej inštancii T3.", kluc: "server.t3.druha", alias: "" }),
    rec({ id: "D0002", nazov: "behy taskera bežia v druhej inštancii T3", kluc: "tasker.behy.t3", alias: "" }),
    rec({ id: "D0003", nazov: "Iný názov", kluc: "a.c", alias: "" }),
    rec({ id: "D0004", nazov: "Iný názov", kluc: "a.c2", alias: "", stav: "zrušené" }),
  ]);
  try {
    const r = cli(dir, "check");
    assert.equal(r.status, 0, r.stdout);
    assert.match(r.stdout, /^upozornenie: rovnaký názov .* pri rôznych kľúčoch: D0001 \(server\.t3\.druha\), D0002 \(tasker\.behy\.t3\)$/m);
    assert.doesNotMatch(r.stdout, /D0003/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("subory: súbor z klonu tohto repa sa uzná, chýbajúci nie", () => {
  const { root, dir } = fixtura([
    rec({ id: "D0001", subory: "hooks/reply_guard.mjs", kluc: "a.a", alias: "" }),
    rec({ id: "D0002", subory: "hooks/nie_je.mjs", kluc: "a.b", alias: "" }),
    rec({ id: "D0003", stav: "nahradené", nahradene: "D0001", subory: "bin/zmazany.sh", kluc: "a.c", alias: "" }),
  ]);
  const runtime = mkdtempSync(join(tmpdir(), "rozh-runtime-"));
  try {
    mkdirSync(join(runtime, "hooks"));
    writeFileSync(join(runtime, "hooks", "reply_guard.mjs"), "// hook\n");
    const t = problems(loadAll(dir), { ...context(dir), workflow: runtime }).join("\n");
    assert.doesNotMatch(t, /reply_guard\.mjs' neexistuje/);
    assert.match(t, /hooks\/nie_je\.mjs' neexistuje/);
    assert.doesNotMatch(t, /zmazany\.sh/);
    assert.match(problems(loadAll(dir), { ...context(dir), workflow: join(runtime, "prazdny") }).join("\n"), /reply_guard\.mjs' neexistuje/);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(runtime, { recursive: true, force: true }); }
});

test("operátor pod iným menom z AGENT_OPERATOR_NAME", () => {
  const { root, dir } = fixtura([rec({ id: "D0001", rozhodol: "Meno", moc: "operator", zdroj: "povedal", kluc: "a.a", alias: "" })]);
  const old = process.env.AGENT_OPERATOR_NAME;
  try {
    delete process.env.AGENT_OPERATOR_NAME;
    assert.doesNotMatch(problems(loadAll(dir), context(dir)).join("\n"), /zdroj musí niesť/);
    process.env.AGENT_OPERATOR_NAME = "Meno";
    assert.match(problems(loadAll(dir), context(dir)).join("\n"), /D0001\.md: rozhodol Meno, zdroj musí niesť vlákno/);
  } finally {
    if (old === undefined) delete process.env.AGENT_OPERATOR_NAME; else process.env.AGENT_OPERATOR_NAME = old;
    rmSync(root, { recursive: true, force: true });
  }
});

test("rozhodnutia.mjs a rozhodni.sh bez priečinka decisions/ skončia kódom 2", () => {
  const env = { PATH: process.env.PATH, HOME: tmp() };
  env.AGENT_BRAIN_GLOBAL = join(env.HOME, "nie-je");
  try {
    const a = spawnSync("node", [CLI, "list"], { encoding: "utf8", env });
    assert.equal(a.status, 2);
    assert.match(a.stderr, /AGENT_BRAIN_GLOBAL/);
    const b = spawnSync("bash", [SH, "--dry-run"], { encoding: "utf8", env, input: "x" });
    assert.equal(b.status, 2);
    assert.match(b.stderr, /AGENT_BRAIN_GLOBAL/);
  } finally { rmSync(env.HOME, { recursive: true, force: true }); }
});
