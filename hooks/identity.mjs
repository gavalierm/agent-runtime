#!/usr/bin/env node
// identity.mjs — relácia agenta s identitou ohlási v prvej odpovedi, kto je
// (ohlásenie identity). SessionStart zo settings.json prostredia alebo
// .claude/settings.json repa agenta, beží pri štarte, obnovení, /clear
// aj kompakcii. Meno vezme z nadpisu "# <Meno>" v PERSONA.md koreňa
// projektu, ID relácie zo vstupu hooku. Bez PERSONA.md hook mlčí.
// Riadok "Role: <slug>, <slug>" v PERSONA.md pridá do kontextu pravidlá
// roly zo súborov roles/<slug>.md klonu repa pravidiel (rulesRepo: AGENT_RULES_REPO,
// predvolene /opt/agent-rules, na Macu ~/Work/agent-rules).
// Neznámy slug dá upozornenie v kontexte, hook nepadne.
//
// Operátor overí ID príkazom `node hooks/topic.mjs list` repa pravidiel.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { hookEnv, rulesRepo } from "../lib/agent_env.mjs";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {}

const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
let name;
let persona = "";
try {
  persona = readFileSync(join(root, "PERSONA.md"), "utf8");
  name = persona.match(/^# (.+)$/m)?.[1].trim();
} catch {}
if (!name) process.exit(0);

const session = (input.session_id || "neznáma").slice(0, 8);
const line = `${name}, persona ${join(root, "PERSONA.md")}, relácia ${session}`;

const rolesDir = join(rulesRepo(hookEnv(input)), "roles");
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
      additionalContext: `Si ${name} podľa PERSONA.md. Prvá odpoveď tejto relácie, aj po /clear, obnovení a kompakcii, má na prvom riadku len meno (\`${name}:\`), potom prázdny riadok, riadok unslop, prázdny riadok, riadok \`identita: ${line}\`, prázdny riadok a jednu vetu, kto si, podľa časti "Kto som" v PERSONA.md.${rules}`,
    },
  }),
);
