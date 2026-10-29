#!/usr/bin/env node
// memory_claims.mjs: kontrola K4 návrhu úlohy 390. Pamäť agenta nesie stav
// práce a odkazy, nie rozhodnutia ani otázky na operátora. Riadok pamäte
// zastaví, keď
//   - tvrdí, že niečo čaká alebo je otvorené na operátora
//     (`(čaká|otvoren\w*) (na|pre|u) <operátora>`, meno z AGENT_OPERATOR_NAME
//     v genitíve), a nemá `úloha <číslo>`,
//   - spomína `rozhodol` alebo `rozhodnutie` a nemá číslo záznamu `D0000`.
// Stav "čaká na operátora" drží Tasker (úloha v needs_human), rozhodnutie
// decisions/D*.md. Používa ju check.mjs nad memory/ agentov (len s
// AR_ROZHODNUTIA=1) a ručne:
//   node lib/memory_claims.mjs <súbor.md>...   kód 0 čisté, 1 nálezy na stdout
// Ručné spustenie beží vždy, bez ohľadu na prepínač.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { operatorForms } from "./agent_env.mjs";

const caka = (env = process.env) => new RegExp(`(čaká|otvoren\\p{L}*)\\s+(na|pre|u)\\s+(operátora|${operatorForms(env).gen.replace(/[^\p{L}\p{N}_-]/gu, "")})`, "iu");
const ULOHA = /úloh\p{L}*\s+#?\d+/iu;
const ROZHODNUTIE = /rozhodol|rozhodnutie/i;
const ZAZNAM = /D\d{4}/;

// Nálezy v texte pamäte: [{ riadok, text, dovod }].
export function memoryProblems(text, env = process.env) {
  const out = [];
  const CAKA = caka(env);
  text.split("\n").forEach((l, i) => {
    if (CAKA.test(l) && !ULOHA.test(l)) out.push({ riadok: i + 1, text: l.trim(), dovod: 'čaká alebo je otvorené na operátora bez "úloha <číslo>", stav drží Tasker' });
    if (ROZHODNUTIE.test(l) && !ZAZNAM.test(l)) out.push({ riadok: i + 1, text: l.trim(), dovod: "rozhodnutie bez čísla záznamu D0000, rozhodnutia sú v decisions/" });
  });
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let bad = 0;
  for (const f of process.argv.slice(2)) {
    for (const p of memoryProblems(readFileSync(f, "utf8"))) { bad++; console.log(`${f}:${p.riadok}: ${p.dovod}: ${p.text.slice(0, 100)}`); }
  }
  process.exit(bad ? 1 : 0);
}
