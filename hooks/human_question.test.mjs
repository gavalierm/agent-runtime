// human_question.mjs: zamietne zhrnutie needs_human a ask bez otázky alebo s nedefinovaným A/B.
// Len reťazce a vstup hooku cez stdin, Tasker ani schránky sa nevolajú.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// Používateľ správcu úloh pre rozbor `runuser -u <používateľ>` (web_review.mjs ho berie pri načítaní).
process.env.AGENT_TASKER_USER = "tasker-svc";
const { humanQuestionReason, POSTUP } = await import("./human_question.mjs");

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "human_question.mjs");
const TK = "AGENT_NAME=eva /opt/agentic-workflow/bin/tk";
// Zhrnutie behu úlohy 573 (mená osôb nemenia tvar) a komentár z tej istej úlohy.
const SUMMARY = "Medzery v návrhu sú opravené, --gaps dáva kód 0 pri 1440 aj 390 px, hlavicka.sh 0 nálezov (1dd47fa). Čaká na Oskarovo A/B k zápisu do agentic-workflow.";
const COMMENT = "[Adam za Oskara] Oskar, máme prepísať vzor pre dashboardy v repe pravidiel podľa nového detailu úlohy v Taskeri?\n\n"
  + "Vzor je artefakt dashboard-playbook (/opt/agentic-workflow/artifacts/dashboard-playbook). Tasker už novú hlavičku má, podľa variantu A, ktorý si vybral v úlohe 541 (urobil ju Dan v úlohe 566). "
  + "Keď odpovieš áno, Eva zapíše nové znenie do agentic-workflow. Keď odpovieš nie, napíš, čo zmeniť. Odporúčam áno.";
const chk = (cmd) => humanQuestionReason(cmd);
const run = (command) => {
  const out = execFileSync("node", [HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }) }).toString();
  return out ? JSON.parse(out).hookSpecificOutput : null;
};

test("skutočné zhrnutie behu 573 sa zamietne, hook dá Správny postup", () => {
  const cmd = `${TK} result 573 needs_human --summary "${SUMMARY}"`;
  assert.match(chk(cmd), /nemá vetu končiacu `\?`/);
  assert.match(chk(cmd), /voľbu A, B/);
  const out = run(cmd);
  assert.equal(out.permissionDecision, "deny");
  assert.ok(out.permissionDecisionReason.includes("Správny postup:"));
  assert.ok(POSTUP.includes("A) ..."));
});

test("tvary príkazu: tasker, tk, --summary=, result bez id, sh -c, runuser", () => {
  const bad = `Čaká na Oskarovo A/B k zápisu.`;
  assert.ok(chk(`tasker result needs_human --summary "${bad}"`));
  assert.ok(chk(`tk result needs_human --summary="${bad}"`));
  assert.ok(chk(`tk result 5 needs_human --summary '${bad}'`));
  assert.ok(chk(`sh -c 'tk result needs_human --summary "${bad}"'`));
  assert.ok(chk(`runuser -u tasker-svc -- env TASKER_USER=eva tasker result needs_human --summary "${bad}"`));
  assert.ok(chk(`cd /x && ${TK} ask 573 --body "${bad}"`));
});

test("ask bez otázky alebo s nedefinovaným A/B sa zamietne", () => {
  assert.match(chk(`${TK} ask 573 --body "Zapísať vzor do repa. Odporúčam áno."`), /nemá vetu končiacu/);
  assert.match(chk(`${TK} ask 573 --body "Zapísať vzor do repa? Odporúčam A."`), /voľbu A bez definície/);
  assert.match(chk(`${TK} ask 573 --body "Variant A alebo B? Odporúčam A."`), /voľbu A, B/);
});

test("komentár 573 a otázka s definovaným A) B) prejdú", () => {
  assert.equal(chk(`${TK} ask 573 --body "${COMMENT.replace(/"/g, '\\"')}"`), null);
  assert.equal(chk(`${TK} ask 573 --body 'Zapísať vzor do repa? A) áno, commitnem. B) nie, napíš čo zmeniť. Odporúčam A.'`), null);
  assert.equal(chk(`${TK} result 573 needs_human --summary "Zapísať vzor do repa? A/B: A) áno, B) nie. Odporúčam A."`), null);
  assert.equal(chk(`${TK} result needs_human --summary "Schválime podľa variantu A z úlohy 541? Odporúčam áno."`), null);
});

