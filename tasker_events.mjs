#!/usr/bin/env node
// Udalosti Taskera do schránky agenta. Číta tabuľku events v tasker.db
// len na čítanie a každý prechod úlohy do needs_human alebo
// failed zapíše ako správu tasker-<čas>.md do $AGENT_BOX/inbox s prvým
// riadkom `odpoveď: čakám` (budí). Prechod do done úlohy, ktorú založil
// agent sám (udalosť created s actor human:<meno>), ide ako
// `odpoveď: na vedomie`, budič ju drží do najbližšieho ťahu a agent hotovú
// prácu overí bez ťahu navyše. Posledné spracované id udalosti je
// v $AGENT_STATE/tasker_events_last_id.
//
// Správa na úlohu s projektom, ktorého meno je v zozname tém
// (topics.json, route.mjs), ide ako tasker-<téma>-<čas>.md a budič ju
// doručí do vlákna témy (driver.mjs, target). Úloha bez projektu alebo
// projekt bez témy ide do hlavného vlákna. Dávka ide vždy do hlavného.
//
// Tiché udalosti (tasker --quiet, quiet=1) obe cesty preskočia. Dávka viac ako
// BURST prechodov v jednom behu (import, hromadná zmena) ide ako jedna správa,
// nie ako správa na úlohu. Rátajú sa len prechody, ktoré by sa naozaj poslali
// (done, ktoré agent zavrel sám, nie). Dávka je `čakám`, keď v nej je
// needs_human alebo failed, inak `na vedomie`.
//
// Prvý beh bez stavu začne od najnovšej udalosti a staré prechody
// nepošle, aktuálny stav nesie ranný súhrn. Stav sa zapíše až po zápise
// správy: pád medzi nimi pošle správu druhý raz, nikdy ju nestratí.
//
// Most: úlohu pridelenú agentovi zo zoznamu TASKER_EXTERNAL_AGENTS
// (mená oddelené ":", agent vo vlákne T3 s enabled=0 v Taskeri) pošle
// ako správu tasker-<čas>.md s riadkom `odpoveď: nečakám` (budí, výsledok
// je stav úlohy) do /var/lib/<agent>/inbox. Spúšťa ju
// založenie, pridelenie a návrat do todo (reopen, odblokovanie, koniec
// čakania waiting okrem tasker resume samotného agenta, nie koniec
// ohlásenej práce in_progress -> todo), keď je
// úloha v todo, a komentár iného autora, keď úloha nie je koncová. Správa
// mosta dostane tému podľa projektu zo zoznamu tém schránky agenta. Agenta
// s enabled=1 v tabuľke agents most preskočí (spúšťa ho dispečer).
// Úlohu, ktorú nikto nezobudí, pošle most vlastníkovi (cfg.box): úloha
// vypnutého agenta bez mosta a komentár človeka (nie vlastníka ani
// riešiteľa) na koncovej úlohe alebo úlohe bez riešiteľa. Úloha bez riešiteľa,
// ktorú Tasker sám presunul blocked -> todo (actor tasker, všetky blokéry
// hotové), ide jej zakladateľovi, ak je to agent s mostom (creator
// human:<agent>, enabled nie 1), ako `nečakám`. Kurzor mosta je
// $AGENT_STATE/tasker_bridge_last_id. Rozhodnutie v DECISIONS.md
// repa agent-rules, 2026-10-19 "most z Taskera do schránky agenta".
//
// Použitie: tasker_events.mjs [--once]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { config, ensureDir, log, writeInbox } from "./lib.mjs";
import { readTopics, topicsPath, TOPIC_RE } from "./route.mjs";

const NAME = "agent-tasker-events";
// Obal Taskera pre agenta pod rootom (agent-rules bin/tk, úloha 462).
const TK = "/opt/agent-rules/bin/tk";

async function openDb(path) {
  // node:sqlite v Node 22 vypíše ExperimentalWarning, ten tu nič nenesie.
  const emit = process.emitWarning;
  process.emitWarning = (w, ...a) => (String(w).includes("SQLite") ? undefined : emit.call(process, w, ...a));
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec("PRAGMA busy_timeout=5000");
  return db;
}

