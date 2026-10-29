#!/usr/bin/env node
// own_mechanism.mjs — zadanie práce navrhuje nový vlastný mechanizmus a neukazuje,
// že existujúci nástroj ho nemá (global/CLAUDE.md §6: "Before designing your own
// mechanism, check whether the tool already does it"). Dňa 25. 10. 2026 správca agentov zadal
// Ronovi úlohu 585 s `systemd-run` na čakanie na koniec behu Taskera, hoci Tasker
// vie čakať sám: `tasker wait --until` s kontrolou behov, blokér len na done úlohy
// (úlohy 586 a 596).
//
// PreToolUse pre Bash. Posudzuje len príkazy, ktoré zadávajú prácu:
//  - `tk`/`tasker` `task add` (text je --title a --body), `comment` a `task comment`
//    (--body), aj cez cestu a s premennými prostredia pred nimi,
//  - `ask_agent.sh` (text je telo heredocu na stdin, `< súbor` a --dopad).
// Text, ktorý nesie slovo z MECHANISM a nemá riadok `Nástroj overený: <príkaz a
// výstup>`, sa zamietne. Ostatné príkazy (echo, grep, cat so zmienkou systemd)
// hook pustí. `--body "$(cat <<'EOF' ... EOF)"` a `$(cat /súbor)` posúdi z textu
// (súbor len číta), `--body-file` a iné `$VAR` bez čitateľného súboru pustí.
// Zmienka slova v negácii ("bez systemd") sa neposudzuje, rozhoduje riadok
// `Nástroj overený:`.

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { denyTool } from "../lib/deny.mjs";
import { commands, taskerCommands } from "./web_review.mjs";
import { inlineSubstitutions } from "./human_question.mjs";

// Slová vlastného mechanizmu: [názov pre hlásenie, vzor]. Vzory sa hľadajú bez ohľadu
// na veľkosť písmen, s hranicami slova pre unicode (slovenské tvary: slučka, slučku,
// slučkou, nová službu, nového skriptu). Zoznam dopĺňaj tu, nikde inde.
// Slovo za `.`, `-`, `/` alebo `@` je časť mena jednotky či cesty (`agent-morning.timer`,
// `/etc/cron.d`) a nie návrh mechanizmu (chyba 26. 10. 2026, úloha 622: komentár
// s výstupom `systemctl disable --now agent-morning.timer` zamietnutý).
const W = String.raw`[\p{L}\p{N}_]`;
const word = (src) => new RegExp(String.raw`(?<![\p{L}\p{N}_.\-/@])(?:${src})(?!${W})`, "iu");
export const MECHANISM = [
  ["systemd", word(String.raw`systemd(?:-run)?`)],
  ["timer", word(String.raw`timer\p{L}*`)],
  ["cron", word(String.raw`cron(?:tab|job)?\p{L}*`)],
  ["slučka", word(String.raw`slu[čc](?:k|ie)\p{L}*`)],
  ["daemon", word(String.raw`daemon\p{L}*`)],
  ["watcher", word(String.raw`watcher\p{L}*`)],
  ["polling", word(String.raw`polling\p{L}*`)],
  ["nová služba", word(String.raw`nov\p{L}{0,4}\s+služ\p{L}*`)],
  ["nový skript", word(String.raw`nov\p{L}{0,4}\s+skript\p{L}*`)],
];

// Riadok, ktorým zadávateľ ukáže, že existujúci nástroj mechanizmus nemá.
// Stojí na začiatku textu alebo za čímkoľvek, čo nie je písmeno ani číslica (medzera,
// interpunkcia, odrážka), aj v jednoriadkovom tele; za dvojbodkou musí byť obsah.
const VERIFIED = /(?<![\p{L}\p{N}_])Nástroj overený:[ \t]*\S/u;

export const MESSAGE =
  "Zadanie navrhuje nový vlastný mechanizmus (global §6: pred vlastným mechanizmom over, či to nástroj už nerobí) " +
  "a nemá riadok `Nástroj overený: <príkaz a výstup>`. Tasker vie čakať na done inej úlohy blokérom " +
  "`tasker block <id> --by <úloha> --reason \"...\"` a na čas či na koniec behu `tasker wait <id> --reason \"beh N\" --until <čas>` " +
  "s kontrolou `tk run list --json` po zobudení (chyba 25. 10. 2026, úloha 585: systemd-run tam, kde stačilo wait; úloha 596: blokér na úlohu behu nestačí).";

