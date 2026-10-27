#!/usr/bin/env node
// done_related.mjs — po zavretí úlohy nesmie v tom istom projekte ostať
// otázka pre človeka (needs_human) toho istého riešiteľa bez jeho komentára
// v tom ťahu. Dňa 27. 10. 2026: audit 612 (projekt agenti) prepracoval celý
// postup, úloha 609 s otázkou pre operátora ostala v needs_human a operátor sa
// pýtal, či je ešte relevantná. Zrušiť ju mal agent pri zatváraní 612.
//
// Stop z settings.json prostredia. Nájde úlohy riešiteľa (agentName) so stavom
// done a updated_at od poslednej správy operátora (zavreté v tomto ťahu), k nim
// úlohy needs_human toho istého riešiteľa v tom istom projekte bez jeho
// komentára od začiatku ťahu, a ťah zastaví s postupom: zruš s dôvodom, alebo
// napíš, prečo otázka ostáva. Tasker číta len na čítanie (node:sqlite readOnly),
// DB je TASKER_DB, inak defaultDb (lib/tasker_read.mjs); výslovne zadaná DB,
// ktorá neexistuje, hook mlčky pustí. Pri druhom zastavení (stop_hook_active) mlčí.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { blockStop } from "../lib/deny.mjs";
import { defaultDb } from "../lib/tasker_read.mjs";
import { agentName } from "../lib/agent_name.mjs";
import { hookEnv, rulesRepo } from "../lib/agent_env.mjs";
import { turnStart } from "./todo_after_comment.mjs";

// Úlohy needs_human riešiteľa `user` v projekte úlohy, ktorú `user` zavrel
// (done, updated_at >= sinceMs), bez komentára `user`-a od sinceMs.
// Vráti [{ id, title, project, closed }] (closed = id zavretej úlohy).
export async function staleQuestions({ db, user, sinceMs }) {
  const emit = process.emitWarning;
  process.emitWarning = (w, ...a) => (String(w).includes("SQLite") ? undefined : emit.call(process, w, ...a));
  const { DatabaseSync } = await import("node:sqlite");
  const d = new DatabaseSync(db, { readOnly: true });
  try {
    d.exec("PRAGMA busy_timeout=2000");
    return d.prepare(
      `SELECT q.id, q.title, q.project, MIN(t.id) AS closed FROM tasks t
         JOIN tasks q ON q.project = t.project AND q.id <> t.id
        WHERE t.status = 'done' AND t.assignee = ? AND t.updated_at >= ? AND t.project IS NOT NULL
          AND q.status = 'needs_human' AND q.assignee = ?
          AND NOT EXISTS (SELECT 1 FROM comments c WHERE c.task_id = q.id AND c.author = ? AND c.created_at >= ?)
        GROUP BY q.id ORDER BY q.id`,
    ).all(user, sinceMs, user, user, sinceMs).map((r) => ({ ...r }));
  } finally { d.close(); }
}

export const POSTUP = (rows, rules = rulesRepo()) =>
  `pre každú (${rows.map((r) => r.id).join(", ")}) jedno z: otázku zavretá úloha prekonala, `
  + "`tasker cancel <id>` a komentár s dôvodom a číslom zavretej úlohy; otázka platí ďalej, komentár, prečo ju "
  + `výsledok zavretej úlohy nemení. Tasker spúšťaj cez \`${rules}/bin/tk ...\` (namiesto \`tasker ...\`).`;

export function reason(rows) {
  return "V tomto ťahu si zavrel úlohu a v jej projekte stojí tvoja otázka pre človeka (needs_human) bez tvojho komentára, "
    + "operátor nevie, či ju výsledok prekonal (27. 10. 2026 úloha 609 po audite 612): "
    + rows.map((r) => `${r.id} (${r.title}; projekt ${r.project}, zavretá ${r.closed})`).join("; ") + ".";
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
    rows = await staleQuestions({ db, user, sinceMs });
  } catch { process.exit(0); }
  if (rows.length) blockStop(reason(rows), POSTUP(rows, rulesRepo(henv)));
}