// Adresa webu Taskera (premenná TASKER_WEB_URL, napríklad cez Tailscale).
// Každá zmienka úlohy je odkaz, správy mosta ho nesú sami. Bez premennej
// platí lokálna adresa. Prvý riadok správy sa nemení, driver.mjs ho parsuje regexom.
export const TASKER_WEB_URL = "http://127.0.0.1:8801";
export const taskLink = (id, env = process.env) =>
  `Odkaz: ${(env.TASKER_WEB_URL || TASKER_WEB_URL).replace(/\/+$/, "")}/tasks/${id}`;

export function render(ev, summary) {
  if (ev.to_status === "done") {
    return [
      `Tasker: úloha #${ev.task_id}, ktorú si založil, je hotová (${ev.from_status ?? "?"} -> done).`,
      taskLink(ev.task_id),
      `Názov: ${ev.title ?? "?"}`,
      ...(ev.project ? [`Projekt: ${ev.project}`] : []),
      `Riešiteľ: ${ev.assignee ?? "nikto"}, uzavrel: ${ev.actor}, čas: ${new Date(ev.at).toISOString()}`,
      ...(ev.detail ? [`Zhrnutie: ${ev.detail}`] : []),
      "",
      `Over výsledok: tasker task show ${ev.task_id} --json`,
    ].join("\n");
  }
  const what = ev.to_status === "failed" ? "zlyhala, vyčerpala pokusy" : "čaká na človeka";
  const lines = [
    `Tasker: úloha #${ev.task_id} ${what} (${ev.from_status ?? "?"} -> ${ev.to_status}).`,
    taskLink(ev.task_id),
    `Názov: ${ev.title ?? "?"}`,
    ...(ev.project ? [`Projekt: ${ev.project}`] : []),
    `Riešiteľ: ${ev.assignee ?? "nikto"}, zmenil: ${ev.actor}, čas: ${new Date(ev.at).toISOString()}`,
  ];
  if (ev.detail) lines.push(`Detail: ${ev.detail}`);
  if (summary) lines.push("", "Zhrnutie posledného behu:", summary.slice(0, 2000));
  lines.push("", `Podrobnosti: tasker task show ${ev.task_id} --json`);
  return lines.join("\n");
}

export const BURST = 5;

// Téma správy: najprv téma, ktorej pole `tasks` obsahuje úlohu alebo jej predka
// (reťaz parent_id, najviac 20 krokov, cyklus sa preruší), potom projekt úlohy,
// ak je v zozname tém, inak null (hlavné vlákno).
export function topicFor(cfg, project, taskId = null, db = null) {
  if (!cfg.box) return null;
  try {
    const path = topicsPath(cfg);
    const topics = existsSync(path) ? readTopics(path) : {};
    if (taskId != null && db) {
      const withTasks = Object.entries(topics).filter(([, v]) => Array.isArray(v?.tasks) && v.tasks.length);
      if (withTasks.length) {
        const parent = db.prepare("SELECT parent_id FROM tasks WHERE id = ?");
        const seen = new Set();
        let id = Number(taskId);
        for (let i = 0; i < 20 && id && !seen.has(id); i++) {
          seen.add(id);
          const hit = withTasks.find(([k, v]) => TOPIC_RE.test(k) && v.tasks.map(Number).includes(id));
          if (hit) return hit[0];
          id = Number(parent.get(id)?.parent_id) || 0;
        }
      }
    }
    return project && TOPIC_RE.test(project) && topics[project] ? project : null;
  } catch { return null; }
}

export function renderBurst(rows) {
  const by = {};
  for (const ev of rows) (by[ev.to_status] ??= []).push(ev.task_id);
  return [
    `Tasker: ${rows.length} prechodov úloh naraz, vyzerá to ako import alebo hromadná zmena. Jednotlivo ich neposielam.`,
    ...Object.entries(by).map(([st, ids]) => `${st}: ${ids.length} (#${ids.slice(0, 20).join(", #")}${ids.length > 20 ? ", ..." : ""})`),
    "",
    "Stav: tasker task list",
  ].join("\n");
}

