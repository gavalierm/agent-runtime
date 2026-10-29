// lib/rule_dupes.mjs: fixtúra v dočasnom priečinku, živé súbory sa nečítajú.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.AGENT_BRAIN_GLOBAL = join(tmpdir(), "rule-dupes-bez-mozgu");
import { ALLOW_FILE, dupeProblems, ruleDupes, splitUnits } from "./rule_dupes.mjs";

const RULE = "Čistý kontext spusti, keď je logický celok práce hotový a ďalšia práca predošlý kontext nepotrebuje. Zapíš stav do pamäte, commitni, pushni a odpoveď ukonči riadkom z `kontext.sh spanok`.";
const RULE_COPY = "Čistý kontext spúšťam, keď je logický celok práce hotový a ďalšia práca predošlý kontext nepotrebuje. Stav zapíšem do pamäte, commitnem, pushnem a odpoveď ukončím riadkom z `kontext.sh spanok`.";
const RULE_EN = "Run the clean context when a logical unit of work is done: write the state to memory, commit, push and end the reply with the line from `kontext.sh spanok`, `--stav` and `/clear`.";
const RULE_SK_CODES = "Odpoveď ukončím riadkom z `kontext.sh spanok` a `--stav`, budič potom pošle `/clear` a stav zapíšem do pamäte, commit aj push.";
const MENTION_A = "Hook `reply_guard.mjs` zastaví odpoveď, ktorá nemá meno agenta na prvom riadku.";
const MENTION_B = "Odkaz na úlohu Taskera bez adresy stránky zastaví `reply_guard.mjs`, doplň adresu cez Tailscale.";

function fixture({ shared, agents }) {
  const repo = mkdtempSync(join(tmpdir(), "rule-dupes-"));
  mkdirSync(join(repo, "roles"));
  mkdirSync(join(repo, "lib"));
  writeFileSync(join(repo, "RULES.md"), shared.global ?? "# Global\n");
  writeFileSync(join(repo, "roles", "rola.md"), shared.rola ?? "# Rola\n");
  writeFileSync(join(repo, "roles", "agents.md"), shared.agentsMd ?? "# Agenti\n");
  const list = Object.entries(agents).map(([name, files]) => {
    const dir = join(repo, "agenti", name);
    mkdirSync(dir, { recursive: true });
    for (const [f, t] of Object.entries(files)) writeFileSync(join(dir, f), t);
    return { name, dir };
  });
  return { repo, list };
}

test("jednotky: odrážka s pokračovaním, odsek, zalomený dátum, nadpis a kód ich oddelia", () => {
  const u = splitUnits("# Nadpis\n\n- prvá odrážka\n  pokračuje tu, chyba z 18.\n  10. 2026 sa zalomila\n- druhá\n\nOdsek\ndva riadky\n\n```\n- kód\n```\n1. číslovaný bod\n");
  assert.deepEqual(u.map((x) => x.text), ["prvá odrážka pokračuje tu, chyba z 18. 10. 2026 sa zalomila", "druhá", "Odsek dva riadky", "číslovaný bod"]);
  assert.equal(u[0].start, 3);
});

test("skutočný duplikát lokálneho pravidla v zdieľanom súbore sa nájde", () => {
  const { repo, list } = fixture({ shared: { rola: `# Rola\n\n- ${RULE}\n` }, agents: { boris: { "PERSONA.md": `# Boris\n\n- ${RULE_COPY}\n` } } });
  const { findings } = ruleDupes(repo, list);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "shared");
  assert.match(dupeProblems(repo, list)[0], /rola\.md:3 ~ .*boris\/PERSONA\.md:3/);
});

test("pravidlo po anglicky v global a po slovensky u agenta sa nájde podľa zhodných kódových výrazov", () => {
  const { repo, list } = fixture({ shared: { global: `# Global\n- ${RULE_EN}\n` }, agents: { boris: { "CLAUDE.md": `- ${RULE_SK_CODES}\n` } } });
  assert.equal(ruleDupes(repo, list).findings.length, 1);
});

test("rozdielne pravidlo s rovnakým spomenutým súborom nie je nález", () => {
  const { repo, list } = fixture({ shared: { global: `- ${MENTION_A}\n` }, agents: { boris: { "CLAUDE.md": `- ${MENTION_B}\n` } } });
  assert.deepEqual(ruleDupes(repo, list).findings, []);
});

