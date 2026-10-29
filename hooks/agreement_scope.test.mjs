// agreement_scope.mjs: súhlas s menovanými bodmi dá pripomienku, holý súhlas nie.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { shouldRemind, agreedAction, stateFile } from "./agreement_scope.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "agreement_scope.mjs");

// Hook sa púšťa len vstupom na stdin; vráti additionalContext alebo "".
// Stav súhlasu ide vždy do dočasného priečinka, nikdy do skutočného ~/.claude.
const STATE = mkdtempSync(join(tmpdir(), "agreement-scope-"));
process.env.AGREEMENT_SCOPE_STATE = STATE;
process.on("exit", () => rmSync(STATE, { recursive: true, force: true }));
function run(prompt, session_id) {
  const out = execFileSync("node", [HOOK], {
    input: JSON.stringify({ prompt, session_id }),
    env: { ...process.env, AGREEMENT_SCOPE_STATE: STATE },
  }).toString();
  return out ? JSON.parse(out).hookSpecificOutput : null;
}

test("replay 25. 10. 2026: suhlasim v troch bodoch dá pripomienku", () => {
  const r = run("suhlasim v troch bodoch");
  assert.equal(r.hookEventName, "UserPromptSubmit");
  assert.match(r.additionalContext, /Operátor súhlasí s bodmi, ktoré menuje/);
  assert.match(r.additionalContext, /aj bod, ktorý si odporučil nerobiť/);
  assert.match(r.additionalContext, /global §1/);
});

test("Súhlasím s bodom 3 dá pripomienku", () => {
  assert.ok(run("Súhlasím s bodom 3"));
});

test("holý súhlas, áno a bod bez súhlasu nedajú nič", () => {
  for (const p of ["súhlasím", "Súhlasím.", "áno", "Áno, rob", "pozri bod 3", "", "ahoj"]) {
    assert.equal(run(p), null, p);
  }
});

test("tvary súhlasu a bodov", () => {
  for (const p of [
    "Súhlasím so všetkými",
    "suhlas s oboma bodmi",
    "súhlasím s dvoma",
    "ok, body 1 a 2",
    "OK všetko",
    "I agree with point 2",
    "yes to all points",
    "áno, bod 3",
    "ano, vsetky tri",
    "súhlasím so štyrmi bodmi",
    "suhlasim s obidvoma",
    "súhlasím so všetkým okrem bodu 2",
  ]) {
    assert.ok(shouldRemind(p), p);
  }
});

test("áno mimo začiatku nie je súhlas", () => {
  assert.equal(shouldRemind("povedal som, že áno, bod 3"), false);
});

test("chybný vstup na stdin nič nevypíše a skončí kódom 0", () => {
  const out = execFileSync("node", [HOOK], { input: "nie json" }).toString();
  assert.equal(out, "");
  assert.equal(execFileSync("node", [HOOK], { input: "{}" }).toString(), "");
});

test("replay: notifikácia sub-agenta so slovami súhlas a bod nedá nič", () => {
  for (const p of [
    "<system-reminder>\n[SYSTEM NOTIFICATION - NOT USER INPUT]\nsúhlasím s bodom 3\n</system-reminder>",
    "<task-notification>\n<result>Hotovo, súhlas s tromi bodmi</result>\n</task-notification>",
    "  <task-notification>suhlasim v troch bodoch</task-notification>",
    "<system-reminder>suhlasim v troch bodoch</system-reminder>",
    "Výsledok:\n[SYSTEM NOTIFICATION - NOT USER INPUT] suhlasim v troch bodoch",
  ]) {
    assert.equal(run(p), null, p);
  }
});

test("správa budiča zo schránky nedá nič", () => {
  assert.equal(run('<schranka od=boris id=1 odpoveď=čakám>\nsúhlasím s bodmi 1 a 2\n</schranka>'), null);
});

test("operátorova správa s rovnakými slovami dá pripomienku", () => {
  assert.ok(run("suhlasim v troch bodoch"));
});

test("súhlas s úkonom v rozkazovacom tvare dá pripomienku s citátom a zapíše stav", () => {
  const r = run("Ano, zaloz issue", "s610a");
  assert.match(r.additionalContext, /súhlasil len s úkonom "zaloz issue"/);
  assert.match(r.additionalContext, /nepíš ich do správy/);
  const st = JSON.parse(readFileSync(stateFile("s610a"), "utf8"));
  assert.equal(st.cite, "zaloz issue");
  assert.equal(st.session_id, "s610a");
  assert.ok(st.time);
});

test("tvary súhlasu s úkonom", () => {
  assert.equal(agreedAction("ok, posli to Ronovi"), "posli to Ronovi");
  assert.equal(agreedAction("Áno, založ issue a pushni"), "založ issue a pushni");
  assert.equal(agreedAction("Súhlasím, pridaj to"), "pridaj to");
  assert.equal(agreedAction("áno prosím"), null);
  assert.equal(agreedAction("Áno, rob"), null);
  assert.equal(agreedAction("áno"), null);
  assert.equal(agreedAction("súhlasím"), null);
  assert.equal(agreedAction("ahoj, založ issue"), null);
});

test("holé súhlasím a áno nezapíšu stav a nedajú nič", () => {
  for (const p of ["súhlasím", "áno", "ok"]) {
    assert.equal(run(p, "s610b"), null, p);
    assert.equal(existsSync(stateFile("s610b")), false, p);
  }
});

test("ďalšia správa operátora bez súhlasu s úkonom stav zmaže, systémová správa nie", () => {
  run("ok, zaloz issue", "s610c");
  assert.ok(existsSync(stateFile("s610c")));
  run("<task-notification>hotovo</task-notification>", "s610c");
  assert.ok(existsSync(stateFile("s610c")));
  run("a ako to ide?", "s610c");
  assert.equal(existsSync(stateFile("s610c")), false);
});

test("súhlas s menovanými bodmi stav nezapíše", () => {
  assert.ok(run("suhlasim v troch bodoch", "s610d"));
  assert.equal(existsSync(stateFile("s610d")), false);
});

test("bez session_id sa stav nezapíše", () => {
  assert.ok(run("ano, zaloz issue"));
});
