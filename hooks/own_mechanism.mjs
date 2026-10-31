#!/usr/bin/env node
// requires: tasker
// own_mechanism.mjs — zadanie práce navrhuje nový vlastný mechanizmus a neukazuje,
// že existujúci nástroj ho nemá (RULES.md §6: "Before designing your own
// mechanism, check whether the tool already does it"). Dňa 25. 10. 2026 správca agentov zadal
// Ronovi úlohu 585 s `systemd-run` na čakanie na koniec behu Taskera, hoci Tasker
// vie čakať sám: `tasker wait --until` s kontrolou behov, blokér len na done úlohy
// (úlohy 586 a 596).
// Dňa 31. 10. 2026 (úloha 707, trieda navrh-vlastny-mechanizmus, druhý výskyt) správca
// agentov zapísal skriptom `bin/rozhodni.sh` rozhodnutie D0207 s vetou, že mozog musí
// chybu asistenta načítať na štarte každej relácie. Je to nový mechanizmus načítania
// a nepomenúva existujúci (zoznam skillov, ktorý aplikácia ukazuje v každej relácii,
// to už robí). Hook `rozhodni.sh` neposudzoval a slová o štarte relácie nemal.
//
// PreToolUse pre Bash. Posudzuje len príkazy, ktoré zadávajú prácu:
//  - `tk`/`tasker` `task add` (text je --title a --body), `comment` a `task comment`
//    (--body), aj cez cestu a s premennými prostredia pred nimi,
//  - `ask_agent.sh` (text je telo heredocu na stdin, `< súbor` a --dopad),
//  - `rozhodni.sh` (text je telo heredocu, `< súbor`, `cat súbor | ... rozhodni.sh`
//    a hodnota --nazov; --dry-run sa posudzuje rovnako).
// Text, ktorý nesie slovo z MECHANISM, sa zamietne. Prejde, keď niektorý text príkazu
// nesie riadok `Nástroj overený: <príkaz a výstup>` alebo vetu `existujúci mechanizmus
// X to nerobí, lebo Y` (global §6, D0189: nový mechanizmus vzniká, len keď žiadny
// existujúci jeho účel nenesie). Ostatné príkazy (echo, grep, cat so zmienkou systemd)
// hook pustí. `--body "$(cat <<'EOF' ... EOF)"` a `$(cat /súbor)` posúdi z textu
// (súbor len číta), `--body-file` a iné `$VAR` bez čitateľného súboru pustí.
// Zmienka slova v negácii ("bez systemd", "nikdy na štarte relácie") sa neposudzuje,
// rozhoduje riadok alebo veta.

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
  // Prístup pre používateľa je mechanizmus stroja: zadanie ho nesie ako cieľ a
  // riadok `Nástroj overený:` s príkazom (dpkg -s sudo, rozsah podpríkazov),
  // nie ako hotové pravidlo (chyba 30. 10. 2026, úloha 689: pravidlo sudoers
  // na stroji bez balíka sudo, s celým tasker namiesto obmedzeného príkazu).
  ["sudo", word(String.raw`sudo(?:ers)?`)],
  ["authorized_keys", word(String.raw`authorized_keys`)],
  // Načítanie na štarte relácie je mechanizmus: zoznam skillov v aplikácii to robí
  // v každej relácii (chyba 31. 10. 2026, úloha 707, rozhodnutie D0207). Zmienka v
  // negácii sa neposudzuje, rozhoduje riadok `Nástroj overený:` alebo veta EXISTING.
  ["načítanie na štarte relácie", new RegExp(String.raw`(?<![\p{L}\p{N}_])(?:(?:na|pri)\s+[šs]tarte\s+(?:každej\s+|novej\s+|tejto\s+)?rel[áa]cie|SessionStart)(?!${W})`, "iu")],
  ["nový hook", word(String.raw`nov\p{L}{0,4}\s+hook\p{L}*`)],
  ["nová kontrola", word(String.raw`nov\p{L}{0,4}\s+kontrol\p{L}*`)],
  // Jednotné číslo ("vlastný install.sh"), množné ("vlastné skripty správ") nie.
  ["vlastný mechanizmus", word(String.raw`vlastn(?:ý|ú|ým|ého|ou|á)\s+(?:hook|skript|mechaniz|kontrol|install)\p{L}*`)],
];

// Riadok, ktorým zadávateľ ukáže, že existujúci nástroj mechanizmus nemá.
// Stojí na začiatku textu alebo za čímkoľvek, čo nie je písmeno ani číslica (medzera,
// interpunkcia, odrážka), aj v jednoriadkovom tele; za dvojbodkou musí byť obsah.
const VERIFIED = /(?<![\p{L}\p{N}_])Nástroj overený:[ \t]*\S/u;

// Veta, ktorou zadávateľ pomenuje existujúci mechanizmus a povie, prečo nestačí:
// "Existujúci mechanizmus zoznam skillov to nerobí, lebo ukazuje len opisy."
// Kryje príkaz rovnako ako riadok `Nástroj overený:`. Za "lebo" musí byť obsah.
export const EXISTING = /existujúci mechanizmus[^\n]{1,200}?nerobí, lebo[ \t]*\S/iu;

