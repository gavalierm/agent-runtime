#!/usr/bin/env node
// agent_inbox.mjs — agent na Macu nevynechá správu iného agenta. Pri každej správe
// operátora pozrie svoju schránku na serveri a keď v nej niečo čaká, pridá
// pokyn prečítať ju pred odpoveďou. 15. 10. 2026 čakala správa o zastavenej
// migrácii agenta 70 minút a ten agent medzitým nebežal.
//
// UserPromptSubmit z .claude/settings.json repa agenta. SSH ide cez .scratch/bin/ssh repa agenta
// s vlastným kľúčom agenta. Nedostupný server po 6 s preskočí a povie to.
// Bez AGENT_INBOX_HOSTS hook nerobí nič.
//
// Témy (topic.mjs): relácii s témou hlási len správy jej témy a správy bez
// témy, ostatné len spočíta. Rovnako ich vyberá bin/ask_agent.sh --replies.
// Téma, ktorú agent nepozná (nemá zámok ani súbor v memory/topics), sa
// počíta ako správa bez témy. 16. 10. 2026 poslal iný agent správu s neznámou
// témou a žiadna relácia ju neprečítala.

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { activeTopic, STATE, topicOf } from "./topic.mjs";
import { AGENT_REPO } from "./agent_repo.mjs";

// Repo agenta, nie repo kódu (hooks/agent_repo.mjs).
const REPO = AGENT_REPO;
const SSH = join(REPO, ".scratch/bin/ssh");
// Účet a adresy servera (`účet@adresa`, cez čiarku, vyskúšajú sa po poradí) a schránka
// agenta na serveri. Bez AGENT_INBOX_HOSTS hook mlčí, schránka je predvolene
// /var/lib/<AGENT_NAME>/inbox.
export const HOSTS = (process.env.AGENT_INBOX_HOSTS || "").split(",").filter(Boolean);
export const OUTBOX = process.env.AGENT_INBOX_OUTBOX || `/var/lib/${process.env.AGENT_NAME || "agent"}/inbox`;

// Meno správy je <odosielateľ>-<téma>-<čas> alebo <odosielateľ>-<čas>.
// Agent má na serveri vlastnú schránku (úloha 344), správy v nej sú všetky jeho,
// filter podľa predpony a dátumu zanikol.
export const topicOfFile = (f) => f.replace(/^[^-]*-/, "").match(/^([a-z][a-z0-9_]*)-[0-9]/)?.[1] || "";
export const mineOf = (files, topic, known = []) =>
  topic ? files.filter((f) => { const t = topicOfFile(f); return t === topic || !known.includes(t); }) : files;
export const knownTopics = () =>
  [join(STATE, "locks"), join(REPO, "memory", "topics")].flatMap((d) => (existsSync(d) ? readdirSync(d).map((f) => f.replace(/\.md$/, "")) : []));

const main = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
// Zrušený fetch nechá otvorené spojenie až 10 s, po zápise výstupu proces ukončím.
if (main) { await run(); process.stdout.write("", () => process.exit(0)); }

async function run() {
  if (!HOSTS.length) return;
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  const topic = topicOf(input.session_id);
  // Relácia, ktorej tému prevzala iná, správy nečíta, dostane ich držiteľ.
  if (topic && activeTopic(input.session_id) !== topic) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: `Tému ${topic} drží iná relácia, správy zo schránky v nej nečítaj.` } }));
    return;
  }
  let out = null;
  for (const h of HOSTS) {
    const r = spawnSync(SSH, ["-o", "ConnectTimeout=3", h, `ls -1 ${OUTBOX}`], { encoding: "utf8", timeout: 6000 });
    if (r.status === 0) { out = r.stdout; break; }
  }
  const all = out === null ? null : out.split("\n").filter((f) => (f.endsWith(".md") || f.includes(".md.")));
  const files = all === null ? null : mineOf(all, topic, knownTopics());
  let msg = "";
  if (files === null) msg = "Tvoju schránku na serveri sa nepodarilo prečítať, server neodpovedal do 6 s. Over spojenie skôr, než dáš pokyn správcovi servera.";
  else if (files.length) msg = `V tvojej schránke na serveri čaká ${files.length} správ${topic ? ` pre tému ${topic} alebo bez témy` : ""} (${files.slice(0, 5).join(", ")}). Prečítaj ich príkazom bin/ask_agent.sh --replies pred odpoveďou operátorovi a vybav, čo z nich vyplýva.`;
  const others = all === null ? 0 : all.length - files.length;
  if (others) msg += `${msg ? " " : ""}Ďalších ${others} správ patrí iným témam, tie nečítaj.`;
  if (msg) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: msg } }));
}
