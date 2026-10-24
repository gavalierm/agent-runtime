#!/usr/bin/env node
// rules_delta.mjs: zmena pravidiel do ťahu, ktorý beží aj tak. UserPromptSubmit
// zo settings.json prostredia (env/server/install.sh, env/mac/settings.json).
// Pri každom prompte porovná HEAD nasadeného klonu repa pravidiel (rulesRepo
// v lib/agent_env.mjs: AR_CLONE, AGENT_RULES_REPO, inak server /opt/agent-rules,
// Mac ~/Work/agent-rules) so stavom relácie
// $AR_STATE/<session_id>. Keď sa líši a zmena je v global/ alebo
// env/<prostredie>/, vloží do kontextu log a diff, najviac MAX_BYTES, a stav
// prepíše. Prvý prompt relácie len zapíše HEAD, CLAUDE.md sa načítal čerstvý.
// Rozhodnutia: s AR_ROZHODNUTIA=1 (lib/agent_env.mjs, zapnute, zapne U5) patrí
// do sledovaných ciest aj rozhodnutia/, zmena záznamu a INDEX.md príde do
// najbližšieho ťahu (návrh úlohy 390, časť 4.2). Bez prepínača sa nemení nič.
// Nahrádza správu pravidla-* zo sync.sh, ktorá stála jeden ťah agenta na
// každý push (19. 10. 2026, budič budí zadávateľa len keď čaká).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { hookEnv, rulesRepo, zapnute } from "../lib/agent_env.mjs";

export const MAX_BYTES = 20_000;

function git(clone, args) {
  const r = spawnSync("git", ["-C", clone, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error((r.stderr || "git zlyhal").trim());
  return r.stdout;
}

// Vráti text pre kontext alebo null, stav relácie zapíše vždy.
export function delta({ clone, stateDir, sessionId, envName, rozhodnutia = zapnute() }) {
  if (!sessionId || !/^[A-Za-z0-9_-]{1,80}$/.test(sessionId)) return null;
  const head = git(clone, ["rev-parse", "HEAD"]).trim();
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const seenPath = join(stateDir, sessionId);
  const seen = existsSync(seenPath) ? readFileSync(seenPath, "utf8").trim() : "";
  if (seen === head) return null;
  writeFileSync(seenPath, head + "\n");
  if (!seen) return null;
  const dirs = ["global/", `env/${envName}/`, ...(rozhodnutia ? ["rozhodnutia/"] : [])];
  const paths = ["--", ...dirs];
  let log;
  try { log = git(clone, ["log", "--format=%h %s", `${seen}..${head}`, ...paths]).trim(); } catch { return null; }
  if (!log) return null;
  const diff = git(clone, ["diff", `${seen}..${head}`, ...paths]);
  const short = (h) => h.slice(0, 7);
  let text = `[pravidlá] Zmena pravidiel ${short(seen)}..${short(head)}. Platí hneď a nahrádza znenie z načítaného CLAUDE.md. Odpoveď sa nepíše.\n\n${log}\n\n${diff}`;
  if (Buffer.byteLength(text) > MAX_BYTES) text = text.slice(0, MAX_BYTES) + `\n[skrátené, celý diff: git -C ${clone} diff ${short(seen)}..${short(head)} -- ${dirs.join(" ")}]`;
  return text;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  const mac = process.platform === "darwin";
  const home = process.env.HOME || homedir();
  const env = hookEnv(input);
  const clone = rulesRepo(env);
  const stateDir = process.env.AR_STATE || join(home, ".local/state/agent-rules/rules_seen");
  const sessionId = input.session_id || process.env.CLAUDE_CODE_SESSION_ID || "";
  let text = null;
  try { text = delta({ clone, stateDir, sessionId, envName: env.AR_ENV || (mac ? "mac" : "server"), rozhodnutia: zapnute(env) }); } catch { process.exit(0); }
  if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } }));
}