export async function tick(cfg) {
  ensureDir(cfg.state);
  const statePath = join(cfg.state, "tasker_events_last_id");
  if (!existsSync(cfg.taskerDb)) return { written: 0, reason: `chýba ${cfg.taskerDb}` };
  const db = await openDb(cfg.taskerDb);
  try {
    const max = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM events").get().m;
    if (!existsSync(statePath)) {
      writeFileSync(statePath, `${max}\n`);
      return { written: 0, reason: `začínam od udalosti ${max}` };
    }
    const last = Number(readFileSync(statePath, "utf8").trim()) || 0;
    const me = `human:${cfg.name ?? "agent"}`;
    const rows = db.prepare(`
      SELECT e.id, e.task_id, e.at, e.actor, e.from_status, e.to_status, e.detail, t.title, t.assignee, t.project,
        (SELECT c.actor FROM events c WHERE c.task_id = e.task_id AND c.kind = 'created' ORDER BY c.id LIMIT 1) AS creator
      FROM events e LEFT JOIN tasks t ON t.id = e.task_id
      WHERE e.id > ? AND e.quiet = 0 AND e.kind = 'status' AND e.to_status IN ('needs_human', 'failed', 'done')
      ORDER BY e.id`).all(last);
    const lastRun = db.prepare("SELECT agent_summary FROM runs WHERE task_id = ? ORDER BY id DESC LIMIT 1");
    const names = [];
    // Úlohu zavrel agent sám, výsledok pozná, správa by len zobudila vlákno
    // témy na nič (22. 10. 2026, úloha 353). Do dávky sa také done nerátajú.
    // Otázku, ktorú položil vlastník mostu sám (tasker ask: needs_human s detailom
    // `ask` a actor human:<vlastník>), správa nebudí, otázku pozná. Otázka iného
    // agenta ide ďalej ako čakám.
    const sendable = rows.filter((ev) => ev.to_status === "done"
      ? ev.creator === me && ev.actor !== me
      : !(ev.to_status === "needs_human" && ev.detail === "ask" && ev.actor === me));
    if (sendable.length > BURST) {
      // Dávka (import, hromadná zmena): jedna správa, nie správa na úlohu.
      // Budí (čakám), keď v nej je needs_human alebo failed, inak na vedomie.
      const wake = sendable.some((ev) => ev.to_status !== "done");
      names.push(writeInbox(cfg.box, "tasker", renderBurst(sendable), null, wake ? "čakám" : "na vedomie"));
      writeFileSync(statePath, `${max}\n`);
      return { written: names.length, names };
    }
    for (const ev of sendable) {
      if (ev.to_status === "done") {
        names.push(writeInbox(cfg.box, "tasker", render(ev), topicFor(cfg, ev.project, ev.task_id, db), "na vedomie"));
      } else {
        names.push(writeInbox(cfg.box, "tasker", render(ev, lastRun.get(ev.task_id)?.agent_summary), topicFor(cfg, ev.project, ev.task_id, db), "čakám"));
      }
      writeFileSync(statePath, `${ev.id}\n`);
    }
    if (max > last) writeFileSync(statePath, `${max}\n`);
    return { written: names.length, names };
  } finally {
    db.close();
  }
}

const TERMINAL = new Set(["done", "cancelled", "failed"]);

// Vlastník mostu (TASKER_SELF, predvolene AGENT_NAME) je v zozname vždy: komentár
// operátora na jeho úlohe ho musí zobudiť. Chyba 23. 10. 2026: "schvaľujem"
// na úlohe 376 nedošlo, zoznam mal len jedného agenta.
export function externalAgents(env = process.env) {
  const names = (env.TASKER_EXTERNAL_AGENTS || "").split(":").filter(Boolean);
  const self = env.TASKER_SELF ?? env.AGENT_NAME ?? "agent";
  if (self && !names.includes(self)) names.push(self);
  return names
    .map((name) => ({ name, box: env[`TASKER_BOX_${name}`] || `/var/lib/${name}` }));
}

