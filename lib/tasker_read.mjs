// tasker_read.mjs: čítanie úloh Taskera pre hooky (reply_guard.mjs a hooky
// repa pravidiel). Len na čítanie. Server: DB Taskera cez node:sqlite
// s readOnly, ako tasker_events.mjs. Mac: Tasker tam nebeží, `GET /api/tasks`
// webu cez Tailscale (TASKER_WEB_URL). Cesta k DB je TASKER_DB, inak
// $TASKER_HOME/tasker.db, inak /home/$AGENT_TASKER_USER/.tasker/tasker.db.
// Keď DB na stroji nie je, ide sa cez web. Chyba (DB zamknutá, web
// neodpovedal) sa hodí volajúcemu, ten rozhodne, či zlyhá otvorene alebo
// zatvorene.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { hookEnv } from "./agent_env.mjs";

export const DEFAULT_WEB = "http://127.0.0.1:8801";

// Cesta k DB Taskera pre `env`, alebo null, keď ju nemá z čoho odvodiť.
export function defaultDb(env = process.env) {
  if (env.TASKER_DB) return env.TASKER_DB;
  if (env.TASKER_HOME) return join(env.TASKER_HOME, "tasker.db");
  if (env.AGENT_TASKER_USER) return join("/home", env.AGENT_TASKER_USER, ".tasker/tasker.db");
  return join(env.HOME || homedir(), ".tasker/tasker.db");
}

// Vráti pole { id, title, status, assignee, project }. `ids` zúži na dané
// úlohy, `status` na jeden stav. Bez `env` berie premenné procesu a runtime.env
// agenta (hookEnv), takže hook nemusí poznať cestu k DB ani adresu webu.
export async function fetchTasks({ ids, status, env = hookEnv(), fetchImpl = globalThis.fetch } = {}) {
  const db = defaultDb(env);
  // Výslovne zadaná DB, ktorá neexistuje, je chyba, nie dôvod siahnuť na živú
  // DB alebo web (testy ukazujú TASKER_DB na fixtúru).
  if (env.TASKER_DB && !existsSync(db)) throw new Error(`TASKER_DB ${db} neexistuje`);
  let rows;
  if (existsSync(db)) {
    // node:sqlite v Node 22 vypíše ExperimentalWarning, ten tu nič nenesie.
    const emit = process.emitWarning;
    process.emitWarning = (w, ...a) => (String(w).includes("SQLite") ? undefined : emit.call(process, w, ...a));
    const { DatabaseSync } = await import("node:sqlite");
    const d = new DatabaseSync(db, { readOnly: true });
    try {
      d.exec("PRAGMA busy_timeout=2000");
      rows = d.prepare("SELECT id, title, status, assignee, project FROM tasks").all().map((r) => ({ ...r }));
    } finally { d.close(); }
  } else {
    const base = (env.TASKER_WEB_URL || DEFAULT_WEB).replace(/\/+$/, "");
    const res = await fetchImpl(`${base}/api/tasks`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`Tasker odpovedal ${res.status}`);
    rows = (await res.json()).map((t) => ({ id: t.id, title: t.title, status: t.status, assignee: t.assignee ?? null, project: t.project ?? null }));
  }
  if (ids) rows = rows.filter((t) => ids.includes(t.id));
  if (status) rows = rows.filter((t) => t.status === status);
  return rows;
}
