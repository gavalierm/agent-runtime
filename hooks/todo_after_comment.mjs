#!/usr/bin/env node
// requires: tasker
// todo_after_comment.mjs — úloha agenta, na ktorej napísal komentár, nesmie
// ostať v poradí (stav queued, scheduled, handoff alebo unassigned, kedysi todo; úloha Taskera 425). Dňa 23. 10. 2026 dvakrát: úloha 390
// (podmienka hotového splnená) a 420 (nasadená, čaká na skúšku) ostali v poradí po
// komentári agenta, operátor sa pýtal, prečo stoja.
//
// Stop z settings.json prostredia. Nájde úlohy, ktorých riešiteľ je
// TASKER_USER, v poradí (stavy z READY), s komentárom TASKER_USER od poslednej správy
// operátora (čas z prepisu relácie), a ťah zastaví s postupom. Tasker číta
// len na čítanie (node:sqlite readOnly). DB je TASKER_DB, inak defaultDb (lib/tasker_read.mjs);
// výslovne zadaná DB, ktorá neexistuje, hook mlčky pustí (testy nikdy
// nesiahnu na živú). Pri druhom zastavení v rade (stop_hook_active) mlčí.
// Meno agenta je TASKER_USER, AGENT_NAME alebo persona projektu (lib/agent_name.mjs), bez neho mlčí.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { blockStop } from "../lib/deny.mjs";
import { defaultDb } from "../lib/tasker_read.mjs";
import { agentName } from "../lib/agent_name.mjs";
import { hookEnv } from "../lib/agent_env.mjs";
import { workflowDir } from "../lib/paths.mjs";

// Čas poslednej skutočnej správy operátora (ms), alebo null.
export function turnStart(transcript) {
  let ts = null;
  for (const line of transcript.split("\n")) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const c = e.message?.content;
    if (e.type === "user" && (typeof c === "string" || (Array.isArray(c) && c.some((b) => b.type === "text")))) {
      const t = Date.parse(e.timestamp);
      if (!Number.isNaN(t)) ts = t;
    }
  }
  return ts;
}

// Úlohy v poradí (READY), riešiteľ = user, komentár od user-a s created_at >= sinceMs.
export async function todoWithComment({ db, user, sinceMs }) {
  const emit = process.emitWarning;
  process.emitWarning = (w, ...a) => (String(w).includes("SQLite") ? undefined : emit.call(process, w, ...a));
  const { DatabaseSync } = await import("node:sqlite");
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    d.exec("PRAGMA busy_timeout=2000");
    return d.prepare(
      `SELECT t.id, t.title FROM tasks t WHERE t.status IN ('queued', 'scheduled', 'handoff', 'unassigned') AND t.assignee = ?
         AND EXISTS (SELECT 1 FROM comments c WHERE c.task_id = t.id AND c.author = ? AND c.created_at >= ?)
       ORDER BY t.id`,
    ).all(user, user, sinceMs).map((r) => ({ ...r }));
  } finally { d.close(); }
}

export const POSTUP = (ids, workflow = workflowDir()) =>
  `pre každú úlohu (${ids.join(", ")}) jedno z: hotová je \`tasker done <id> --summary "..."\`, čaká na udalosť mimo Taskera `
  + "`tasker wait <id> --reason \"na čo\" --until <čas>`, čaká na inú úlohu `tasker block <id> --by <id> --reason \"na čom stojí\"`, "
  + `čaká na človeka otázka v komentári a \`tasker result needs_human\`. Tasker spúšťaj cez \`${workflow}/bin/tk ...\` `
  + "(namiesto `tasker ...`).";

export function reason(rows) {
  return "Na týchto úlohách si v tomto ťahu napísal komentár a ostali v poradí (queued, scheduled, handoff alebo unassigned), nikto ich neotvorí a vyzerajú ako stojace: "
    + rows.map((r) => `${r.id} (${r.title})`).join("; ") + ".";
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const env = process.env;
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8")); } catch {}
  const user = agentName(input, env);
  if (input.stop_hook_active || !input.transcript_path || !user) process.exit(0);
  const henv = hookEnv(input, env);
  const db = defaultDb(henv);
  if (!existsSync(db)) process.exit(0);
  let rows;
  try {
    const sinceMs = turnStart(readFileSync(input.transcript_path, "utf8"));
    if (sinceMs == null) process.exit(0);
    rows = await todoWithComment({ db, user, sinceMs });
  } catch { process.exit(0); }
  if (rows.length) blockStop(reason(rows), POSTUP(rows.map((r) => r.id), workflowDir(henv)));
}