// Beží na úlohe ohlásená práca (tabuľka work: ended_at prázdne, until v budúcnosti)?
// Bez tabuľky (staré testy) nie.
export function liveWork(db, taskId, now = Date.now()) {
  try {
    return Boolean(db.prepare("SELECT 1 FROM work WHERE task_id = ? AND ended_at IS NULL AND until > ? LIMIT 1").get(taskId, now));
  } catch { return false; }
}

// opts.liveWork: na úlohe beží ohlásená práca, prechod do todo nikoho nezobudí.
export function bridgeTrigger(ev, agent, opts = {}) {
  if (ev.assignee !== agent) return null;
  if (ev.kind === "comment") {
    if (ev.actor === `human:${agent}` || TERMINAL.has(ev.status)) return null;
    return "comment";
  }
  if (ev.status !== "todo") return null;
  // Úloha, ktorú agent založil alebo pridelil sám sebe, ho nebudí.
  if ((ev.kind === "created" || ev.kind === "assigned") && ev.actor === `human:${agent}`) return null;
  if (ev.kind === "created") return "created";
  // Prechod do todo, ktorý spravil sám agent (jeho komentár vráti needs_human
  // do todo), ho nebudí, a ani keď na úlohe už beží práca. Chyba 24. 10. 2026:
  // úloha 491 zobudila hlavné vlákno vlastným komentárom, hoci ju robil
  // sub-agent (úloha 492).
  // Koniec blokovania alebo čakania, ktorý urobil Tasker, budí vždy: práca
  // ohlásená pred blokovaním patrí relácii, ktorá už môže byť preč. Chyba
  // 24. 10. 2026: úloha 491 po done blokéra 493 stála v todo, nikto nevedel.
  const unblocked = ev.actor === "tasker" && (ev.from_status === "blocked" || ev.from_status === "waiting");
  if (ev.kind === "status" && ev.to_status === "todo" && (ev.actor === `human:${agent}` || (opts.liveWork && !unblocked))) return null;
  if (ev.kind === "assigned" && ev.detail === agent) return "assigned";
  if (ev.kind === "status" && ev.to_status === "todo") {
    // Koniec čakania, ktorý agent urobil sám (tasker resume), ho nebudí.
    if (ev.from_status === "waiting" && ev.actor === `human:${agent}`) return null;
    // in_progress -> todo je koniec ohlásenej práce agenta (tasker work --stop,
    // uplynutý čas), nie úloha na rade. Chyba 24. 10. 2026: úloha 476 prišla
    // ako "na rade" po vlastnom work_stop, doručená až po jej zavretí.
    if (ev.from_status === "in_progress") return null;
    return "todo";
  }
  return null;
}

// Úloha bez riešiteľa, ktorú Tasker sám presunul blocked -> todo (všetky
// blokéry hotové): nikto ju nespustí, preto o nej vie zakladateľ. Zakladateľ
// je agent s mostom (creator `human:<meno>`) a nie je spúšťaný dispečerom
// (enabled=1). Chyba 23. 10. 2026: úloha 427 stála 52 minút.
export function unassignedFounder(ev, agents, enabled = null) {
  if (ev.assignee || ev.kind !== "status" || ev.actor !== "tasker") return null;
  if (ev.from_status !== "blocked" || ev.to_status !== "todo" || ev.status !== "todo") return null;
  const agent = agents.find((a) => ev.creator === `human:${a.name}`);
  if (!agent || enabled?.get(agent.name) === 1) return null;
  return agent;
}

