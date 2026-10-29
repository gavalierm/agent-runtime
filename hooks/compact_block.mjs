#!/usr/bin/env node
// compact_block.mjs — kompakcia kontextu je zakázaný stav (D0190, operátor
// 28. 10. 2026). PreCompact pre `manual` aj `auto`: skončí kódom 2, Claude Code
// kompakciu preskočí. Nastavenie `autoCompactEnabled: false` ju vypína,
// hook je zábrana aj proti `/compact` a proti `true` z nastavenia projektu.
// Plný kontext potom skončí chybou limitu API (prompt is too long), nie
// súhrnom. Čistý kontext dáva slovo HOTOVO-KONTEXT (bin/kontext.sh), pokyn
// naň dáva context_warning.mjs od 80 tisíc tokenov.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { exitDeny } from "../lib/deny.mjs";

export const MESSAGE =
  "Kompakcia kontextu je zakázaný stav (D0190, env/server/CLAUDE.md, Schránky a budič). Súhrn prepíše prepis a agent stratí, čo sľúbil a overil.";

export const POSTUP =
  "po hotovom celku zapíš stav do pamäte, commitni, pushni a odpoveď ukonči riadkom z `bin/kontext.sh spanok --stav \"<súhrn>\"` " +
  "alebo `pokracuj --dalej \"<krok>\"`, budič pošle /clear.";

// Vráti dôvod zamietnutia, keď vstup je PreCompact, inak null.
export function verdict(input) {
  if (!input || input.hook_event_name !== "PreCompact") return null;
  const trigger = input.trigger === "manual" ? "/compact" : "automatická kompakcia";
  return `${trigger}: ${MESSAGE}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  const msg = verdict(input);
  if (msg) exitDeny(msg, POSTUP);
}
