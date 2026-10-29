#!/usr/bin/env node
// unslop.mjs — SessionStart hook. Vloží do kontextu relácie sekciu "Jadro"
// skillu unslop, pár viet namiesto celého katalógu vzorov.
//
// Persona §5 hovorí, že každý text pre človeka prejde pravidlami unslop. Zo
// skillu model na začiatku vidí len popis. Hook vloží Jadro pri štarte, po
// /clear, pri resume aj po kompakcii. Celý katalóg stál asi 6 tisíc tokenov
// pri každom štarte, Jadro pár stoviek a v skúške písalo rovnako čisto
// (DECISIONS.md 2026-10-15, audit kontextu).
//
// Claude Code vloží z jedného additionalContext najviac 10 000 znakov.
// Dlhšie Jadro hook ohlási a skončí s kódom 1, check.mjs to zachytí pred
// nasadením.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const LIMIT = 10000;
const SKILL = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "unslop", "SKILL.md");

export function core() {
  const raw = readFileSync(SKILL, "utf8");
  // Verzia, ktorú agent ohlási v prvej odpovedi. Operátor ju porovná so shasum súboru.
  const version = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  const m = raw.match(/\n## Jadro\n([\s\S]*?)\n## /);
  if (!m) throw new Error(`v ${SKILL} chýba sekcia "## Jadro"`);
  // Prvý odsek Jadra opisuje hook, model ho nepotrebuje.
  const body = m[1].trim().split(/\n\n/).slice(1).join("\n\n");
  return `Pravidlá písania unslop, persona §5, verzia ${version}. Platia pre každý text pre človeka, po slovensky aj po anglicky. Prvá odpoveď relácie má na prvom riadku len meno agenta s dvojbodkou (bez persony bez mena riadku), potom prázdny riadok, riadok \`unslop: načítané, hook, verzia ${version}\` a prázdny riadok. Každý riadok úvodu a text odpovede oddeľ prázdnym riadkom, T3 jeden znak nového riadku zlepí do medzery. Pri dlhšom dokumente prejdi aj katalóg vzorov v skille unslop.\n\n${body}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let text;
  try {
    text = core();
  } catch (e) {
    // Hook reláciu nezastaví. Chýbajúci skill ohlási check.mjs.
    process.stderr.write(`unslop.mjs: ${e.message}\n`);
    process.exit(1);
  }
  if (text.length > LIMIT) {
    process.stderr.write(`unslop.mjs: Jadro má ${text.length} znakov, limit je ${LIMIT}\n`);
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
  }));
}