test("falošný poplach: písmeno A ako slovo a otáznik v URL", () => {
  assert.equal(chk(`${TK} ask 5 --body "A potom to nasadíme? Odporúčam áno."`), null);
  assert.equal(chk(`${TK} ask 5 --body "Pozri https://example.test/tasks/7?x=1, schvaľuješ?"`), null);
  assert.match(chk(`${TK} ask 5 --body "Pozri https://example.test/tasks/7?x=1 a rozhodni."`), /nemá vetu/);
});

test("text s kódom v spätných apostrofoch sa kontroluje", () => {
  assert.match(chk(`${TK} result needs_human --summary "Spusti \`hlavicka.sh\`, čaká na A/B."`), /nemá vetu/);
  assert.equal(chk(`${TK} result needs_human --summary "Spusti \`hlavicka.sh\`, zapísať vzor? A) áno B) nie. Odporúčam A."`), null);
});

const BAD = "Čaká na Oskarovo A/B k zápisu do agentic-workflow.";
const GOOD = "Zapísať vzor do repa? A) áno, commitnem. B) nie, napíš, čo zmeniť. Odporúčam A.";

test("heredoc v $(cat <<'EOF' ...) sa kontroluje: zlý text zamietne, dobrý pustí", () => {
  const body = (t, d = "'EOF'") => `${TK} ask 573 --body "$(cat <<${d}\n${t}\nEOF\n)"`;
  assert.match(chk(body(BAD)), /nemá vetu/);
  assert.equal(chk(body(GOOD)), null);
  assert.match(chk(`${TK} result 573 needs_human --summary "$(cat <<'EOF'\n${BAD}\nEOF\n)"`), /voľbu A, B/);
  assert.equal(chk(`${TK} result 573 needs_human --summary "$(cat <<'EOF'\n${GOOD}\nEOF\n)"`), null);
  assert.match(chk(`cd /x && ${TK} ask 5 --body="$(cat <<-'EOF'\n\t${BAD}\n\tEOF\n)" --json`), /nemá vetu/);
  // viacriadkový text s úvodzovkami a spätnými apostrofmi
  assert.equal(chk(body('Pozri "súbor" a `kód`.\nZapísať vzor? A) áno B) nie. Odporúčam A.')), null);
  assert.match(chk(body('Pozri "súbor" a `kód`.\nČaká na A/B.')), /nemá vetu/);
});

test("heredoc s premennou v texte (neuvedený oddeľovač) hook pustí", () => {
  assert.equal(chk(`${TK} ask 5 --body "$(cat <<EOF\nČaká na A/B $X\nEOF\n)"`), null);
});