export function renderUnassigned(task, agent, cfg) {
  const tasker = `AGENT_NAME=${agent.name} ${TK}`;
  return [
    `Tasker: úloha #${task.id}, ktorú si založil, je odblokovaná a nemá riešiteľa (blocked -> todo).`,
    taskLink(task.id),
    `Názov: ${task.title}`,
    `Stav: ${task.status}`,
    ...(task.project ? [`Projekt: ${task.project}`] : []),
    "",
    (task.body || "(bez tela)").slice(0, 8000),
    "",
    "Odpoveď do schránky sa nepíše, výsledok je komentár a stav úlohy v Taskeri.",
    `Detail: ${tasker} task show ${task.id} --json`,
    `Hotovo: ${tasker} done ${task.id} --summary "..."`,
  ].join("\n");
}

export function renderBridge(task, triggers, comment, cfg) {
  const why = triggers.includes("comment") && triggers.length === 1
    ? `nový komentár (${comment?.author ?? "?"})` : "úloha je v poradí";
  const tasker = `AGENT_NAME=${task.assignee} ${TK}`;
  const lines = [
    `Tasker: úloha #${task.id} pre teba, ${why}.`,
    taskLink(task.id),
    `Názov: ${task.title}`,
    `Stav: ${task.status}`,
    ...(task.project ? [`Projekt: ${task.project}`] : []),
    "",
    (task.body || "(bez tela)").slice(0, 8000),
  ];
  if (comment) lines.push("", `Posledný komentár (${comment.author}, ${new Date(comment.created_at).toISOString()}):`, comment.body.slice(0, 4000));
  lines.push(
    "",
    "Odpoveď do schránky sa nepíše, výsledok je komentár a stav úlohy v Taskeri.",
    `Detail: ${tasker} task show ${task.id} --json`,
    `Komentár: ${tasker} comment ${task.id} --body "..."`,
    `Hotovo: ${tasker} done ${task.id} --summary "..."`,
  );
  return lines.join("\n");
}

// Operátor, ktorého komentár z webu Taskera nesie rozhodnutie (autor
// komentára v Taskeri). Zoznam mien oddelených ":" v TASKER_OPERATORS.
export function operatorActors(env = process.env) {
  return new Set((env.TASKER_OPERATORS || "operator").split(":").filter(Boolean).map((n) => `human:${n}`));
}

// Komentár operátora na úlohe v needs_human. Tasker ho dá sám do todo (SPEC 7.6),
// udalosť príde ako dvojica comment a status needs_human -> todo toho istého aktéra.
export function renderDecision(task, comment, cfg) {
  const tasker = `AGENT_NAME=${cfg.name ?? "agent"} ${TK}`;
  const lines = [
    `Tasker: úloha #${task.id}, komentár ${comment?.author ?? "operátora"} po needs_human, zapíš rozhodnutie, ak platí mimo úlohy.`,
    taskLink(task.id),
    `Názov: ${task.title}`,
    `Stav: ${task.status}`,
    ...(task.project ? [`Projekt: ${task.project}`] : []),
    `Riešiteľ: ${task.assignee ?? "nikto"}`,
  ];
  if (comment) lines.push("", `Komentár (${comment.author}, ${new Date(comment.created_at).toISOString()}):`, comment.body.slice(0, 4000));
  lines.push(
    "",
    "Posúď: platí voľba aj po uzavretí úlohy (pravidlo, trieda úkonov, voľba stavu sveta)? Ak áno, zapíš ju /opt/agent-rules/bin/rozhodni.sh a riešiteľovi odpovedz komentárom. Ak platí len v úlohe, záznam nepíš.",
    `Detail: ${tasker} task show ${task.id} --json`,
  );
  return lines.join("\n");
}

// Úloha agenta, ktorý je v Taskeri vypnutý (enabled=0) a nemá most:
// nikto ju nespustí, preto ide vlastníkovi mostu.
export function renderOrphan(task, comment, cfg) {
  const tasker = `AGENT_NAME=${task.assignee} ${TK}`;
  const lines = [
    `Tasker: úloha #${task.id} pre agenta ${task.assignee}, ktorý je vypnutý a nemá most, nikto ju nespustí.`,
    taskLink(task.id),
    `Názov: ${task.title}`,
    `Stav: ${task.status}`,
    ...(task.project ? [`Projekt: ${task.project}`] : []),
  ];
  if (comment) lines.push("", `Posledný komentár (${comment.author}, ${new Date(comment.created_at).toISOString()}):`, comment.body.slice(0, 4000));
  lines.push("", `Detail: ${tasker} task show ${task.id} --json`);
  return lines.join("\n");
}

