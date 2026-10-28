// human_question.mjs: otázka pre človeka stojí sama (úloha 575). Texty z úlohy
// 573 s vymyslenými menami, tvar zachovaný.
import { test } from "node:test";
import assert from "node:assert/strict";
import { questionProblem, waitingItemProblem, usedLetters, decisionItems, unverifiedClaim } from "../lib/human_question.mjs";

const SUMMARY = "Medzery v návrhu sú opravené, --gaps dáva kód 0 pri 1440 aj 390 px, hlavicka.sh 0 nálezov (1dd47fa). Čaká na Adamovo A/B k zápisu do agent-rules.";
const COMMENT = "[Boris za Adama] Adam, máme prepísať vzor pre dashboardy v repe pravidiel podľa nového detailu úlohy v Taskeri?\n\n"
  + "Vzor je artefakt dashboard-playbook (/opt/agent-rules/artifacts/dashboard-playbook). Tasker už novú hlavičku má, podľa variantu A, ktorý si vybral v úlohe 541 (urobil ju Cyril v úlohe 566). "
  + "Nad názvom úlohy je riadok Prehľad / Projekt / Úloha #N, stav a akcie sú v riadku názvu.\n\n"
  + "Keď odpovieš áno, Dana zapíše nové znenie do agent-rules. Keď odpovieš nie, napíš, čo zmeniť. Odporúčam áno.";
const ITEM = "Hotovo.\n\nČaká na teba:\n- (rozhodnutie) úloha 573: A) zapísať návrh do agent-rules, B) napíš, čo zmeniť. Odporúčam A.";

test("zhrnutie behu z úlohy 573 sa zamietne: bez otázky a s nedefinovaným A/B", () => {
  const why = questionProblem(SUMMARY);
  assert.match(why, /nemá vetu končiacu `\?`/);
  assert.match(why, /voľbu A, B/);
});

test("komentár z úlohy 573 prejde, aj s 'variantu A' ako odkazom na starší výber", () => {
  assert.equal(questionProblem(COMMENT), null);
});

test("položka (rozhodnutie) bez otáznika sa zamietne", () => {
  assert.match(waitingItemProblem(ITEM), /nemá vetu končiacu/);
});

test("položka s otázkou a definovanými A) B) prejde, ostatné značky sa nekontrolujú", () => {
  const ok = "Čaká na teba:\n- (rozhodnutie) úloha 573: zapísať nový vzor do repa? A) áno, B) nie, napíš čo zmeniť, odporúčam A.";
  assert.equal(waitingItemProblem(ok), null);
  assert.equal(waitingItemProblem("Čaká na teba:\n- heslo k účtu (hodnota)"), null);
  assert.equal(waitingItemProblem("Čaká na teba: nič."), null);
  assert.equal(waitingItemProblem("Bez zoznamu."), null);
  assert.deepEqual(decisionItems("Čaká na teba:\n- a (hodnota)\n- b (rozhodnutie)\n\nĎalší text (rozhodnutie)"), ["b (rozhodnutie)"]);
});

test("A/B v definovanom zozname prejde", () => {
  assert.equal(questionProblem("Zapísať nový vzor do repa? A) áno, commitnem. B) nie, napíš čo zmeniť. Odporúčam A."), null);
  assert.equal(questionProblem("Zapísať A/B test do repa? (A) áno, (B) nie."), null);
  assert.equal(questionProblem("Ktorú cestu? A alebo B?\nA: nový vzor\nB: starý vzor"), null);
});

test("písmeno A v inom zmysle nie je voľba", () => {
  assert.equal(questionProblem("A potom to nasadíme? Áno alebo nie, odporúčam áno."), null);
  assert.equal(questionProblem("Je vitamín A potrebný? Nie, odporúčam nechať."), null);
  assert.equal(questionProblem("Schválime variantu A z úlohy 541? Už je schválená."), null);
  assert.equal(questionProblem("Trieda A, B a C sú v tabuľke. Máme ich spojiť?"), null);
  assert.deepEqual([...usedLetters("Plán A bol zamietnutý. A potom?")], []);
});

test("otáznik v URL nie je otázka", () => {
  assert.match(questionProblem("Odkaz https://example.test/tasks/7?x=1 a hotovo."), /nemá vetu končiacu/);
  assert.equal(questionProblem("Pozri https://example.test/tasks/7?x=1 a povedz, schvaľuješ?"), null);
  assert.equal(questionProblem("Cesta /srv/A/B/log, potvrdíš zápis?"), null);
});

