#!/usr/bin/env node
// requires: none
// memory_context.mjs — vloží index pamäte agenta do kontextu relácie
// (úloha 614). SessionStart, beží pri štarte, obnovení, /clear aj
// kompakcii, takže pamäť je v kontexte aj po /clear, bez pokynu v správe
// budiča. Koreň repa agenta nájde ako identity.mjs (CLAUDE_PROJECT_DIR,
// inak cwd zo vstupu) a vyžaduje PERSONA.md. Vloží prvých 200 riadkov
// memory/MEMORY.md, ako Claude Code vkladá MEMORY.md vlastnej pamäte.
// Bez PERSONA.md alebo bez MEMORY.md hook mlčí.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const LIMIT = 200;

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {}

const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
let text;
try {
  readFileSync(join(root, "PERSONA.md"), "utf8");
  text = readFileSync(join(root, "memory", "MEMORY.md"), "utf8");
} catch {
  process.exit(0);
}

const lines = text.replace(/\n$/, "").split("\n");
let body = lines.slice(0, LIMIT).join("\n");
if (lines.length > LIMIT) {
  body += `\n\nMEMORY.md má ${lines.length} riadkov, zobrazených ${LIMIT}, zvyšok prečítaj zo súboru.`;
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `Pamäť agenta (memory/MEMORY.md, prvých ${LIMIT} riadkov; je to index, položku čítaj zo súboru memory/<x>.md, keď ju práca potrebuje):\n${body}`,
    },
  }),
);
