#!/usr/bin/env node
// guard.replay.mjs — prehrá cez guard.mjs každý Bash príkaz z prepisov
// v ~/.claude/projects a vypíše tie, ktoré hook zamietol (zápis do persony
// agenta, D0206). Slúži na hľadanie falošných zamietnutí: výpis prejdi a každý
// príkaz, ktorý personu nemení, pridaj ako prípad do guard.test.mjs.
// Spusti: node hooks/guard.replay.mjs [--dni N]   (predvolene 30 dní)

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const H = homedir();
const GUARD = join(dirname(fileURLToPath(import.meta.url)), "guard.mjs");
const ROOT = join(H, ".claude", "projects");
const i = process.argv.indexOf("--dni");
const since = Date.now() - (i > 0 ? Number(process.argv[i + 1]) : 30) * 864e5;

const seen = new Set();
let total = 0;
const hits = [];
for (const dir of readdirSync(ROOT)) {
  let files;
  try {
    files = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".jsonl"));
  } catch {
    continue;
  }
  for (const f of files) {
    const path = join(ROOT, dir, f);
    if (statSync(path).mtimeMs < since) continue;
    let start = null;
    for (const line of readFileSync(path, "utf8").split("\n")) {
      if (!line.includes('"Bash"')) {
        if (!start && line.includes('"cwd"')) {
          try {
            start = JSON.parse(line).cwd || null;
          } catch {}
        }
        continue;
      }
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue;
      }
      start ??= rec.cwd;
      const content = rec.message?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c.type !== "tool_use" || c.name !== "Bash" || !c.input?.command) continue;
        const key = `${start}\0${rec.cwd}\0${c.input.command}`;
        if (seen.has(key)) continue;
        seen.add(key);
        total++;
        const r = spawnSync("node", [GUARD], {
          input: JSON.stringify({ cwd: rec.cwd, tool_name: "Bash", tool_input: { command: c.input.command } }),
          encoding: "utf8",
          env: { ...process.env, CLAUDE_PROJECT_DIR: start },
        });
        if (!r.stdout.trim()) continue;
        const o = JSON.parse(r.stdout).hookSpecificOutput;
        hits.push({ start, decision: o.permissionDecision, reason: o.permissionDecisionReason, command: c.input.command });
      }
    }
  }
}

for (const h of hits) {
  console.log(`\n[${h.decision}] ${h.start.replace(H, "~")}\n  ${h.reason}\n  ${h.command.replace(/\n/g, "\n  ").slice(0, 600)}`);
}
console.log(`\n${total} príkazov, ${hits.length} zamietnutých`);
