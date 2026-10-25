// Ranný súhrn: nové rozhodnutia za 24 h a výstup kontroly (úloha 470, replay S9).
// Git repo je dočasné v mkdtemp, kontrola je zástupná funkcia, nič sa nezapisuje.
import "../lib/git_isolate.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build, decisionsSection } from "../morning.mjs";

const zaznam = (id, o = {}) => `---\nid: ${id}\nnazov: ${o.nazov ?? "Názov " + id}\nstav: platí\nkluc: ${o.kluc ?? "a." + id}\nrozsah: server\nagenti: *\nrozhodol: ${o.rozhodol ?? "Adam"}\nmoc: ${o.moc ?? "zastupca-v-plnej-moci"}\nzapisal: ${o.zapisal ?? "Adam"}\ndatum: 2026-10-24\nzdroj: vlákno\n---\nTelo.\n`;

function repo() {
  const root = mkdtempSync(join(tmpdir(), "adam-roz-"));
  // Test beží aj z hooku pre-commit, kde GIT_INDEX_FILE a GIT_DIR ukazujú na repo agenta: musia zmiznúť.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
  for (const k of Object.keys(env)) if (/^GIT_(DIR|INDEX_FILE|WORK_TREE|PREFIX|OBJECT_DIRECTORY|COMMON_DIR)$/.test(k)) delete env[k];
  const git = (...a) => execFileSync("git", ["-C", root, ...a], { env, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t"); git("config", "user.name", "T");
  mkdirSync(join(root, "rozhodnutia"));
  const commit = (id, o, datum) => {
    writeFileSync(join(root, "rozhodnutia", `${id}.md`), zaznam(id, o));
    git("add", "."); 
    execFileSync("git", ["-C", root, "commit", "-qm", id], { env: { ...env, GIT_AUTHOR_DATE: datum, GIT_COMMITTER_DATE: datum } });
  };
  return { root, commit };
}

test("ranný súhrn vypíše len záznamy pridané za 24 h: číslo, kto, moc, kľúč, a nálezy kontroly", () => {
  const r = repo();
  r.commit("D0001", {}, "2026-01-01T10:00:00Z");
  r.commit("D0002", { rozhodol: "Dana", moc: "operator", zapisal: "Dana", kluc: "dizajn.farba" }, new Date().toISOString());
  const kontrola = () => "D0002.md: moc operator nemá Dana podľa roles/agents.md\nupozornenie: rovnaký názov 'x' pri rôznych kľúčoch: D0002 (a), D0003 (b)\n";
  const out = decisionsSection({ rulesRepo: r.root }, undefined, kontrola).join("\n");
  assert.match(out, /Nové rozhodnutia za 24 h \(1\)/);
  assert.match(out, /- D0002, zapísal Dana, rozhodol Dana, moc operator, kľúč dizajn\.farba: Názov D0002/);
  assert.doesNotMatch(out, /D0001/);
  assert.match(out, /- D0002\.md: moc operator nemá Dana/);
  assert.match(out, /- upozornenie: rovnaký názov/);
});

test("build pridá sekciu rozhodnutí len s rulesRepo, čistá kontrola je v poriadku, bez nových záznamov žiadne", () => {
  const r = repo();
  r.commit("D0001", {}, "2026-01-01T10:00:00Z");
  const stub = () => "tasker ok";
  assert.doesNotMatch(build({}, stub, Date.now()), /rozhodnutia za 24 h/);
  const out = build({ rulesRepo: r.root }, stub, Date.now(), { check: () => "" });
  assert.match(out, /Nové rozhodnutia za 24 h \(0\)/);
  assert.match(out, /- žiadne/);
  assert.match(out, /Kontrola rozhodnutí: v poriadku\./);
});

test("zlyhanie git logu sa v súhrne ukáže, súhrn neodpadne", () => {
  const out = decisionsSection({ rulesRepo: "/nie/je" }, () => { throw new Error("nie je repo"); }, () => "");
  assert.match(out.join("\n"), /Rozhodnutia: git log zlyhal: nie je repo/);
});
