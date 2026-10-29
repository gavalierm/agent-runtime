#!/usr/bin/env node
// requires: mac
// project_data.mjs — dáta a repo projektu nejdú do .scratch agenta.
// Chyba sa stala dvakrát: 16. 10. 2026 klon webu Kubo Rancher do
// .scratch/kubo/web, 17. 10. 2026 záloha starého webu klienta
// z ~/Desktop rozbalená do .scratch/zaloha_webu (memory/project-copy-in-canon.md).
//
// PreToolUse Bash z .claude/settings.json repa. Zamietne klon repa do
// .scratch a kopírovanie, presun alebo rozbalenie súboru z ~/Desktop
// alebo ~/Downloads do .scratch.

import { fileURLToPath } from "node:url";
import { exitDeny } from "../lib/deny.mjs";

const SCRATCH = /(^|[\s"'=/])\.scratch\//;
const CLONE = /\b(git\s+clone|gh\s+repo\s+clone)\b/;
const COPY = /\b(cp|mv|rsync|unzip|tar|ditto)\b/;
const INBOX = /(~|\$HOME|\/Users\/[^/\s]+)\/(Desktop|Downloads)\//;

export const POSTUP =
  "súbory a klon projektu ulož do priečinka projektu (mimo .scratch), alebo ich odovzdaj agentovi projektu " +
  "skriptom `bin/ask_agent.sh <agent> <téma>`.";

export function verdict(cmd) {
  for (const seg of cmd.split(/&&|\|\||;|\n/)) {
    if (!SCRATCH.test(seg)) continue;
    if (CLONE.test(seg) || (COPY.test(seg) && INBOX.test(seg)))
      return "Dáta a repo projektu patria do priečinka projektu, nie do .scratch agenta. Projektové súbory odovzdaj "
        + "agentovi projektu alebo ich daj do repa projektu (memory/project-copy-in-canon.md).";
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let input = "";
  process.stdin.on("data", (c) => (input += c)).on("end", () => {
    let e; try { e = JSON.parse(input); } catch { process.exit(0); }
    if (e.tool_name !== "Bash") process.exit(0);
    const v = verdict(e.tool_input?.command || "");
    if (v) exitDeny(v, POSTUP);
  });
}
