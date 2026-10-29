#!/usr/bin/env node
// plugin_skills_user_only.mjs: každý skill zapnutého pluginu dostane do
// frontmatter `disable-model-invocation: true`. Model ho potom v zozname nevidí
// a nevolá, operátor ho spustí cez /plugin:meno. Rozhodnutie operátora
// 2026-09-21, DECISIONS.md. Výnimkou sú pluginy z MODEL_PLUGINS
// v lib/plugins.mjs, ich skillom skript príznak odoberie, rozhodnutie
// 2026-10-14.
//
// Píše do ~/.claude/plugins/cache. Aktualizácia pluginu príznak zmaže, preto
// check.mjs hlási každý pluginový skill bez príznaku a install.sh tento skript
// spúšťa pred kontrolou. Idempotentné.
//
//   node lib/plugin_skills_user_only.mjs   doplní príznak, vypíše zmeny

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { MODEL_PLUGINS, pluginRoots, skillDirs, userOnly } from "./plugins.mjs";

// Zapnuté pluginy sú v živom ~/.claude/settings.json (kľúče mimo hookov patria
// stroju a spoločnému mozgu, env/mac/install.sh ich doplní zo settings.base.json).
const file0 = join(process.env.HOME || homedir(), ".claude", "settings.json");
const settings = existsSync(file0) ? JSON.parse(readFileSync(file0, "utf8")) : {};

let total = 0;
let changed = 0;
for (const { key, root } of pluginRoots(settings)) {
  if (!root) continue;
  for (const dir of skillDirs(join(root, "skills"), 3)) {
    total++;
    const file = join(dir, "SKILL.md");
    if (MODEL_PLUGINS.has(key)) {
      if (!userOnly(dir)) continue;
      const src = readFileSync(file, "utf8");
      writeFileSync(file, src.replace(/^disable-model-invocation:\s*true\r?\n/m, ""));
      changed++;
      console.log(`príznak odobratý: ${key} ${basename(dir)}`);
      continue;
    }
    if (userOnly(dir)) continue;
    const src = readFileSync(file, "utf8");
    const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    if (!m) {
      console.log(`bez frontmatter, preskočené: ${file}`);
      continue;
    }
    const body = /^disable-model-invocation:/m.test(m[1])
      ? m[1].replace(/^disable-model-invocation:.*$/m, "disable-model-invocation: true")
      : `${m[1]}\ndisable-model-invocation: true`;
    writeFileSync(file, src.replace(m[0], `---\n${body}\n---\n`));
    changed++;
    console.log(`príznak pridaný: ${key} ${basename(dir)}`);
  }
}
console.log(`pluginové skilly: ${total}, upravené: ${changed}`);
