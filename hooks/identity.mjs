#!/usr/bin/env node
// identity.mjs — relácia agenta s identitou ohlási v prvej odpovedi, kto je
// (ohlásenie identity). SessionStart zo settings.json prostredia alebo
// .claude/settings.json repa agenta, beží pri štarte, obnovení, /clear
// aj kompakcii. Meno vezme z nadpisu "# <Meno>" v PERSONA.md koreňa
// projektu, ID relácie zo vstupu hooku. Bez PERSONA.md v koreni hľadá
// vlákno témy agenta (personaFor v lib/agent_name.mjs, úloha 636): vlákno témy beží
// v klone projektu, po kompakcii zabudlo, kto je, a správu Taskera
// "úloha pre teba" odmietlo ako cudziu. Bez persony hook mlčí.
// Riadok "Role: <slug>, <slug>" v PERSONA.md pridá do kontextu pravidlá
// roly zo súborov roles/<slug>.md tohto repa (workflowDir v lib/paths.mjs).
// Neznámy slug dá upozornenie v kontexte, hook nepadne.
//
// Operátor overí ID príkazom `node hooks/topic.mjs list`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hookEnv } from "../lib/agent_env.mjs";
import { workflowDir } from "../lib/paths.mjs";
import { personaFor } from "../lib/agent_name.mjs";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {}

const found = personaFor(input);
if (!found) process.exit(0);
const { name, root, persona, topic } = found;

const session = (input.session_id || "neznáma").slice(0, 8);
const line = `${name}, persona ${join(root, "PERSONA.md")}, relácia ${session}${topic ? `, vlákno témy ${topic}` : ""}`;
const topicNote = topic
  ? ` Toto je tvoje vlákno témy ${topic}: správy Taskera a schránky s touto témou idú sem a úlohy s riešiteľom ${name.toLowerCase()} v nich sú tvoje, rieš ich ako ${name}.`
  : "";

const rolesDir = join(workflowDir(hookEnv(input)), "roles");
const slugs = (persona.match(/^Role:[ \t]*(.+)$/m)?.[1] ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);
let rules = "";
for (const slug of slugs) {
  try {
    if (!/^[a-z0-9-]+$/.test(slug)) throw new Error("slug");
    rules += `\n\n${readFileSync(join(rolesDir, `${slug}.md`), "utf8").trim()}`;
  } catch {
    rules += `\n\nUpozornenie: PERSONA.md uvádza rolu \`${slug}\`, súbor roles/${slug}.md neexistuje. Oznám to správcovi agentov.`;
  }
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `Si ${name} podľa ${join(root, "PERSONA.md")}.${topicNote} Prvá odpoveď tejto relácie, aj po /clear, obnovení a kompakcii, má na prvom riadku len meno (\`${name}:\`), potom prázdny riadok, riadok unslop, prázdny riadok, riadok \`identita: ${line}\`, prázdny riadok a jednu vetu, kto si, podľa časti "Kto som" v PERSONA.md.${rules}`,
    },
  }),
);
