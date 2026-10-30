// own_mechanism.mjs: zamietne zadanie s novým vlastným mechanizmom bez riadku
// `Nástroj overený:`. Len reťazce a vstup hooku cez stdin, Tasker ani schránky sa nevolajú.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ownMechanismReason, MECHANISM, POSTUP } from "./own_mechanism.mjs";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "own_mechanism.mjs");
const TK = "AGENT_NAME=adam /opt/agentic-workflow/bin/tk";
// Telo úlohy 585 (`tk task show 585 --json`, pole body) z 25. 10. 2026.
const BODY_585 = "[Adam za Oskara] Oskar 25. 10. 2026 (úloha 582) nevedel, čo robí slučka Rona, ktorá čaká na koniec behu 111 a potom spustí deploy_tasker.sh ca1afc7. Čakanie žije v relácii agenta, z webu Taskera ho nevidno a s reláciou zanikne. Podmienka hotového: deploy_tasker_task.sh (alebo deploy_tasker.sh) má voľbu, ktorá pri bežiacich behoch zapíše úlohe nasadenia stav waiting s dôvodom (ktoré behy, čo potom), spustí čakanie ako jednotku systemd (systemd-run) bez modelu, po konci behov nasadí a výsledok zapíše komentárom a done alebo needs_human do úlohy. Test na skúšobnej inštancii: s bežiacim behom sa nasadenie odloží, po jeho konci prebehne bez zásahu agenta. Úlohy 581 a 584 nasaď už touto cestou. Patrí tebe, lebo nasadenie /opt/tasker a repo examplehost sú tvoje.";
const OVERENY = "Nástroj overený: tasker block --help nevie čakať na beh, len na úlohu";
const sq = (t) => `'${t.replace(/'/g, `'\\''`)}'`;
const chk = (cmd, opts) => ownMechanismReason(cmd, opts);
const run = (command) => {
  const out = execFileSync("node", [HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }) }).toString();
  return out ? JSON.parse(out).hookSpecificOutput : null;
};

test("telo úlohy 585 v tk task add --body sa zamietne, hook dá Správny postup", () => {
  const cmd = `${TK} task add --project agenti --assign boris --title "Čakanie na behy" --body ${sq(BODY_585)}`;
  assert.match(chk(cmd), /mechanizmus \(systemd, slučka\)/);
  const out = run(cmd);
  assert.equal(out.permissionDecision, "deny");
  assert.ok(out.permissionDecisionReason.includes("Správny postup:"));
  assert.ok(out.permissionDecisionReason.includes("tasker block"));
  assert.ok(POSTUP.includes("Nástroj overený:"));
});

test("s riadkom Nástroj overený telo 585 prejde", () => {
  const cmd = `${TK} task add --project agenti --body ${sq(`${BODY_585}\n${OVERENY}`)}`;
  assert.equal(chk(cmd), null);
  assert.equal(run(cmd), null);
  // Riadok v tele, mechanizmus v nadpise: kryje celý príkaz.
  assert.equal(chk(`tasker task add --project p --title "systemd timer" --body ${sq(`x\n${OVERENY}`)}`), null);
  // Prázdny obsah za dvojbodkou nestačí.
  assert.ok(chk(`tk task add --project p --body ${sq("systemd\nNástroj overený:  ")}`));
});

test("tvary príkazu: tasker, cesta, premenné, komentár, --body=, sh -c", () => {
  assert.ok(chk(`tasker task add --project p --body "spusti systemd-run"`));
  assert.ok(chk(`/opt/agentic-workflow/bin/tk task add --project p --title "nový skript na čakanie"`));
  assert.ok(chk(`AGENT_NAME=adam TASKER_USER=adam /opt/agentic-workflow/bin/tk comment 585 --body "pridaj cron"`));
  assert.ok(chk(`tk comment 5 --body="timer na 5 minút"`));
  assert.ok(chk(`tk task comment 5 --body "daemon"`));
  assert.ok(chk(`cd /root && sh -c 'tk task add --project p --body "watcher"'`));
});

test("slová mechanizmu a slovenské tvary", () => {
  for (const t of ["slučka", "slučku", "slučkou", "SYSTEMD", "Systemd-Run", "timer", "crontab", "cron", "daemon", "watcher", "polling", "nová služba", "novú službu", "nový skript", "nového skriptu", "novým skriptom", "sudo", "sudoers", "NOPASSWD:SETENV: sudo", "authorized_keys"]) {
    assert.ok(chk(`tk comment 1 --body ${sq(`použijeme ${t} na to`)}`), t);
  }
  for (const t of ["timeout", "deployment", "scronch", "nová úloha", "nový test", "služba beží"]) {
    assert.equal(chk(`tk comment 1 --body ${sq(`použijeme ${t} na to`)}`), null, t);
  }
});

test("ask_agent.sh s heredocom so systemd bez riadku sa zamietne, s riadkom prejde", () => {
  const msg = (extra) => `/opt/agentic-workflow/bin/ask_agent.sh boris nasadenie <<'EOF'\n[Adam za Oskara] Čakanie spusti systemd-run po konci behu.${extra}\nEOF`;
  assert.match(chk(msg("")), /správa `ask_agent.sh` nesie mechanizmus \(systemd\)/);
  assert.equal(chk(msg(`\n${OVERENY}`)), null);
  assert.ok(chk(`cat <<EOF | ask_agent.sh boris t\nnový skript\nEOF`));
  assert.ok(chk(`ask_agent.sh boris t --vedomie --dopad "cron" <<'EOF'\nahoj\nEOF`));
  assert.equal(run(msg("")).permissionDecision, "deny");
});

test("--body so $(cat <<EOF) a $(cat súbor)", () => {
  const files = { "/tmp/z.md": "čakanie cez timer", "/tmp/ok.md": "bez mechanizmu" };
  const read = (f) => files[f] ?? null;
  assert.ok(chk(`tk task add --project p --body "$(cat <<'EOF'\nspusti systemd\nEOF\n)"`, { read }));
  assert.equal(chk(`tk task add --project p --body "$(cat <<'EOF'\nspusti systemd\n${OVERENY}\nEOF\n)"`, { read }), null);
  assert.ok(chk(`tk task add --project p --body "$(cat /tmp/z.md)"`, { read }));
  assert.ok(chk(`tk task add --project p --body "úvod $(cat /tmp/z.md)"`, { read }));
  assert.equal(chk(`tk task add --project p --body "$(cat /tmp/ok.md)"`, { read }), null);
  assert.equal(chk(`tk task add --project p --body "$(cat /tmp/nie-je.md)"`, { read }), null);
  assert.equal(chk(`tk task add --project p --body "$BODY"`, { read }), null);
});

test("skutočný súbor sa číta", () => {
  const dir = mkdtempSync(join(tmpdir(), "own-mech-"));
  try {
    const f = join(dir, "body.md");
    writeFileSync(f, "slučka cez systemd\n");
    assert.ok(chk(`tk task add --project p --body "$(cat ${f})"`));
    writeFileSync(f, `slučka cez systemd\n${OVERENY}\n`);
    assert.equal(chk(`tk task add --project p --body "$(cat ${f})"`), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("echo, grep, cat a iné príkazy so zmienkou pustí; zadanie bez mechanizmu pustí", () => {
  assert.equal(chk("echo systemd"), null);
  assert.equal(chk("grep -rn timer ."), null);
  assert.equal(chk("cat /etc/systemd/system/x.timer"), null);
  assert.equal(chk("systemctl status agentic-workflow-sync.timer"), null);
  assert.equal(chk(`git commit -m "timer a systemd" -- x`), null);
  assert.equal(chk(`cat > /tmp/x <<'EOF'\nsystemd\nEOF`), null);
  assert.equal(chk(`tk task show 585 --json | grep systemd`), null);
  assert.equal(chk(`${TK} task add --project agenti --title "Hook" --body "Zamietne zadanie bez riadku."`), null);
  assert.equal(chk(`ask_agent.sh boris t <<'EOF'\nPošli commit.\nEOF`), null);
  assert.equal(run("echo systemd"), null);
});

test("zoznam slov nie je prázdny a každé slovo zamieta (sabotáž zoznamu musí zhodiť test)", () => {
  assert.ok(MECHANISM.length >= 11);
  for (const [name, re] of MECHANISM) assert.ok(re instanceof RegExp, name);
  assert.ok(chk(`tk comment 1 --body "systemd"`));
});

test("jednoriadkové telo: Nástroj overený za medzerou alebo interpunkciou prejde", () => {
  const one = ` Nástroj overený: tasker block --help, blokér čaká len na úlohu`;
  assert.ok(chk(`${TK} task add --project agenti --body ${sq(BODY_585)}`));
  assert.equal(chk(`${TK} task add --project agenti --body ${sq(BODY_585 + one)}`), null);
  assert.equal(chk(`${TK} task add --project agenti --body ${sq(BODY_585 + "." + one.trim())}`), null);
  assert.equal(chk(`${TK} task add --project agenti --body ${sq(OVERENY.slice(0) + " a systemd")}`), null);
  assert.equal(chk(`${TK} comment 5 --body ${sq("(systemd) - Nástroj overený: tasker wait --help")}`), null);
  // Prázdny obsah, slovo prilepené k inému slovu a iný riadok nestačia.
  assert.ok(chk(`${TK} task add --project agenti --body ${sq("systemd. Nástroj overený:")}`));
  assert.ok(chk(`${TK} task add --project agenti --body ${sq("systemd. PodNástroj overený: x")}`));
  assert.ok(chk(`${TK} task add --project agenti --body ${sq("systemd. Nástroj nie je overený: x")}`));
  assert.equal(run(`${TK} task add --project agenti --body ${sq(BODY_585 + one)}`), null);
});

test("meno jednotky s príponou .timer v hlásení výstupu nie je mechanizmus (úloha 622)", () => {
  assert.equal(chk(`tk comment 622 --body "systemctl disable --now agent-morning.timer: Removed /etc/systemd/system/timers.target.wants/agent-morning.timer. is-enabled -> disabled"`), null);
  assert.ok(chk(`tk comment 622 --body "pridaj timer na ranný súhrn"`));
});
