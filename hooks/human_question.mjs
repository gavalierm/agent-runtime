#!/usr/bin/env node
// human_question.mjs — otázka pre človeka stojí sama (RULES.md §2, "A question
// or step for a person stands alone, a task summary too"). Chyba 25. 10. 2026: zhrnutie
// behu úlohy 573 znelo "Čaká na operátorovo A/B k zápisu do repa", web Taskera ho
// ukázal bez veci, otázky a významu A a B (úloha 575). Chyba 28. 10. 2026
// (úloha 656): komentár úlohy od agenta bol otázka s voľbou A) B) a niesol
// odsek "Neoverené: ...", operátor namietol, že sa nemá ako rozhodnúť.
// Otázka pre človeka nenesie neoverené tvrdenie (RULES.md §1).
//
// PreToolUse pre Bash: zamietne `tasker`/`tk` `result needs_human --summary T` a
// `ask <id> --body T`, keď T nemá vetu končiacu `?`, spomína voľbu písmenom
// (A/B, variant A, A alebo B) bez definície `A) ...` v tom istom texte alebo
// nesie neoverené tvrdenie. Zamietne aj `comment <id> --body T`, ktorý je
// otázka pre človeka (veta s `?` alebo písmeno voľby) a nesie neoverené
// tvrdenie. Komentár bez otázky je hlásenie stavu a smie písať "neoverené"
// (pasca P1), ostatné pravidlá textu naň hook neuplatňuje. Pravidlá
// textu sú v lib/human_question.mjs. Text z premennej alebo
// `$(...)` hook nevyhodnotí a pustí; výnimka je `$(cat <<'EOF' ... EOF)` (text z tela
// heredocu v príkaze) a `$(cat /súbor)` (existujúci čitateľný súbor, hook ho len číta). Nevolá Tasker ani schránky.

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { taskerCommands } from "./web_review.mjs";
import { denyTool } from "../lib/deny.mjs";
import { questionProblem, unverifiedClaim, hasQuestion, usedLetters } from "../lib/human_question.mjs";

export const POSTUP =
  "napíš text ako vec, otázku končiacu `?`, čo spôsobí každá odpoveď a odporúčanie; písmeno voľby definuj ako `A) ...`; " +
  "neoverené tvrdenie over teraz (skúška, kód, dokumentácia) a do textu napíš výsledok; otázka pre človeka nenesie neoverené tvrdenie (global §1) " +
  "(napr. `tk ask <id> --body \"Zapísať vzor do repa? A) áno, commitnem. B) nie, napíš, čo zmeniť. Odporúčam A.\"`)";

// Hodnota voľby `--name T` alebo `--name=T`.
function flagValue(args, name) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === `--${name}`) return args[i + 1];
    if (args[i].startsWith(`--${name}=`)) return args[i].slice(name.length + 3);
  }
  return undefined;
}

// Premenná alebo príkazová substitúcia $(...): text hook nepozná. Spätný apostrof v texte je kód v markdowne.
const DYNAMIC = /\$\(|\$\{|\$[A-Za-z_]/;

const MAX_FILE = 100_000;
// Text vložený do reťazca v úvodzovkách: `\ " $ `` sa uniknú, shell ho pri
// rozbore vráti nezmenený.
const quote = (t) => `"${t.replace(/[\\"$`]/g, "\\$&")}"`;
const readText = (file) => {
  try {
    const st = statSync(file);
    return st.isFile() && st.size <= MAX_FILE ? readFileSync(file, "utf8") : null;
  } catch { return null; }
};

// "$(cat <<'EOF' ... EOF)" a "$(cat /súbor)" nahradí ich textom, aby ho hook
// posúdil ako literál. Heredoc s neuvedeným oddeľovačom a premennou v tele,
// chýbajúci alebo nečitateľný súbor a iná substitúcia ostanú nevyhodnotené.
// Súbor sa len číta.
export function inlineSubstitutions(raw, read = readText) {
  return raw
    .replace(/"\$\(\s*cat\s+<<-?\s*(['"]?)(\w+)\1[ \t]*\n([\s\S]*?)\n[ \t]*\2[ \t]*\n?\s*\)"/g, (all, q, _d, body) => {
      if (!q && DYNAMIC.test(body)) return all;
      return quote(body.split("\n").map((l) => l.replace(/^\t+/, "")).join("\n"));
    })
    .replace(/"\$\(\s*cat\s+(?:'([^'\n]+)'|"([^"$`\n]+)"|([^\s"'$`;|&<>()\\]+))\s*\)"/g, (all, a, b, c) => {
      const text = read(a ?? b ?? c);
      return text === null ? all : quote(text);
    });
}

// Vráti dôvod zamietnutia alebo null. `read` je čítanie súboru (testy).
export function humanQuestionReason(raw, read = readText) {
  for (const { rest } of taskerCommands(inlineSubstitutions(raw, read))) {
    let flag;
    let what;
    if (rest[0] === "result" && rest.slice(1).includes("needs_human")) { flag = "summary"; what = "zhrnutie `result needs_human`"; }
    else if (rest[0] === "ask") { flag = "body"; what = "otázka `ask`"; }
    else if (rest[0] === "comment") { flag = "body"; what = "komentár `comment`"; }
    else continue;
    const text = flagValue(rest.slice(1), flag);
    if (text === undefined || DYNAMIC.test(text)) continue;
    if (rest[0] === "comment") {
      // Komentár je otázka pre človeka, keď má vetu s `?` alebo písmeno voľby. Posudzuje sa len neoverené tvrdenie.
      const claim = hasQuestion(text) || usedLetters(text).size ? unverifiedClaim(text) : null;
      if (claim) return `${what}: text pre človeka obsahuje neoverené tvrdenie "${claim.length > 80 ? `${claim.slice(0, 77)}...` : claim}". Komentár s otázkou vidí človek bez súvislostí.`;
      continue;
    }
    const why = questionProblem(text);
    if (why) return `${what}: ${why}. Človek ho uvidí bez súvislostí (web Taskera, notifikácia).`;
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  if (input.tool_name !== "Bash") process.exit(0);
  const why = humanQuestionReason(String((input.tool_input || {}).command || ""));
  if (!why) process.exit(0);
  denyTool(why, POSTUP);
}