test("$(cat súbor): existujúci čitateľný súbor sa kontroluje, hook ho len číta", () => {
  const dir = mkdtempSync(join(tmpdir(), "hq-"));
  try {
    const bad = join(dir, "bad.txt");
    const good = join(dir, "good.txt");
    writeFileSync(bad, BAD + "\n");
    writeFileSync(good, GOOD + "\n");
    assert.match(chk(`${TK} ask 573 --body "$(cat ${bad})"`), /nemá vetu/);
    assert.equal(chk(`${TK} ask 573 --body "$(cat ${good})"`), null);
    assert.match(chk(`${TK} result needs_human --summary "$(cat '${bad}')"`), /voľbu A, B/);
    assert.equal(chk(`${TK} result needs_human --summary "$(cat ${good})"`), null);
    assert.equal(readFileSync(bad, "utf8"), BAD + "\n");
    // chýbajúci súbor, adresár, iný príkaz a premenná: bez kontroly
    assert.equal(chk(`${TK} ask 5 --body "$(cat ${dir}/nie-je.txt)"`), null);
    assert.equal(chk(`${TK} ask 5 --body "$(cat ${dir})"`), null);
    assert.equal(chk(`${TK} ask 5 --body "$(cat ${bad} | tr a b)"`), null);
    assert.equal(chk(`${TK} ask 5 --body "$(cat $F)"`), null);
    assert.equal(chk(`${TK} ask 5 --body "$(date)"`), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("skutočný súbor z úlohy 573 (/tmp/ask573.txt), ak ešte existuje, prejde", { skip: !existsSync("/tmp/ask573.txt") }, () => {
  assert.equal(chk(`${TK} ask 573 --body "$(cat /tmp/ask573.txt)"`), null);
});

test("premenná, $(...) a iné príkazy hook pustí", () => {
  assert.equal(chk(`${TK} result needs_human --summary "$S"`), null);
  assert.equal(chk(`${TK} result needs_human --summary "$(cat /tmp/neexistuje-human-question-test)"`), null);
  assert.equal(chk(`${TK} ask 5 --body "$(curl -s x/y)"`), null);
  assert.equal(chk(`${TK} result done --summary "Hotovo, bez otázky."`), null);
  assert.equal(chk(`${TK} comment 5 --body "Čaká na A/B."`), null);
  assert.equal(chk(`${TK} task show 573 --json`), null);
  assert.equal(chk(`echo 'tk result needs_human --summary "A/B"'`), null);
  assert.equal(chk(`grep -n "ask 5 --body" notes.md`), null);
  assert.equal(chk(`ask_agent.sh boris x <<'EOF'\ntk ask 5 --body "A/B"\nEOF`), null);
});

test("hook mimo Bash a prázdny vstup nič nezamietne", () => {
  const out = execFileSync("node", [HOOK], { input: JSON.stringify({ tool_name: "Edit", tool_input: {} }) }).toString();
  assert.equal(out, "");
  assert.equal(execFileSync("node", [HOOK], { input: "" }).toString(), "");
});

// Chyba 28. 10. 2026 (úloha 656): komentár s otázkou A) B) niesol odsek "Neoverené: ...".
const CLAIM_656 = "- Neoverené: či sa skilly z .claude/skills nadradeného priečinka načítajú v behu v podpriečinku. "
  + "Overím v dokumentácii skillov pred ďalším krokom; keď nie, projektové skilly sa do repa kódu dostanú symlinkom, ktorý založí adopt.sh.";
const COMMENT_656 = `Prenesieme skilly do repa kódu? A) áno, symlinkom. B) nie, ostanú v nadradenom priečinku. Odporúčam A.\n\n${CLAIM_656}`;

test("komentár 656 s otázkou A) B) a odsekom Neoverené sa zamietne, hook dá Správny postup", () => {
  const cmd = `${TK} comment 656 --body "${COMMENT_656}"`;
  assert.match(chk(cmd), /neoverené tvrdenie "- Neoverené: či sa skilly/);
  const out = run(cmd);
  assert.equal(out.permissionDecision, "deny");
  assert.match(out.permissionDecisionReason, /neoverené tvrdenie/);
  assert.ok(out.permissionDecisionReason.includes("otázka pre človeka nenesie neoverené tvrdenie"));
  assert.ok(POSTUP.includes("neoverené tvrdenie over teraz"));
  assert.match(chk(`tasker comment 656 --body="${COMMENT_656}"`), /neoverené tvrdenie/);
});

test("komentár s vetou na ? alebo s písmenom voľby a neoverenou vetou sa zamietne", () => {
  assert.match(chk(`${TK} comment 656 --body "Beží hook? Neoverené, či ho T3 načíta."`), /neoverené tvrdenie/);
  assert.match(chk(`${TK} comment 656 --body "Odporúčam variant A. Zatiaľ nevieme, či to ide."`), /neoverené tvrdenie/);
});

test("komentár bez otázky a voľby (hlásenie stavu) smie písať neoverené", () => {
  assert.equal(chk(`${TK} comment 656 --body "Stav: zatiaľ neoverené, pokračujem."`), null);
  assert.equal(chk(`${TK} comment 656 --body "Overené v dokumentácii skillov? A) áno. B) nie. Odporúčam A."`), null);
  assert.equal(chk(`${TK} comment 656 --body "Beží hook? Overené skúškou, beží."`), null);
});

test("ask s otázkou A) B) a neoverenou vetou sa zamietne, result needs_human tiež", () => {
  assert.match(chk(`${TK} ask 656 --body "Zapísať? A) áno. B) nie. Neoverené, či hook beží."`), /neoverené tvrdenie "Neoverené, či hook beží\."/);
  assert.match(chk(`${TK} result 656 needs_human --summary "Zapísať? A) áno. B) nie. Unverified, či hook beží."`), /neoverené tvrdenie/);
});

test("prehranie chyby 656 cez stdin hooku: deny", () => {
  const out = run(`tk comment 656 --body "${COMMENT_656}"`);
  assert.equal(out.permissionDecision, "deny");
});
