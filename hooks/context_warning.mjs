#!/usr/bin/env node
// requires: none
// context_warning.mjs — pokyn na čistý kontext pri hranici 80 tisíc
// tokenov (DECISIONS.md 2026-10-19, "spotreba predplatného", predtým
// 140 tisíc podľa DECISIONS.md 2026-10-14). UserPromptSubmit z .claude/settings.json repa.
// Vo vlákne T3 (premenná T3CODE_HOME) agent po hotovom logickom celku
// uloží prácu a ukončí odpoveď riadkom z bin/kontext.sh (HOTOVO-KONTEXT
// spanok|pokracuj <kľúč>), budič potom pošle /clear sám (rozhodnutie
// z 18. 10. 2026, čistý kontext na slovo agenta, úloha 420: po spanku sa model
// nevolá, po pokracuj dostane len ďalší krok). Mimo T3 o ňom rozhoduje
// operátor.
// Číta prepis relácie a sčíta vstupné tokeny poslednej odpovede modelu.
// Nad hranicou pridá do kontextu pokyn, pod ňou mlčí. Oznámenie ide na
// prvý riadok odpovede a prácu nebrzdí (rozhodnutie z 15. 10. 2026).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { operatorForms } from "../lib/agent_env.mjs";
import { workflowDir } from "../lib/paths.mjs";

const WARN = 80_000;
const OP = operatorForms();
const KONTEXT = join(workflowDir(), "bin", "kontext.sh");

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {}
if (!input.transcript_path) process.exit(0);

let used = 0;
try {
  for (const line of readFileSync(input.transcript_path, "utf8").split("\n")) {
    if (!line.includes('"usage"')) continue;
    try {
      const u = JSON.parse(line).message?.usage;
      if (u) used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    } catch {}
  }
} catch {
  process.exit(0);
}
if (used < WARN) process.exit(0);

const k = Math.round(used / 1000);
const t3 = `Kontext relácie má ${k} tisíc tokenov, hranica je ${WARN / 1000} tisíc. Prácu kvôli tomu nekráť a odpoveď nezadrž. Čistý kontext spusti, až keď je logický celok práce hotový a ďalšia práca predošlý kontext nepotrebuje, uprostred úlohy nie. Vtedy zapíš stav do pamäte vrátane otvorenej otázky na ${OP.gen}, commitni, pushni, spusti ${KONTEXT} spanok --stav "<súhrn>" a jeho výstup daj ako samostatný posledný riadok odpovede, budič po ňom pošle /clear a model sa nevolá. Ak ďalší krok nečaká na nikoho, použi pokracuj --dalej "<ďalší krok>", budič po /clear pošle len ten krok. Kým zápis nie je v gite, riadok nepíš.`;
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: process.env.T3CODE_HOME ? t3 : `Kontext relácie má ${Math.round(used / 1000)} tisíc tokenov, hranica je ${WARN / 1000} tisíc. Zapíš rozpracované do pamäte a commitni. Odpoveď začni samostatným riadkom "Kontext: ${Math.round(used / 1000)} tisíc tokenov, čistý kontext je na tebe." Prácu kvôli kontextu nekráť, neodkladaj a odpoveď nezadrž, o čistom kontexte rozhoduje ${OP.nom} (PERSONA.md, Kontinuita).`,
    },
  }),
);