test("voľba bez definície sa zamietne aj pri otázke", () => {
  assert.match(questionProblem("Zapísať vzor? Odporúčam A."), /voľbu A bez definície/);
  assert.match(questionProblem("Ktorý variant A alebo B? Odporúčam A."), /voľbu A, B/);
  assert.match(questionProblem("Zapísať vzor? A) áno. Odporúčam B."), /voľbu B/);
});

test("reply_guard zastaví odpoveď s položkou (rozhodnutie) bez otázky", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const guard = join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "reply_guard.mjs");
  const dir = mkdtempSync(join(tmpdir(), "hq-"));
  try {
    const run = (text) => spawnSync("node", [guard], {
      input: JSON.stringify({ last_assistant_message: text, cwd: dir }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, REPLY_GUARD_NO_NET: "1", AR_ROZHODNUTIA: "", AGENT_THREADS: "" }, encoding: "utf8",
    }).stdout;
    const bad = JSON.parse(run(ITEM));
    assert.equal(bad.decision, "block");
    assert.match(bad.reason, /nemá vetu končiacu `\?`/);
    assert.match(bad.reason, /Správny postup:/);
    assert.equal(run("Hotovo.\n\nČaká na teba:\n- (rozhodnutie) zapísať vzor do repa, A) áno alebo B) nie, odporúčam A?"), "");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// Chyba 28. 10. 2026 (úloha 656): otázka s A) B) niesla odsek s neoverenou položkou.
const CLAIM = "Neoverené: či sa skilly z .claude/skills nadradeného priečinka načítajú v behu v podpriečinku.";
const QUESTION_656 = "Ktorú cestu zvoliť? A) skilly dám do repa kódu. B) nechám ich v nadradenom priečinku.\n\n"
  + `- ${CLAIM} Overím v dokumentácii skillov pred ďalším krokom; keď nie, projektové skilly sa do repa kódu dostanú symlinkom, ktorý založí adopt.sh.`;

test("unverifiedClaim nájde skutočnú vetu z chyby 656", () => {
  const got = unverifiedClaim(QUESTION_656);
  assert.match(got, /^- Neoverené: či sa skilly z \.claude\/skills/);
  assert.equal(unverifiedClaim(CLAIM), CLAIM.replace(/\.$/, "."));
});

test("questionProblem zamietne otázku s neoverenou vetou, text sa skráti na 80 znakov", () => {
  const why = questionProblem(QUESTION_656);
  assert.match(why, /^text pre človeka obsahuje neoverené tvrdenie "- Neoverené: /);
  assert.match(why, /\.\.\."$/);
  assert.equal(why.match(/"([^"]*)"/)[1].length, 80);
  const both = questionProblem("Zapísať vzor, variant A. Neoverené, či to beží.");
  assert.match(both, /nemá vetu končiacu `\?` a spomína voľbu A bez definície/);
  assert.match(both, / a obsahuje neoverené tvrdenie "Neoverené, či to beží\."/);
});

test("waitingItemProblem zamietne položku (rozhodnutie) s neoverenou vetou", () => {
  assert.match(waitingItemProblem("Čaká na teba:\n- (rozhodnutie) úloha 656: zapísať? A) áno, B) nie. Unverified, či hook beží."), /neoverené tvrdenie/);
});

test("značky: veľkosť písmen, anglické tvary, len celé slová", () => {
  for (const t of ["Zatiaľ nevieme, či to ide.", "NEOVERENÉ.", "Neoveril som to.", "Nie je overené, či to ide.", "Not verified yet is odd. This is not yet verified.", "I haven't verified it.", "We have not verified it.", "Unverified claim."]) {
    assert.notEqual(unverifiedClaim(t), null, t);
  }
});

test("veta 'Overené v dokumentácii' prejde", () => {
  assert.equal(unverifiedClaim("Overené v dokumentácii skillov, načítajú sa."), null);
  assert.equal(questionProblem("Zapísať? A) áno. B) nie. Overené v dokumentácii skillov."), null);
});

test("'unverified' v URL, v kóde a v bloku kódu prejde", () => {
  assert.equal(unverifiedClaim("Pozri https://example.com/unverified/neoverene a rozhodni."), null);
  assert.equal(unverifiedClaim("Príznak `unverified` je v kóde."), null);
  assert.equal(unverifiedClaim("Kód:\n```\nconst unverified = 1; // neoverené\n```\nHotovo."), null);
  assert.equal(unverifiedClaim("Slovo preneoverené nie je značka."), null);
  assert.equal(questionProblem("Zapísať? A) áno. B) nie. Príznak `unverified` je v kóde."), null);
});
