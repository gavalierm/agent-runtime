// clear_bridge.mjs: starý prepis odloží a nahradí odkazom na nový,
// opakovaný /clear odkaz presmeruje, bez pôvodného ID nerobí nič.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync as mkdtempRaw, writeFileSync, readFileSync, readlinkSync, readdirSync, lstatSync, existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bridge, startContext, syncRepo } from "./clear_bridge.mjs";
import { writeHandoff } from "../lib/kontext.mjs";

// Dočasné priečinky testu sa na konci zmažú (úloha 701).
const tmpDirs = [];
const mkdtempSync = (prefix) => { const d = mkdtempRaw(prefix); tmpDirs.push(d); return d; };
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }); });

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "clear_bridge.mjs");
// Commity v testovacích repách bez globálneho mena a bez cudzích hookov.
const GITENV = { GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
Object.assign(process.env, GITENV);
const sh = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });

// Holé repo origin, klon "work" a druhý klon "other", z ktorého sa pushne nový commit.
function repos() {
  const d = mkdtempSync(join(tmpdir(), "cb-git-"));
  const origin = join(d, "origin.git");
  sh(d, "init", "-q", "--bare", "-b", "main", origin);
  const work = join(d, "work");
  sh(d, "clone", "-q", origin, work);
  writeFileSync(join(work, "a.txt"), "1");
  sh(work, "add", "a.txt"); sh(work, "commit", "-q", "-m", "prvy"); sh(work, "push", "-q", "origin", "HEAD:main");
  sh(work, "branch", "-q", "-M", "main"); sh(work, "branch", "-q", "--set-upstream-to=origin/main");
  const other = join(d, "other");
  sh(d, "clone", "-q", origin, other);
  writeFileSync(join(other, "b.txt"), "2");
  sh(other, "add", "b.txt"); sh(other, "commit", "-q", "-m", "druhy z originu"); sh(other, "push", "-q", "origin", "HEAD:main");
  return { d, origin, work, other };
}

const OLD = "056439af-f468-4146-95ca-2b3874c95058";
const N1 = "2907beb4-f822-4153-ba15-574a8d14c52c";
const N2 = "8fb76e40-ff7f-4d7f-a1bf-0a0ebc6575b8";

test("prvý /clear: starý prepis do .bak, na jeho mieste odkaz na nový", () => {
  const d = mkdtempSync(join(tmpdir(), "cb-"));
  writeFileSync(join(d, `${OLD}.jsonl`), "MANGO");
  writeFileSync(join(d, `${N1}.jsonl`), "PAPAYA");
  bridge(join(d, `${N1}.jsonl`), OLD);
  assert.equal(readlinkSync(join(d, `${OLD}.jsonl`)), `${N1}.jsonl`);
  assert.equal(readFileSync(join(d, `${OLD}.jsonl`), "utf8"), "PAPAYA");
  assert.ok(readdirSync(d).some((f) => f.startsWith(`${OLD}.pred-clear-`) && readFileSync(join(d, f), "utf8") === "MANGO"));
});

test("druhý /clear: odkaz presmeruje na najnovšiu reláciu", () => {
  const d = mkdtempSync(join(tmpdir(), "cb-"));
  writeFileSync(join(d, `${OLD}.jsonl`), "MANGO");
  writeFileSync(join(d, `${N1}.jsonl`), "PAPAYA");
  writeFileSync(join(d, `${N2}.jsonl`), "LIME");
  bridge(join(d, `${N1}.jsonl`), OLD);
  bridge(join(d, `${N2}.jsonl`), OLD);
  assert.equal(readFileSync(join(d, `${OLD}.jsonl`), "utf8"), "LIME");
  assert.equal(readdirSync(d).filter((f) => f.endsWith(".bak")).length, 1);
});

test("dva /clear za sebou zapíšu reťaz všetkých troch id do <pôvodné>.sessions (úloha 656)", () => {
  const d = mkdtempSync(join(tmpdir(), "cb-"));
  writeFileSync(join(d, `${OLD}.jsonl`), "MANGO");
  writeFileSync(join(d, `${N1}.jsonl`), "PAPAYA");
  writeFileSync(join(d, `${N2}.jsonl`), "LIME");
  bridge(join(d, `${N1}.jsonl`), OLD);
  assert.equal(readFileSync(join(d, `${OLD}.sessions`), "utf8"), `${OLD}\n${N1}\n`);
  bridge(join(d, `${N2}.jsonl`), OLD);
  assert.equal(readFileSync(join(d, `${OLD}.sessions`), "utf8"), `${OLD}\n${N1}\n${N2}\n`);
  // opakovanie nepridá duplicity
  bridge(join(d, `${N2}.jsonl`), OLD);
  assert.equal(readFileSync(join(d, `${OLD}.sessions`), "utf8"), `${OLD}\n${N1}\n${N2}\n`);
});

test("bez pôvodného ID alebo keď je nová relácia tá istá, nič nezmení a .sessions nevznikne", () => {
  const d = mkdtempSync(join(tmpdir(), "cb-"));
  writeFileSync(join(d, `${OLD}.jsonl`), "MANGO");
  assert.equal(bridge(join(d, `${N1}.jsonl`), null), "bez zmeny");
  assert.equal(bridge(join(d, `${OLD}.jsonl`), OLD), "bez zmeny");
  assert.ok(lstatSync(join(d, `${OLD}.jsonl`)).isFile());
  assert.ok(!existsSync(join(d, `${OLD}.sessions`)));
});

