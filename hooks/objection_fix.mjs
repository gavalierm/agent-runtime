#!/usr/bin/env node
// objection_fix.mjs — námietku, ktorej agent dá za pravdu, sprevádza commit
// zmeny persony, pravidla alebo kontroly (prijatá námietka mení agenta).
//
// Stop zo settings.json prostredia alebo .claude/settings.json repa. Keď
// odpoveď od poslednej správy operátora uznáva námietku a v tom istom ťahu nebežal `git commit`, odpoveď
// zastaví. Od D0142 aj odpoveď, ktorá uzná chybu a nespustila bin/chyba.sh. Pri druhom zastavení v rade (stop_hook_active) mlčí.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { blockStop } from "../lib/deny.mjs";

const AGREE = /(?<!\p{L})(máš pravdu|pravdu máš|námietku prijímam|uznávam|mal si pravdu|you'?re right|moja chyba|chyba je moja|chybu som urobil|pomýlil som sa)(?!\p{L})/iu;
// Súbory, ktoré agenta riadia. Samotná pamäť nestačí (operátor 18. 10. 2026:
// "diff z memory nestačí").
const RULES = /(PERSONA\.md|CLAUDE\.md|AGENTS\.md|hooks\/|check\.mjs|global\/|work\/|skills\/|permissions\.json|settings\.json|STRUCTURE\.md|WORKFLOW\.md)/;

// Text odpovede a príkazy Bash od poslednej skutočnej správy operátora.
export function lastTurn(transcript) {
  let text = [], cmds = [], userText = "";
  for (const line of transcript.split("\n")) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const c = e.message?.content;
    if (e.type === "user") {
      if (typeof c === "string") { text = []; cmds = []; userText = c; }
      else if (Array.isArray(c) && c.some((b) => b.type === "text")) { text = []; cmds = []; userText = c.filter((b) => b.type === "text").map((b) => b.text).join("\n"); }
    } else if (e.type === "assistant" && Array.isArray(c)) {
      for (const b of c) {
        if (b.type === "text") text.push(b.text);
        if (b.type === "tool_use" && b.name === "Bash") cmds.push(b.input?.command || "");
      }
    }
  }
  return { text: text.join("\n"), cmds, userText };
}

export const POSTUP = {
  chyba: "zmeň súbor, ktorý ťa riadi, `git commit -m \"...\" -- <súbor>`, `git push`, potom spusti `/opt/agent-rules/bin/chyba.sh --trieda <trieda chyby> --subor <ten súbor>` "
    + "(skill `chyba`) a výpis, štyri vety, vlož do odpovede.",
  commit: "zmeň súbor, ktorý ťa riadi (PERSONA.md, CLAUDE.md, hook alebo check.mjs), `git add <súbor>`, "
    + "`git commit -m \"...\" -- <súbor>`, `git push`, a v odpovedi uveď číslo commitu.",
  report: "zisti číslo commitu opravy (`git log -1 --format=%h`) a do odpovede napíš štyri krátke vety: čo si tvrdil, "
    + "čo bola pravda, ktorý súbor a commit si zmenil, čo ťa nabudúce zastaví.",
};

export function verdict({ text, cmds }) {
  if (!AGREE.test(text)) return null;
  // D0142 (úloha Taskera 426): uznaná chyba spustí skill nápravy, skript zapíše
  // triedu do registra a pri druhom výskyte založí úlohu na kontrolu.
  if (!cmds.some((c) => /(^|[\s/;&|(])chyba\.sh(\s|$)/.test(c))) {
    return "Odpoveď uznáva chybu alebo námietku, ale v tomto ťahu nebežal bin/chyba.sh, ktorý chybu zapíše do registra "
      + "a pri druhom výskyte triedy založí úlohu na kontrolu (D0142).";
  }
  // Súbory nesie `git add` alebo zoznam za `--` pri `git commit` (env/server/CLAUDE.md, Git na serveri).
  const ruleCommit = cmds.some((c) => /\bgit\b[^\n]*\bcommit\b/.test(c) && /\bgit\b[^\n]*(\badd\b|\bcommit\b[^\n]*\s--\s)/.test(c) && RULES.test(c));
  const reported = /(?<![0-9a-f])[0-9a-f]{7,40}(?![0-9a-f])/.test(text);
  if (ruleCommit && reported) return null;
  if (!ruleCommit) {
    return "Odpoveď uznáva chybu alebo námietku, ale v tomto ťahu chýba commit zmeny persony, pravidla "
      + "alebo kontroly (PERSONA.md, CLAUDE.md, hook, check.mjs, nastavenie agenta). Samotná pamäť nestačí. "
      + "Oprav súbor, ktorý ťa riadi, commitni a pushni (PERSONA.md, Vlastná chyba).";
  }
  return "Odpoveď uznáva chybu, ale chýba hlásenie s číslom commitu opravy: čo si urobil, čo bola pravda, "
    + "ktorý súbor a commit si zmenil, čo ťa nabudúce zastaví (PERSONA.md, Vlastná chyba).";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  if (input.stop_hook_active || !input.transcript_path) process.exit(0);
  let turn;
  try { turn = lastTurn(readFileSync(input.transcript_path, "utf8")); } catch { process.exit(0); }
  const reason = verdict(turn);
  if (reason) blockStop(reason, POSTUP[/bin\/chyba\.sh/.test(reason) ? "chyba" : /hlásenie s číslom commitu/.test(reason) ? "report" : "commit"]);
}