export const POSTUP =
  "over, čo nástroj už vie (`tasker <príkaz> --help`, README, skilly), a do zadania pridaj riadok " +
  "`Nástroj overený: <príkaz a výstup>`, napr. `Nástroj overený: tasker block --help nevie čakať na beh, preto skript`.";

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

// Text so zostávajúcim `$(cat /súbor)` doplní o obsah súboru, keď existuje.
function withFiles(text, read) {
  let out = text;
  for (const m of text.matchAll(/\$\(\s*cat\s+([^\s"'$`;|&<>()\\]+)\s*\)/g)) out += `\n${read(m[1]) ?? ""}`;
  return out;
}

// Texty zadaní v príkaze: [{ what, text }].
export function assignmentTexts(raw, read = readText) {
  const src = inlineSubstitutions(raw, read);
  const out = [];
  for (const { rest } of taskerCommands(src)) {
    let flags;
    let what;
    if (rest[0] === "task" && rest[1] === "add") { flags = ["title", "body"]; what = "úloha `task add`"; }
    else if (rest[0] === "comment" || (rest[0] === "task" && rest[1] === "comment")) { flags = ["body"]; what = "komentár"; }
    else continue;
    const args = rest.slice(1);
    for (const f of flags) {
      const v = flagValue(args, f);
      if (v !== undefined) out.push({ what, text: withFiles(v, read) });
    }
    const file = flagValue(args, "body-file");
    const t = file === undefined ? null : read(file);
    if (t !== null) out.push({ what, text: t });
  }
  // ask_agent.sh: heredoc na riadku s príkazom, `< súbor`, --dopad.
  const isAsk = (words) => {
    const i = words.findIndex((w) => basename(w) === "ask_agent.sh");
    return i < 0 ? -1 : words.slice(0, i).every((w) => /^[A-Za-z_]\w*=/.test(w) || /^(?:ba)?sh$/.test(basename(w))) ? i : -1;
  };
  for (const m of src.matchAll(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*(?=\n|$)/g)) {
    const start = src.lastIndexOf("\n", m.index) + 1;
    const line = src.slice(start, m.index + m[0].indexOf("\n"));
    if (commands(line).some((w) => isAsk(w) >= 0)) out.push({ what: "správa `ask_agent.sh`", text: m[3] });
  }
  for (const words of commands(src)) {
    const i = isAsk(words);
    if (i < 0) continue;
    const dopad = flagValue(words.slice(i + 1), "dopad");
    if (dopad !== undefined) out.push({ what: "správa `ask_agent.sh`", text: dopad });
    const lt = words.indexOf("<");
    const t = lt >= 0 && words[lt + 1] ? read(words[lt + 1]) : null;
    if (t !== null) out.push({ what: "správa `ask_agent.sh`", text: t });
  }
  return out;
}

// Vráti dôvod zamietnutia alebo null. `read` je čítanie súboru (testy).
export function ownMechanismReason(raw, { read = readText, mechanism = MECHANISM } = {}) {
  const texts = assignmentTexts(raw, read);
  // Riadok `Nástroj overený:` v ktoromkoľvek texte príkazu (nadpis, telo, dopad) kryje celý príkaz.
  if (texts.some(({ text }) => VERIFIED.test(text))) return null;
  const hits = [];
  for (const { what, text } of texts) {
    const found = mechanism.filter(([, re]) => re.test(text)).map(([name]) => name);
    if (found.length) hits.push(`${what} nesie mechanizmus (${found.join(", ")})`);
  }
  return hits.length ? hits[0] : null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  if (input.tool_name !== "Bash") process.exit(0);
  const why = ownMechanismReason(String((input.tool_input || {}).command || ""));
  if (!why) process.exit(0);
  denyTool(`${MESSAGE} (${why})`, POSTUP);
}
