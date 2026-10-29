#!/usr/bin/env node
// Testy výberu správ podľa témy v agent_inbox.mjs. Rovnaké mená skúša
// bin/ask_agent.sh --replies.

import { mineOf, topicOfFile } from "./agent_inbox.mjs";

const files = [
  "cyril-temy-20261019-090000-1.md",
  "cyril-prihlasenie-20261019-090000-2.md",
  "cyril-temy_x-20261019-090000-3.md",
  "boris-20261016-4.md",
  "boris-temy-20261016-5.md",
  "cyril-20261019-120954-22278.md",
  "boris-gav16-20261016-132700.md",
  // Stará Cyrilho správa pred prechodom na cyril- (DECISIONS.md 2026-10-18).
  "adam-temy-20261016-120000-6.md",
];
// Témy, ktoré Cyril pozná (zámky a memory/topics). Správa s témou mimo nich
// je správa bez témy, inak by ju neprečítala žiadna relácia (16. 10. 2026).
const known = ["temy", "prihlasenie", "temy_x"];
const cases = [
  [topicOfFile("cyril-temy-20261019-090000-1.md"), "temy"],
  [topicOfFile("adam-temy-20261016-120000-6.md"), "temy"],
  [topicOfFile("cyril-20261019-120954-22278.md"), ""],
  [topicOfFile("adam-20261016-120954-22278.md"), ""],
  [topicOfFile("smartd-20261016.md"), ""],
  [mineOf(files, "temy", known).join(" "), "cyril-temy-20261019-090000-1.md boris-20261016-4.md boris-temy-20261016-5.md cyril-20261019-120954-22278.md boris-gav16-20261016-132700.md adam-temy-20261016-120000-6.md"],
  [mineOf(files, "prihlasenie", known).includes("boris-gav16-20261016-132700.md"), true],
  [mineOf(files, "", known).length, files.length],
];
// Repo agenta z CLAUDE_PROJECT_DIR, nie repo pravidiel (replay 19. 10. 2026,
// hook hľadal témy a SSH obal v agentic-workflow).
{
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawnSync } = await import("node:child_process");
  const agent = mkdtempSync(join(tmpdir(), "inbox-agent-"));
  mkdirSync(join(agent, "memory", "topics"), { recursive: true });
  writeFileSync(join(agent, "memory", "topics", "agent_tema.md"), "x\n");
  const env = { ...process.env, CLAUDE_PROJECT_DIR: join(agent, ".worktrees", "w") };
  delete env.TOPIC_STATE_DIR;
  const code = `import("${new URL("./agent_inbox.mjs", import.meta.url).pathname}").then((m) => console.log(m.knownTopics().join(",")))`;
  const r = spawnSync("node", ["--input-type=module", "-e", code], { cwd: "/", env, encoding: "utf8" });
  cases.push([r.stdout.trim().split(",").includes("agent_tema"), true]);
  rmSync(agent, { recursive: true, force: true });
}
// Účet a schránka z prostredia, bez AGENT_INBOX_HOSTS sú adresy prázdne a schránka je /var/lib/<AGENT_NAME>/inbox.
{
  const { spawnSync } = await import("node:child_process");
  const code = `import("${new URL("./agent_inbox.mjs", import.meta.url).pathname}").then((m) => console.log(m.HOSTS.join(","), m.OUTBOX))`;
  const base = { ...process.env, CLAUDE_PROJECT_DIR: "/" };
  const r1 = spawnSync("node", ["--input-type=module", "-e", code], { cwd: "/", env: { ...base, AGENT_INBOX_HOSTS: "u@example.org,u@example.net", AGENT_INBOX_OUTBOX: "/var/lib/x/outbox" }, encoding: "utf8" });
  cases.push([r1.stdout.trim(), "u@example.org,u@example.net /var/lib/x/outbox"]);
  delete base.AGENT_INBOX_HOSTS; delete base.AGENT_INBOX_OUTBOX;
  const r2 = spawnSync("node", ["--input-type=module", "-e", code], { cwd: "/", env: { ...base, AGENT_NAME: "cyril" }, encoding: "utf8" });
  cases.push([r2.stdout.trim(), "/var/lib/cyril/inbox"]);
}
let bad = 0;
for (const [got, want] of cases) if (got !== want) { bad++; console.log(`✗ chcem ${want}, mám ${got}`); }
console.log(bad ? `${bad}/${cases.length} zlyhalo` : `${cases.length} prípadov v poriadku`);
process.exit(bad ? 1 : 0);