test("syncRepo: fetch a rebase na čistom strome prinesie nový commit z originu", () => {
  const { work } = repos();
  const out = syncRepo(work);
  assert.match(out, /rebase na origin\/main prebehli, nové commity: .*druhy z originu/);
  assert.ok(existsSync(join(work, "b.txt")));
});

test("syncRepo: špinavý strom rebase preskočí, fetch urobí", () => {
  const { work } = repos();
  writeFileSync(join(work, "a.txt"), "zmena");
  const out = syncRepo(work);
  assert.match(out, /fetch origin prebehol\. Strom nie je čistý, rebase preskočený/);
  assert.equal(existsSync(join(work, "b.txt")), false);
  assert.equal(readFileSync(join(work, "a.txt"), "utf8"), "zmena");
});

test("syncRepo: chyba fetchu a priečinok bez repa sa len ohlásia", () => {
  const { work, origin } = repos();
  sh(work, "remote", "set-url", "origin", join(origin, "neexistuje"));
  assert.match(syncRepo(work), /git fetch origin zlyhal: .*Rebase preskočený/);
  assert.match(syncRepo(mkdtempSync(join(tmpdir(), "cb-nogit-"))), /fetch a rebase preskočené/);
  assert.match(syncRepo(undefined), /fetch a rebase preskočené/);
});

test("syncRepo: rebase, ktorý padne na konflikte, sa zruší a strom ostane čistý", () => {
  const { work } = repos();
  writeFileSync(join(work, "b.txt"), "lokalne");
  sh(work, "add", "b.txt"); sh(work, "commit", "-q", "-m", "lokalny");
  const out = syncRepo(work);
  assert.match(out, /Rebase na origin\/main zlyhal a bol zrušený/);
  assert.equal(sh(work, "status", "--porcelain").stdout, "");
  assert.equal(existsSync(join(work, ".git", "rebase-merge")), false);
});

test("startContext vloží stav, ďalší krok a výsledok fetchu, odovzdávku zmaže, druhý raz ju nevloží", () => {
  const { work } = repos();
  const dir = mkdtempSync(join(tmpdir(), "cb-kontext-"));
  writeHandoff({ dir, id: OLD, rezim: "pokracuj", dalej: "dokončiť úlohu 7", stav: "pamäť zapísaná, commit abc" });
  const first = startContext({ cwd: work }, OLD, { dir });
  assert.match(first, /Štart relácie po \/clear je hotový/);
  assert.match(first, /Stav z odovzdávky: pamäť zapísaná, commit abc/);
  assert.match(first, /Ďalší krok: dokončiť úlohu 7/);
  assert.match(first, /rebase na origin\/main prebehli/);
  assert.deepEqual(readdirSync(dir), [], "odovzdávka zmazaná");
  const second = startContext({ cwd: work }, OLD, { dir });
  assert.doesNotMatch(second, /dokončiť úlohu 7|Stav z odovzdávky/);
  assert.match(second, /Odovzdávka od kontext\.sh nebola/);
});

// Celý hook ako proces, ktorého rodič vyzerá ako claude vlákna T3.
function runHook(input, env, id = OLD) {
  const code = `const r = require("node:child_process").spawnSync(process.execPath, [${JSON.stringify(HOOK)}], { input: ${JSON.stringify(JSON.stringify(input))}, env: ${JSON.stringify({ ...process.env, ...env })}, encoding: "utf8" }); process.stdout.write(JSON.stringify(r));`;
  return JSON.parse(spawnSync(process.execPath, ["-e", code, "--", "--resume", id], { encoding: "utf8" }).stdout);
}

test("hook ako proces: most prepisu ostáva, na stdout je JSON SessionStart s odovzdávkou, druhý štart bez nej", () => {
  const { work } = repos();
  const kdir = mkdtempSync(join(tmpdir(), "cb-kontext-"));
  const proj = mkdtempSync(join(tmpdir(), "cb-proj-"));
  writeFileSync(join(proj, `${OLD}.jsonl`), "MANGO");
  writeFileSync(join(proj, `${N1}.jsonl`), "PAPAYA");
  writeHandoff({ dir: kdir, id: OLD, rezim: "pokracuj", dalej: "krok Z", stav: "stav Y" });
  const input = { source: "clear", transcript_path: join(proj, `${N1}.jsonl`), cwd: work };
  const r = runHook(input, { KONTEXT_DIR: kdir });
  assert.equal(r.status, 0, r.stderr);
  const ctx = JSON.parse(r.stdout).hookSpecificOutput;
  assert.equal(ctx.hookEventName, "SessionStart");
  assert.match(ctx.additionalContext, /Ďalší krok: krok Z/);
  assert.match(ctx.additionalContext, /Stav z odovzdávky: stav Y/);
  assert.equal(readlinkSync(join(proj, `${OLD}.jsonl`)), `${N1}.jsonl`, "most prepisu");
  const r2 = runHook(input, { KONTEXT_DIR: kdir });
  assert.doesNotMatch(JSON.parse(r2.stdout).hookSpecificOutput.additionalContext, /krok Z/);
});

test("hook ako proces: iný zdroj než clear nevypíše nič", () => {
  const kdir = mkdtempSync(join(tmpdir(), "cb-kontext-"));
  const proj = mkdtempSync(join(tmpdir(), "cb-proj-"));
  const r = runHook({ source: "startup", transcript_path: join(proj, `${N1}.jsonl`), cwd: proj }, { KONTEXT_DIR: kdir });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
});
