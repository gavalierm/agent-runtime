#!/usr/bin/env node
// requires: t3
// clear_bridge.mjs — /clear v T3 Code prežije nový proces claude.
// SessionStart so source "clear". T3 0.1.0 si pri vlákne drží ID relácie
// z prvého štartu a každý ďalší proces spustí s --resume na ňu, /clear to
// ID nezmení a starý kontext sa vráti (test 18. 10. 2026, DECISIONS.md
// 2026-10-18, /clear v T3 cez most prepisu). Hook nájde v rodičovskom
// procese claude pôvodné ID (--resume alebo --session-id), starý prepis
// odloží ako .pred-clear-<čas>.jsonl.bak a na jeho miesto dá symbolický
// odkaz na prepis novej relácie. Ďalšie --resume tak načíta čistý kontext
// a zapisuje do novej relácie. Mimo T3 (bez týchto prepínačov) nerobí nič.
// Id všetkých relácií vlákna hook zapíše aj do `<pôvodné id>.sessions` vedľa
// prepisov (úloha 656), podľa neho tasker_work.mjs pozná vlastnú starú reláciu.
//
// Potom hook urobí štart relácie za agenta (úloha 420 v Taskeri): v
// input.cwd `git fetch origin` a pri čistom strome `git rebase origin/<vetva>`
// (nikdy pull ani stash, spolu okolo 20 s), prečíta odovzdávku od
// bin/kontext.sh (lib/kontext.mjs), zmaže ju a vloží do novej relácie ako
// additionalContext: stav, ďalší krok, výsledok fetchu a rebase. Model tak
// po /clear nečíta pamäť ani nerobí fetch, kým to práca nepotrebuje. Chyba
// kroku sa ohlási v texte a štart relácie nikdy nezastaví.

import { spawnSync } from "node:child_process";
import { readFileSync, lstatSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { kontextDir, takeHandoff } from "../lib/kontext.mjs";
import { originalId, recordChain } from "../lib/session_id.mjs";

export { originalId };

// Presmeruje prepis oldId na prepis novej relácie a zapíše reťaz relácií do
// `<oldId>.sessions` (úloha 656: po druhom /clear je predošlý prepis obyčajný
// súbor a tasker_work.mjs by vlastnú starú reláciu bral za cudziu). Vráti, čo urobil.
export function bridge(transcriptPath, oldId, now = new Date()) {
  const dir = dirname(transcriptPath);
  const newFile = basename(transcriptPath);
  if (!oldId || newFile === `${oldId}.jsonl`) return "bez zmeny";
  const oldPath = join(dir, `${oldId}.jsonl`);
  let st = null;
  try { st = lstatSync(oldPath); } catch {}
  let previous = null;
  if (st?.isSymbolicLink()) {
    try { previous = basename(readlinkSync(oldPath)).replace(/\.jsonl$/, ""); } catch {}
    unlinkSync(oldPath);
  } else if (st) renameSync(oldPath, join(dir, `${oldId}.pred-clear-${now.toISOString().replace(/[:.]/g, "-")}.jsonl.bak`));
  symlinkSync(newFile, oldPath);
  try { recordChain(dir, oldId, [previous ?? oldId, newFile.replace(/\.jsonl$/, "")].filter(Boolean)); } catch {}
  return `${oldId}.jsonl -> ${newFile}`;
}

function git(cwd, args, timeout) {
  const r = spawnSync("git", args, {
    cwd,
    timeout,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" },
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-3).join(" ").slice(0, 300);
  if (r.error) return { ok: false, out: r.error.code === "ETIMEDOUT" ? `časový limit ${timeout / 1000} s` : r.error.message };
  return { ok: r.status === 0, out };
}

// Štart relácie v repe agenta: fetch a rebase. Vráti riadok pre kontext.
export function syncRepo(cwd, { fetchMs = 12_000, rebaseMs = 8_000 } = {}) {
  if (!cwd) return "git: pracovný priečinok nie je známy, fetch a rebase preskočené.";
  const branch = git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"], 5_000);
  if (!branch.ok) return `git: ${cwd} nie je repo na vetve (${branch.out || "detached HEAD"}), fetch a rebase preskočené.`;
  const fetch = git(cwd, ["fetch", "origin"], fetchMs);
  if (!fetch.ok) return `git fetch origin zlyhal: ${fetch.out}. Rebase preskočený.`;
  const dirty = git(cwd, ["status", "--porcelain", "--untracked-files=no"], 5_000);
  if (!dirty.ok || dirty.out) return `git fetch origin prebehol. Strom nie je čistý, rebase preskočený, zmeny rieš sám.`;
  const before = git(cwd, ["rev-parse", "HEAD"], 5_000).out;
  const rebase = git(cwd, ["rebase", `origin/${branch.out}`], rebaseMs);
  if (!rebase.ok) {
    git(cwd, ["rebase", "--abort"], 5_000);
    return `git fetch origin prebehol. Rebase na origin/${branch.out} zlyhal a bol zrušený: ${rebase.out}`;
  }
  const after = git(cwd, ["rev-parse", "HEAD"], 5_000).out;
  const log = before === after ? "" : git(cwd, ["log", "--oneline", "-5", `${before}..${after}`], 5_000).out;
  return `git fetch origin a rebase na origin/${branch.out} prebehli${before === after ? ", nič nové" : `, nové commity: ${log}`}.`;
}

// Text pre additionalContext po /clear. id je pôvodné ID relácie.
export function startContext(input, id, { dir = kontextDir() } = {}) {
  let handoff = null;
  try { handoff = takeHandoff(dir, id); } catch {}
  let sync;
  try { sync = syncRepo(input.cwd || handoff?.cwd); } catch (e) { sync = `git: štart repa zlyhal: ${e.message}`; }
  const lines = ["Štart relácie po /clear je hotový. Fetch a rebase urobil hook, pamäť čítaj len keď ju práca potrebuje."];
  lines.push(sync);
  if (handoff?.stav) lines.push(`Stav z odovzdávky: ${handoff.stav}`);
  if (handoff?.dalej) lines.push(`Ďalší krok: ${handoff.dalej}`);
  if (!handoff) lines.push("Odovzdávka od kontext.sh nebola, nič nie je rozpracované.");
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  if (input.source !== "clear" || !input.transcript_path) process.exit(0);
  const id = originalId();
  if (!id) process.exit(0);
  try { bridge(input.transcript_path, id); } catch {}
  try {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: startContext(input, id) } }));
  } catch {}
}
