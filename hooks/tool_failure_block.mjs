#!/usr/bin/env node
// requires: none
// tool_failure_block.mjs — druhý pokus o nástroj, ktorý v prostredí nefunguje,
// sa zamietne (úloha 615). Dôvod pozri tool_failure_log.mjs: `gh` na serveri
// nie je, `sudo` pod rootom netreba, prepínač `curl` verzia nepozná.
//
// PreToolUse pre Bash. Zamietne, keď tvar niektorého jednoduchého príkazu
// (`lib/tool_shape.mjs`: program, podpríkaz, prepínače)
//  (a) sedí na riadok zoznamu `env/server/nastroje.tsv` (`$AR_TOOLS_KNOWN`):
//      stĺpce program, prepínače (`*` = ľubovoľné, inak zoznam, ktorý musí byť
//      podmnožinou prepínačov príkazu), používateľ (`*` alebo meno), náhrada; alebo
//  (b) v registri `tool_failure_log.mjs` je riadok s rovnakým prostredím, programom,
//      podpríkazom a prepínačmi a jeho chyba hovorí o chýbajúcom nástroji alebo
//      prepínači (`missingTool`). Chyba o práve, sieti či vstupe tvar neblokuje.
// `--version` a `--help` podliehajú tiež. Pri ťahu bez registra a zoznamu prejde všetko.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { denyTool } from "../lib/deny.mjs";
import { envKey, missingTool, shapeOf } from "../lib/tool_shape.mjs";
import { registerPath } from "./tool_failure_log.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_POSTUP =
  "použi iný nástroj alebo tvar; keď nový tvar prejde, pridaj do env/server/nastroje.tsv riadok s náhradou";

const rows = (file) => (file && existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("#")).map((l) => l.split("\t")) : []);
const label = (s) => [s.program, s.sub, ...s.flags].filter(Boolean).join(" ");

// Dôvod a postup zamietnutia alebo null.
export function blockReason(command, { env = envKey(), registerFile, knownFile } = {}) {
  const shapes = shapeOf(command).shapes;
  if (!shapes.length) return null;
  const user = env.split("@")[0];
  for (const [program, flags = "*", who = "*", fix = ""] of rows(knownFile)) {
    const need = flags.trim() === "*" ? [] : flags.split(/[\s,]+/).filter(Boolean);
    if (who !== "*" && who !== user) continue;
    for (const s of shapes) {
      if (s.program !== program || !need.every((f) => s.flags.includes(f))) continue;
      return { reason: `Príkaz \`${label(s)}\` v prostredí ${env} je v zozname nefunkčných nástrojov servera (env/server/nastroje.tsv).`, postup: fix.trim() || DEFAULT_POSTUP };
    }
  }
  for (const [, e, program, sub, flags = "", err = ""] of rows(registerFile)) {
    if (e !== env) continue;
    for (const s of shapes) {
      if (s.program !== program || s.sub !== sub || s.flags.join(" ") !== flags || !missingTool(err, program)) continue;
      return { reason: `Príkaz \`${label(s)}\` v prostredí ${env} už zlyhal (${err}).`, postup: DEFAULT_POSTUP };
    }
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = {};
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {}
  if (input.tool_name !== "Bash") process.exit(0);
  let hit = null;
  try {
    hit = blockReason(String((input.tool_input || {}).command || ""), {
      env: process.env.AR_ENV_KEY || envKey(),
      registerFile: registerPath(),
      knownFile: process.env.AR_TOOLS_KNOWN || join(HERE, "..", "env", "server", "nastroje.tsv"),
    });
  } catch {}
  if (hit) denyTool(hit.reason, hit.postup);
}
