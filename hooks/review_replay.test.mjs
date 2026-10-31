// review_replay.mjs: zamietne posudok s tvrdením o účinku bez dôkazu prehrania. Len reťazce
// a vstup hooku cez stdin, Tasker ani živé settings sa nevolajú.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewReplayReason, POSTUP } from "./review_replay.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "review_replay.mjs");
const TK = "AGENT_NAME=agent /opt/agentic-workflow/bin/tk";
const sq = (t) => `'${t.replace(/'/g, `'\\''`)}'`;
const run = (command) => {
  const out = execFileSync("node", [HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }) }).toString();
  return out ? JSON.parse(out).hookSpecificOutput : null;
};
// Posudok úlohy 708 z 31. 10. 2026.
const P708 = "Posudok origin/u704 f124ba1: mergeSettings vyhodí každý náš starý záznam (isOurs), takže inštalácia na Macu zmaže aj starý záznam guard.mjs v ~/.claude/settings.json.";

test("posudok z 708 bez prehrania sa zamietne, hook dá Správny postup", () => {
  const cmd = `${TK} comment 708 --body ${sq(P708)}`;
  assert.match(reviewReplayReason(cmd), /vyhodí|zmaže/);
  const out = run(cmd);
  assert.equal(out.permissionDecision, "deny");
  assert.ok(out.permissionDecisionReason.includes("Správny postup:"));
  assert.ok(POSTUP.includes("na kópii vstupu"));
  assert.ok(out.permissionDecisionReason.includes("prehraj tvrdenie na kópii vstupu"));
});

test("s dôkazom prehrania posudok prejde", () => {
  for (const d of ["Replay na kópii settings.json: node x.mjs -> ostal guard.mjs", "Prehral som to, guard.mjs ostane", "po prehraní zmaže len naše", "výsledok prehrané na vzorke"]) {
    const cmd = `${TK} comment 708 --body ${sq(`Posudok u704: mergeSettings zmaže starý záznam. ${d}`)}`;
    assert.equal(reviewReplayReason(cmd), null, d);
    assert.equal(run(cmd), null, d);
  }
});

test("bežný komentár bez slova posudok so zmaže prejde", () => {
  assert.equal(reviewReplayReason(`${TK} comment 5 --body "skript zmaže dočasný súbor"`), null);
});

test("posudok bez slovesa účinku prejde", () => {
  assert.equal(reviewReplayReason(`${TK} comment 5 --body "Posudok u704: kód je čitateľný, testy prechádzajú, nález žiadny"`), null);
});

test("echo, grep a heredoc so zmienkou prejdú", () => {
  assert.equal(reviewReplayReason(`echo ${sq(P708)}`), null);
  assert.equal(reviewReplayReason(`grep -n "Posudok zmaže" x.md`), null);
  assert.equal(run(`echo ${sq(P708)}`), null);
});

test("done --summary sa posudzuje, aj s cestou a premennými", () => {
  assert.match(reviewReplayReason(`tasker done 708 --summary ${sq(P708)}`), /zhrnutie `done`/);
  assert.match(reviewReplayReason(`FOO=1 /usr/local/bin/tk task comment 708 --body ${sq(P708)}`), /komentár/);
  assert.equal(reviewReplayReason(`tasker done 708 --summary "hotovo, ostane len merge"`), null);
});

test("--body z $(< súbor) a z $(cat súbor) sa číta zo súboru", () => {
  const dir = mkdtempSync(join(tmpdir(), "rr-"));
  try {
    const f = join(dir, "posudok.md");
    writeFileSync(f, P708);
    assert.match(reviewReplayReason(`${TK} comment 708 --body "$(< ${f})"`), /posudok/);
    assert.match(reviewReplayReason(`${TK} comment 708 --body "$(cat ${f})"`), /posudok/);
    assert.match(reviewReplayReason(`${TK} comment 708 --body "Úvod $(cat ${f})"`), /posudok/);
    writeFileSync(f, `${P708}\nReplay na kópii: ok`);
    assert.equal(reviewReplayReason(`${TK} comment 708 --body "$(< ${f})"`), null);
    assert.equal(reviewReplayReason(`${TK} comment 708 --body "$(< ${join(dir, "nie")})"`), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("hranice slov: ostanú v inom slove a meno súboru replay.sh nie je dôkaz ani tvrdenie", () => {
  assert.equal(reviewReplayReason(`${TK} comment 5 --body "Posudok: prostanok, nazmažený"`), null);
  assert.match(reviewReplayReason(`${TK} comment 5 --body "Posudok: zmaže, pozri bin/replay.sh"`), /zmaže/);
});

test("príčastie a podstatné meno nie sú tvrdenie o účinku", () => {
  for (const w of ["odstránenie CONFIG", "pravidlo je nahradené", "falošné zamietnutie", "bod zmazaný", "allow ostalo"])
    assert.equal(reviewReplayReason(`${TK} comment 5 --body "Posudok u704: ${w}"`), null, w);
});
