#!/usr/bin/env node
// requires: tasker
// review_replay.mjs — posudok s tvrdením o účinku kódu bez dôkazu prehrania. Dňa 31. 10. 2026
// (chyba, úloha 718) správca servera v posudku úlohy 708 napísal, že `mergeSettings` vyhodí každý starý
// záznam a inštalácia na Macu zmaže aj záznam `guard.mjs` v `~/.claude/settings.json`.
// Tvrdenie bolo nepravdivé, zástupca operátora na Macu ho vyvrátil prehraním na kópii `settings.json`. Čítanie kódu
// účinok nedokazuje (RULES.md §1: tvrdenie over pred uvedením), dôkaz je prehranie.
//
// PreToolUse pre Bash. Posudzuje text, ktorý zapisuje do úlohy:
//  - `tk`/`tasker` `comment` a `task comment` (--body) a `done` (--summary), aj cez cestu
//    a s premennými prostredia pred príkazom,
//  - `--body "$(< súbor)"` a `$(cat súbor)` aj `<<'EOF'` posúdi z textu súboru (súbor len číta).
// Text je posudok, keď nesie slovo `posudok` (aj tvar `posudku`). Posudok sa zamietne, keď:
//  - nesie tvrdenie o účinku: sloveso zmaže, odstráni, vyhodí, prepíše, nahradí, ponechá,
//    zachová, ostane, zachytí, pustí alebo zamietne v určitom tvare (zmaže, zmažú),
//  - a nenesie dôkaz prehrania: `replay`, `prehral`, `prehranie`, `prehrané` alebo `na kópii`.
// Hranice slov sú pre unicode (\p{L}): `zmaže` sa nehľadá v `nazmažený` a `ostane` sa nehľadá
// v `prostane`. Slovo za `.`, `-`, `/` alebo `@` (názov súboru `replay.sh`) dôkaz nie je a ani
// tvrdenie. Posudok bez slovesa účinku a bežný komentár bez slova `posudok` hook pustí, rovnako
// `echo`, `grep` a `cat` so zmienkou. Dôkaz stačí kdekoľvek v texte, kontroluje sa jeho
// prítomnosť, nie pravdivosť (tú posúdi čitateľ podľa príkazu a výstupu, ktorý postup žiada).

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { denyTool } from "../lib/deny.mjs";
import { taskerCommands } from "./web_review.mjs";
import { inlineSubstitutions } from "./human_question.mjs";

const B = String.raw`(?<![\p{L}\p{N}_.\-/@])`;
const E = String.raw`(?![\p{L}\p{N}_])`;
const re = (src) => new RegExp(`${B}(?:${src})${E}`, "iu");

export const POSUDOK = re(String.raw`posud(?:ok|k\p{L}*)`);
// Len určitý tvar slovesa (3. osoba prítomného alebo budúceho času) je tvrdenie o účinku.
// Príčastie a podstatné meno (zmazaný, odstránenie, nahradené, zamietnutie) opisuje stav alebo
// nález, prehranie v posudkoch z Taskera 31. 10. 2026 pri nich dávalo falošné zamietnutia.
export const EFFECT = re(
  [
    String.raw`zma[žz](?:e|ú)`,
    String.raw`odstr[aá]ni(?:a)?`,
    String.raw`vyhod(?:í|ia)|vyhadzuj(?:e|ú)`,
    String.raw`prep[íi]š(?:e|u)|prepisuj(?:e|ú)`,
    String.raw`nahrad(?:í|ia)|nahrádz(?:a|ajú)`,
    String.raw`ponech(?:á|ajú)`,
    String.raw`zachov(?:á|ajú)`,
    String.raw`ostan(?:e|ú)`,
    String.raw`zachyt(?:í|ia)`,
    String.raw`pust(?:í|ia)`,
    String.raw`zamietn(?:e|u)`,
  ].join("|"),
);
export const REPLAY = re(String.raw`replay\p{L}*|prehr[aá]l\p{L}*|prehran\p{L}*|na\s+kópii`);

export const MESSAGE =
  "Posudok tvrdí účinok kódu (zmaže, odstráni, vyhodí, prepíše, ponechá...) a nenesie dôkaz prehrania " +
  "(`replay`, `prehral`, `na kópii`). Čítanie kódu účinok nedokazuje (chyba 31. 10. 2026, úloha 718: " +
  "tvrdenie o `mergeSettings` z úlohy 708 vyvrátilo prehranie na kópii settings.json).";

export const POSTUP =
  "prehraj tvrdenie na kópii vstupu a do komentára daj príkaz a výstup prehrania (napr. `Replay na kópii settings.json: <príkaz> -> <výstup>`)";

const MAX_FILE = 100_000;
const readText = (file) => {
  try {
    const st = statSync(file);
    return st.isFile() && st.size <= MAX_FILE ? readFileSync(file, "utf8") : null;
  } catch { return null; }
};

function flagValue(args, name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) return args[i + 1];
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
  }
  return undefined;
}

// `$(< súbor)` je ekvivalent `$(cat súbor)`, parser z human_question.mjs pozná len druhý tvar.
const ltToCat = (raw) => raw.replace(/\$\(\s*<\s*([^\s"'$`;|&<>()\\]+)\s*\)/g, "$(cat $1)");

// Text so zostávajúcim `$(cat /súbor)` (aj v texte okolo) doplní o obsah súboru.
function withFiles(text, read) {
  let out = text;
  for (const m of text.matchAll(/\$\(\s*cat\s+([^\s"'$`;|&<>()\\]+)\s*\)/g)) out += `\n${read(m[1]) ?? ""}`;
  return out;
}

// Texty zapisované do úlohy: [{ what, text }].
export function reviewTexts(raw, read = readText) {
  const src = inlineSubstitutions(ltToCat(raw), read);
  const out = [];
  for (const { rest } of taskerCommands(src)) {
    let flag;
    let what;
    if (rest[0] === "comment" || (rest[0] === "task" && rest[1] === "comment")) { flag = "body"; what = "komentár"; }
    else if (rest[0] === "done" || (rest[0] === "task" && rest[1] === "done")) { flag = "summary"; what = "zhrnutie `done`"; }
    else continue;
    const args = rest.slice(1);
    const v = flagValue(args, flag);
    if (v !== undefined) out.push({ what, text: withFiles(v, read) });
    const file = flagValue(args, "body-file");
    const t = file === undefined ? null : read(file);
    if (t !== null) out.push({ what, text: t });
  }
  return out;
}

// Vráti dôvod zamietnutia alebo null. `read` je čítanie súboru (testy).
export function reviewReplayReason(raw, { read = readText } = {}) {
  for (const { what, text } of reviewTexts(raw, read)) {
    if (!POSUDOK.test(text) || REPLAY.test(text)) continue;
    const m = text.match(new RegExp(EFFECT.source, "iu"));
    if (m) return `${what} je posudok s tvrdením o účinku ("${m[0]}") bez dôkazu prehrania`;
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  if (input.tool_name !== "Bash") process.exit(0);
  const why = reviewReplayReason(String((input.tool_input || {}).command || ""));
  if (!why) process.exit(0);
  denyTool(`${MESSAGE} (${why})`, POSTUP);
}