export const MESSAGE =
  "Zadanie navrhuje nový vlastný mechanizmus (global §6: pred vlastným mechanizmom over, či to nástroj už nerobí) " +
  "a nemá riadok `Nástroj overený: <príkaz a výstup>` ani vetu `Existujúci mechanizmus X to nerobí, lebo Y`. " +
  "Tasker vie čakať na done inej úlohy blokérom " +
  "`tasker block <id> --by <úloha> --reason \"...\"` a na čas či na koniec behu `tasker wait <id> --reason \"beh N\" --until <čas>` " +
  "s kontrolou `tk run list --json` po zobudení (chyba 25. 10. 2026, úloha 585: systemd-run tam, kde stačilo wait; úloha 596: blokér na úlohu behu nestačí). " +
  "Chyba 31. 10. 2026, úloha 707: rozhodnutie D0207 chcelo načítať register chýb na štarte relácie, hoci zoznam skillov v aplikácii to už robí.";

export const POSTUP =
  "over, čo nástroj už vie (`tasker <príkaz> --help`, README, skilly, zoznam skillov v aplikácii), a do zadania pridaj riadok " +
  "`Nástroj overený: <príkaz a výstup>`, napr. `Nástroj overený: tasker block --help nevie čakať na beh, preto skript`, " +
  "alebo vetu `Existujúci mechanizmus <názov> to nerobí, lebo <dôvod>`, napr. `Existujúci mechanizmus zoznam skillov v aplikácii to nerobí, lebo ukazuje len opisy skillov`.";

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

// Skripty, ktorých text sa posudzuje: názov, štítok pre hlásenie, voľba s textom a či
// text smie prísť rúrou `cat súbor | skript`.
const SCRIPTS = [
  { name: "ask_agent.sh", what: "správa `ask_agent.sh`", flag: "dopad", pipe: false },
  { name: "rozhodni.sh", what: "rozhodnutie `rozhodni.sh`", flag: "nazov", pipe: true },
];

// Skript v príkaze: { ...SCRIPTS[x], i } (i je miesto mena v slovách) alebo undefined.
// Pred skriptom smú byť len premenné `X=...` a `sh`/`bash`.
const scriptOf = (words) => {
  for (const s of SCRIPTS) {
    const i = words.findIndex((w) => basename(w) === s.name);
    if (i >= 0 && words.slice(0, i).every((w) => /^[A-Za-z_]\w*=/.test(w) || /^(?:ba)?sh$/.test(basename(w)))) return { ...s, i };
  }
  return undefined;
};

// `cat súbor | ...`: [1-3] je súbor (v apostrofoch, v úvodzovkách, holý), [4] zvyšok riadku.
const CAT_PIPE = /(?:^|[\n;&|(])[ \t]*cat[ \t]+(?:'([^'\n]+)'|"([^"$`\n]+)"|([^\s"'$`;|&<>()\\]+))[ \t]*\|[ \t]*([^\n]*)/g;

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
  // ask_agent.sh a rozhodni.sh: heredoc na riadku s príkazom, `< súbor`, vlastná voľba
  // (--dopad, --nazov) a pri rozhodni.sh rúra `cat súbor | ... rozhodni.sh`.
  for (const m of src.matchAll(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)\n\s*\2\s*(?=\n|$)/g)) {
    const start = src.lastIndexOf("\n", m.index) + 1;
    const line = src.slice(start, m.index + m[0].indexOf("\n"));
    const s = commands(line).map(scriptOf).find(Boolean);
    if (s) out.push({ what: s.what, text: m[3] });
  }
  for (const words of commands(src)) {
    const s = scriptOf(words);
    if (!s) continue;
    const v = flagValue(words.slice(s.i + 1), s.flag);
    if (v !== undefined) out.push({ what: s.what, text: v });
    const lt = words.indexOf("<");
    const t = lt >= 0 && words[lt + 1] ? read(words[lt + 1]) : null;
    if (t !== null) out.push({ what: s.what, text: t });
  }
  for (const m of src.matchAll(CAT_PIPE)) {
    const s = scriptOf(commands(m[4])[0] ?? []);
    const t = s?.pipe ? read(m[1] ?? m[2] ?? m[3]) : null;
    if (t !== null && t !== undefined) out.push({ what: s.what, text: t });
  }
  return out;
}

// Vráti dôvod zamietnutia alebo null. `read` je čítanie súboru (testy).
export function ownMechanismReason(raw, { read = readText, mechanism = MECHANISM } = {}) {
  const texts = assignmentTexts(raw, read);
  // Riadok `Nástroj overený:` alebo veta EXISTING v ktoromkoľvek texte príkazu (nadpis, telo, dopad) kryje celý príkaz.
  if (texts.some(({ text }) => VERIFIED.test(text) || EXISTING.test(text))) return null;
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