// Komentár človeka, ktorý nikoho nezobudí: úloha je koncová alebo nemá riešiteľa.
export function renderDeadComment(task, who, comment) {
  let body = Buffer.from(comment?.body ?? "(komentár som nenašiel)").subarray(0, 4000).toString().replace(/\uFFFD+$/, "");
  return [
    `Tasker: úloha #${task.id}, komentár od ${who} nikoho nezobudí (stav ${task.status}, riešiteľ ${task.assignee ?? "nikto"}).`,
    taskLink(task.id),
    `Názov: ${task.title}`,
    ...(task.project ? [`Projekt: ${task.project}`] : []),
    "",
    body,
    "",
    "Prácu z neho zadaj novou úlohou alebo úlohu otvor (tasker reopen), ak treba.",
    `Detail: tasker task show ${task.id} --json`,
  ].join("\n");
}

export async function bridgeTick(cfg, agents = externalAgents()) {
  if (!agents.length) return { written: 0 };
  ensureDir(cfg.state);
  const statePath = join(cfg.state, "tasker_bridge_last_id");
  if (!existsSync(cfg.taskerDb)) return { written: 0, reason: `chýba ${cfg.taskerDb}` };
  const db = await openDb(cfg.taskerDb);
  try {
    const max = db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM events").get().m;
    if (!existsSync(statePath)) {
      writeFileSync(statePath, `${max}\n`);
      return { written: 0, reason: `most začína od udalosti ${max}` };
    }
    const last = Number(readFileSync(statePath, "utf8").trim()) || 0;
    const rows = db.prepare(`
      SELECT e.id, e.task_id, e.actor, e.kind, e.from_status, e.to_status, e.detail, t.assignee, t.status,
        (SELECT c.actor FROM events c WHERE c.task_id = e.task_id AND c.kind = 'created' ORDER BY c.id LIMIT 1) AS creator
      FROM events e JOIN tasks t ON t.id = e.task_id
      WHERE e.id > ? AND e.id <= ? AND e.quiet = 0 AND e.kind IN ('created', 'assigned', 'status', 'comment')
      ORDER BY e.id`).all(last, max);
    // Stav agentov v Taskeri (enabled): bez tabuľky agents (staré testy) sa
    // most správa ako doteraz.
    const enabled = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'agents'").get()
      ? new Map(db.prepare("SELECT name, enabled FROM agents").all().map((a) => [a.name, a.enabled]))
      : null;
    const owner = cfg.name ?? "agent";
    const byTask = new Map();
    const orphans = new Map();
    const dead = new Map();
    const operators = operatorActors();
    const opComment = new Map();
    const decisions = new Map();
    const unassigned = new Map();
    for (const ev of rows) {
      const founder = unassignedFounder(ev, agents, enabled);
      if (founder) unassigned.set(ev.task_id, founder);
      if (ev.kind === "comment" && operators.has(ev.actor)) opComment.set(ev.task_id, ev.actor);
      else if (ev.kind === "status" && ev.from_status === "needs_human" && ev.to_status === "todo"
        && opComment.get(ev.task_id) === ev.actor) decisions.set(ev.task_id, ev.actor);
      const agent = agents.find((a) => a.name === ev.assignee);
      if (agent) {
        // Agenta s enabled=1 spúšťa dispečer, vlákno T3 by robilo tú istú úlohu.
        const trig = enabled?.get(agent.name) === 1 ? null : bridgeTrigger(ev, agent.name, { liveWork: liveWork(db, ev.task_id) });
        if (trig) {
          const cur = byTask.get(ev.task_id) ?? { agent, triggers: [], lastId: 0 };
          cur.triggers.push(trig);
          cur.lastId = ev.id;
          byTask.set(ev.task_id, cur);
        }
      } else if (ev.assignee && enabled?.get(ev.assignee) === 0 && bridgeTrigger(ev, ev.assignee)) {
        const cur = orphans.get(ev.task_id) ?? { triggers: [] };
        cur.triggers.push(bridgeTrigger(ev, ev.assignee));
        orphans.set(ev.task_id, cur);
      }
      if (ev.kind === "comment" && ev.actor.startsWith("human:") && (TERMINAL.has(ev.status) || !ev.assignee)) {
        const who = ev.actor.slice(6);
        if (who !== owner && who !== ev.assignee) dead.set(ev.task_id, who);
      }
    }
    const getTask = db.prepare("SELECT * FROM tasks WHERE id = ?");
    const getComment = db.prepare("SELECT author, body, created_at FROM comments WHERE task_id = ? ORDER BY id DESC LIMIT 1");
    const names = [];
    const owner0 = cfg.name ?? "agent";
    for (const [id, x] of byTask) {
      // Úlohu vlastníka s rozhodnutím nesie správa rozhodnutia, bežná by bola duplicitná.
      if (decisions.has(id) && x.agent.name === owner0) continue;
      const task = getTask.get(id);
      const comment = x.triggers.includes("comment") ? getComment.get(id) : null;
      names.push(`${x.agent.name}/${writeInbox(x.agent.box, "tasker", renderBridge(task, x.triggers, comment, cfg), topicFor({ ...cfg, box: x.agent.box, topicsFile: x.agent.box === cfg.box ? cfg.topicsFile : undefined }, task.project, id, db), "nečakám")}`);
    }
    const lastBy = db.prepare("SELECT author, body, created_at FROM comments WHERE task_id = ? AND author = ? ORDER BY id DESC LIMIT 1");
    for (const [id, x] of orphans) {
      const task = getTask.get(id);
      const comment = x.triggers.includes("comment") ? getComment.get(id) : null;
      names.push(`${owner}/${writeInbox(cfg.box, "tasker", renderOrphan(task, comment, cfg), topicFor(cfg, task.project, id, db), "nečakám")}`);
    }
    for (const [id, agent] of unassigned) {
      const task = getTask.get(id);
      names.push(`${agent.name}/${writeInbox(agent.box, "tasker", renderUnassigned(task, agent, cfg), topicFor({ ...cfg, box: agent.box, topicsFile: agent.box === cfg.box ? cfg.topicsFile : undefined }, task.project, id, db), "nečakám")}`);
    }
    for (const [id, actor] of decisions) {
      const task = getTask.get(id);
      names.push(`${owner}/${writeInbox(cfg.box, "tasker", renderDecision(task, lastBy.get(id, actor.slice(6)), cfg), topicFor(cfg, task.project, id, db), "čakám")}`);
    }
    for (const [id, who] of dead) {
      const task = getTask.get(id);
      names.push(`${owner}/${writeInbox(cfg.box, "tasker", renderDeadComment(task, who, lastBy.get(id, who) ?? getComment.get(id)), topicFor(cfg, task.project, id, db), "nečakám")}`);
    }
    writeFileSync(statePath, `${max}\n`);
    return { written: names.length, names };
  } finally {
    db.close();
  }
}

async function main() {
  const once = process.argv.includes("--once");
  const cfg = config();
  const intervalMs = Number(process.env.AGENT_TASKER_POLL_S || 30) * 1000;
  let lastReason = "";
  for (;;) {
    try {
      for (const r of [await tick(cfg), await bridgeTick(cfg)]) {
        if (r.written) log(NAME, `zapísané ${r.written}: ${r.names.join(", ")}`);
        else if (r.reason && r.reason !== lastReason) log(NAME, r.reason);
        if (r.reason) lastReason = r.reason;
      }
    } catch (e) {
      log(NAME, `chyba: ${e.message}`);
      if (once) process.exit(1);
    }
    if (once) return;
    await sleep(intervalMs);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
