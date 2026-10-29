#!/usr/bin/env node
// requires: none
// rules_delta.mjs: zmena pravidiel do ťahu, ktorý beží aj tak. UserPromptSubmit
// zo settings.json prostredia (tabuľka env/hooks.mjs, zapisujú ju env/server/install.sh
// a env/mac/install.sh).
// Pri každom prompte porovná HEAD nasadených klonov (workflowDir a brainGlobalDir
// v lib/paths.mjs) so stavom relácie $AR_STATE/<klon>/<session_id>. Sleduje
// RULES.md v klone kódu a RULES.md a env/<prostredie>/ v spoločnom mozgu. Keď sa HEAD líši
// a zmena je v týchto cestách, vloží do kontextu log a diff, najviac MAX_BYTES,
// a stav prepíše. Prvý prompt relácie len zapíše HEAD, pravidlá sa načítali čerstvé.
// Rozhodnutia: s AR_ROZHODNUTIA=1 (lib/agent_env.mjs, zapnute) patrí do sledovaných
// ciest spoločného mozgu aj decisions/, zmena záznamu a INDEX.md príde do
// najbližšieho ťahu. Bez prepínača sa rozhodnutia nesledujú.
// Nahrádza správu pravidla-* zo sync.sh, ktorá stála jeden ťah agenta na
// každý push (19. 10. 2026, budič budí zadávateľa len keď čaká).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { hookEnv, zapnute } from "../lib/agent_env.mjs";
import { brainGlobalDir, workflowDir } from "../lib/paths.mjs";

export const MAX_BYTES = 20_000;

function git(clone, args) {
  const r = spawnSync("git", ["-C", clone, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr || "git zlyhal").trim());
  return r.stdout;
}

// Vráti text pre kontext alebo null, stav relácie zapíše vždy. `paths` sú
// predpony ciest v klone, ktorých zmena sa hlási.
export function delta({ clone, stateDir, sessionId, paths: dirs }) {
  if (!sessionId || !/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) return null;
  const head = git(clone, ["rev-parse", "HEAD"]).trim();
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const seenPath = join(stateDir, sessionId);
  const seen = existsSync(seenPath) ? readFileSync(seenPath, "utf8").trim() : "";
  if (seen === head) return null;
  writeFileSync(seenPath, head + "\n");
  if (!seen) return null;
  const paths = ["--", ...dirs];
  let log;
  try { log = git(clone, ["log", "--format=%h %s", `${seen}..${head}`, ...paths]).trim(); } catch { return null; }
  if (!log) return null;
  const diff = git(clone, ["diff", `${seen}..${head}`, ...paths]);
  const short = (h) => h.slice(0, 7);
  let text = `[pravidlá] Zmena pravidiel ${short(seen)}..${short(head)}. Platí hneď a nahrádza znenie z načítaných pravidiel. Odpoveď sa nepíše.\n\n${log}\n\n${diff}`;
  if (Buffer.byteLength(text) > MAX_BYTES) text = text.slice(0, MAX_BYTES) + `\n[skrátené, celý diff: git -C ${clone} diff ${short(seen)}..${short(head)} -- ${dirs.join(" ")}]`;
  return text;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  const mac = process.platform === "darwin";
  const home = process.env.HOME || homedir();
  const env = hookEnv(input);
  const stateDir = process.env.AR_STATE || join(home, ".local/state/agentic-workflow/rules_seen");
  const sessionId = input.session_id || process.env.CLAUDE_CODE_SESSION_ID || "";
  const envName = env.AR_ENV || (mac ? "mac" : "server");
  const clones = [
    { name: "workflow", clone: workflowDir(env), paths: ["RULES.md"] },
    { name: "brain-global", clone: brainGlobalDir(env), paths: ["RULES.md", `env/${envName}/`, ...(zapnute(env) ? ["decisions/"] : [])] },
  ];
  const parts = [];
  for (const c of clones) {
    if (!existsSync(join(c.clone, ".git"))) continue;
    try {
      const part = delta({ clone: c.clone, stateDir: join(stateDir, c.name), sessionId, paths: c.paths });
      if (part) parts.push(part);
    } catch { /* klon bez histórie alebo bez gitu hook nezastaví */ }
  }
  const text = parts.join("\n\n");
  if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } }));
}