test("dva spoločné výrazy bez zhody slov nie sú nález", () => {
  const a = "Pamäť je v `memory/`, pravidlá v `CLAUDE.md` a `PERSONA.md` agenta.";
  const b = "Podpis commitu nesie meno stroja, súbory `CLAUDE.md` a `PERSONA.md` zapisuje správca servera.";
  const { repo, list } = fixture({ shared: { global: `- ${a}\n` }, agents: { boris: { "CLAUDE.md": `- ${b}\n` } } });
  assert.deepEqual(ruleDupes(repo, list).findings, []);
});

test("výrazy, ktoré sa spomínajú všade, o zhode nerozhodujú", () => {
  const a = "Pamäť je v `memory/`, pravidlá v `CLAUDE.md` a `PERSONA.md`, rozhodnutia v `DECISIONS.md` agenta.";
  const b = "Commit podpíš menom, súbory `CLAUDE.md`, `PERSONA.md` a `DECISIONS.md` mení len správca pravidiel.";
  const filler = Array.from({ length: 9 }, (_, i) => `- Voľné pravidlo číslo ${i} spomína \`CLAUDE.md\`, \`PERSONA.md\` a \`DECISIONS.md\` bez ďalších slov.`).join("\n");
  const common = fixture({ shared: { global: `- ${a}\n${filler}\n` }, agents: { boris: { "CLAUDE.md": `- ${b}\n` } } });
  assert.deepEqual(ruleDupes(common.repo, common.list).findings, []);
  const rare = fixture({ shared: { global: `- ${a}\n` }, agents: { boris: { "CLAUDE.md": `- ${b}\n` } } });
  assert.equal(ruleDupes(rare.repo, rare.list).findings.length, 1);
});

test("riadok v allow potlačí nález, zlý riadok je problém", () => {
  const { repo, list } = fixture({ shared: { rola: `- ${RULE}\n` }, agents: { boris: { "PERSONA.md": `- ${RULE_COPY}\n` } } });
  const [f] = ruleDupes(repo, list).findings;
  writeFileSync(join(repo, ALLOW_FILE), `# zámerné opakovanie\n${f.id} persona musí pravidlo nosiť sama, roly sa nenačítajú\n`);
  assert.deepEqual(ruleDupes(repo, list), { findings: [], problems: [] });
  writeFileSync(join(repo, ALLOW_FILE), `${f.id}\n`);
  assert.equal(ruleDupes(repo, list).problems.length, 1);
});

test("id dvojice sa zmení, keď sa zmení text pravidla", () => {
  const mk = (extra) => fixture({ shared: { rola: `- ${RULE}\n` }, agents: { boris: { "PERSONA.md": `- ${RULE_COPY}${extra}\n` } } });
  const a = mk(""), b = mk(" Pridaná veta navyše.");
  assert.notEqual(ruleDupes(a.repo, a.list).findings[0].id, ruleDupes(b.repo, b.list).findings[0].id);
});

test("rovnaké pravidlo u dvoch agentov sa nájde, u jedného agenta v dvoch súboroch nie", () => {
  const two = fixture({ shared: {}, agents: { boris: { "PERSONA.md": `- ${RULE}\n` }, dan: { "CLAUDE.md": `- ${RULE_COPY}\n` } } });
  const r = ruleDupes(two.repo, two.list);
  assert.equal(r.findings.length, 1);
  assert.equal(r.findings[0].kind, "agents");
  const one = fixture({ shared: {}, agents: { boris: { "PERSONA.md": `- ${RULE}\n`, "CLAUDE.md": `- ${RULE_COPY}\n` } } });
  assert.deepEqual(ruleDupes(one.repo, one.list).findings, []);
});

test("env/*/RULES.md sa berie zo spoločného mozgu, ak priečinok existuje", () => {
  const { repo, list } = fixture({ shared: {}, agents: { boris: { "PERSONA.md": `# Boris\n\n- ${RULE_COPY}\n` } } });
  assert.deepEqual(ruleDupes(repo, list).findings, []);
  const brain = mkdtempSync(join(tmpdir(), "rule-dupes-brain-"));
  mkdirSync(join(brain, "env", "server"), { recursive: true });
  writeFileSync(join(brain, "env", "server", "RULES.md"), `# Server\n\n- ${RULE}\n`);
  const { findings } = ruleDupes(repo, list, brain);
  assert.equal(findings.length, 1);
  assert.match(findings[0].a.abs, /env\/server\/RULES\.md$/);
});
