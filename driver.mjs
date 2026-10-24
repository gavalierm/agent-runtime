#!/usr/bin/env node
// Budič agenta . Sleduje schránku $AGENT_BOX/inbox a správy
// pošle do vlákna agenta v T3 Code serveri, dozerá na beh vlákna a na slovo
// agenta HOTOVO-KONTEXT mu vyčistí kontext príkazom /clear v tom istom
// vlákne, náhradou novým vláknom. Po /clear model nevolá, správu s ďalším
// krokom pošle len riadok `HOTOVO-KONTEXT pokracuj <kľúč>` s platnou
// odovzdávkou od kontext.sh (kontext.mjs). Model nevolá, beží ako systemd
// služba pod rootom ako T3 server (agent-driver@<meno>.service).
//
// Jeden priechod:
// 1. Id vlákna číta z $AGENT_STATE/thread_id (zapíše ho start_agent.mjs
//    alebo náhradný prechod na nové vlákno) a stav vlákna z GET /api/orchestration/shell.
// 2. Čistý kontext (rotation.json), keď beží: kým trvá, schránka čaká
//    a správy z nej idú až po /clear (supervise.mjs).
// 3. Dozor: keď beh skončil pádom, po odstupe pošle do vlákna pokyn
//    pokračovať, najviac AGENT_WAKE_MAX za AGENT_WAKE_WINDOW_S, potom
//    výstraha. Limit predplatného nie je pád, budič čaká na reset.
// 4. Po riadnom behu, ktorého odpoveď končí riadkom HOTOVO-KONTEXT
//    [spanok|pokracuj <kľúč>], začne čistý kontext.
// 5. Schránka: keď vo vlákne nebeží beh, nečaká schválenie ani limit,
//    všetky budiace správy spojí do jednej dávky, zapíše ju do
//    $AGENT_STATE/inflight.json a pošle príkazom message.dispatch cez /ws.
//    Budí správa s prvým riadkom `odpoveď: čakám` alebo `nečakám` a správa
//    bez riadku. Správa `odpoveď: na vedomie` budí, len keď agent na
//    odpoveď k jej kľúču čaká (route.mjs sent, inak riadok `k správe:`),
//    inak ostáva v inboxe a ide pod nadpisom "Na vedomie" s najbližšou
//    dávkou do toho istého vlákna, nikdy sama.
//    Dávka odíde až po tichom okne AGENT_BATCH_WAIT_S od poslednej
//    budiacej správy, najviac AGENT_BATCH_MAX_WAIT_S od prvej.
//    Správa s trasou (route.mjs, odpoveď na správu z vlákna témy) ide do
//    vlákna z trasy, zaniknuté vlákno nahradí hlavné s poznámkou. Správa
//    od tasker bez trasy s telom "Tasker: úloha #N" ide do nearchivovaného
//    vlákna s #N v titulku (nie sub-agent, nie projekt hlavného vlákna
//    iného agenta; pred zoznamom tém, viac zhôd: najnovšie updatedAt). Nová
//    správa k téme bez trasy ide do vlákna zo zoznamu tém (topics.json),
//    téma mimo zoznamu alebo zaniknuté vlákno do hlavného s riadkom [budič],
//    agent bez zoznamu tém dostane správu do hlavného bez riadku.
//    commandId je odvodené z mien súborov, čísla pokusu a náhodného id
//    dávky v inflight.json. Bez id dávky by nová správa s menom už
//    doručenej správy dostala jej commandId a T3 by ju zahodil. Keď budič padne
//    po odoslaní a pred presunom, ďalší priechod pošle tú istú dávku s tým
//    istým commandId a T3 ju podľa záznamu príjmu nezopakuje.
// 6. Po prijatí presunie súbory do $AGENT_BOX/processed.
// 7. S AGENT_CLEAR_WATCH=1 beží vedľa sledovač čistého kontextu ostatných
//    vlákien T3 servera (clear_watch.mjs).
// tick() a watchStep() bežia v jednom procese za sebou (serial() z lib.mjs).
// Odmietnutie serverom zvýši číslo pokusu (T3 si pamätá aj odmietnutie,
// to isté commandId by zlyhalo navždy). Chyba spojenia číslo nemení.
//
// Použitie: driver.mjs [--once]
import { readFileSync, renameSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { alert, config, serial, ensureDir, inboxConfig, inboxEntries, log, parseHeader, parseName, readJson, stableId, superviseConfig, T3Client, threadBusy, writeJsonAtomic } from "./lib.mjs";
import { contextStep, rotationStep, stalledStep, superviseStep, threadActive } from "./supervise.mjs";
import { messageTopic, readTopics, routeFor, topicsPath, waitingFor } from "./route.mjs";
import { agentStates, watchStep } from "./clear_watch.mjs";

const NAME = "driver";
const MAX_BATCH = 20;
const MAX_BYTES = 100_000;
// Držané správy v dávke: strop na správu a na dávku (10 správ).
const HELD_BYTES = 4_000;
const MAX_HELD = 10;

// Text pre agenta: hlavička s odosielateľom, témou, čo odosielateľ čaká
// a cestou odpovede, potom telo bez riadkov hlavičky. Odpoveď ide
// príkazom reply.sh do schránky odpovedí odosielateľa.
// Číslo úlohy z titulku vlákna T3, rovnako ako taskIdOf v Taskeri (lib/live.mjs).
function titleTaskId(title) {
  const m = /#(\d+)\b/.exec(title ?? "");
  return m ? Number(m[1]) : null;
}

// Číslo úlohy zo správy Taskera, ktorej telo začína riadkom "Tasker: úloha #N".
function taskerTaskId(name, body) {
  if (parseName(name).sender !== "tasker") return null;
  const m = /^Tasker: úloha #(\d+)\b/.exec(body);
  return m ? Number(m[1]) : null;
}

// Zapíše do Taskera, do ktorého vlákna budič doručil správu k úlohe (`tasker route`, úloha 486).
// Chyba zápisu doručenie nezdrží. Bez `cfg.routeCmd` (testy) sa nezapíše nič.
export function recordRoute(cfg, taskId, threadId, title, via) {
  if (!cfg.routeCmd) return false;
  const args = ["route", String(taskId), "--thread", String(threadId)];
  if (title) args.push("--title", String(title));
  if (via) args.push("--via", String(via));
  try {
    const r = spawnSync(cfg.routeCmd, args, { env: { ...process.env, AGENT_NAME: cfg.name ?? "agent" }, timeout: 5000, stdio: "ignore" });
    return r.status === 0;
  } catch { return false; }
}

// Projekty T3 hlavných vlákien iných agentov (súrodenci $AGENT_STATE s
// thread_id), okrem projektu vlastného hlavného vlákna.
function foreignProjects(cfg, shell, own) {
  const out = new Set();
  for (const dir of agentStates(cfg)) {
    if (dir === cfg.state) continue;
    let id = "";
    try { id = readFileSync(join(dir, "thread_id"), "utf8").trim(); } catch {}
    const p = id && T3Client.threadFromShell(shell, id)?.projectId;
    if (p && p !== own?.projectId) out.add(p);
  }
  return out;
}

export function renderMessage(box, name, replyCmd = "reply.sh", { held = false } = {}) {
  const { sender, topic } = parseName(name);
  const { mode, body: raw } = parseHeader(readFileSync(join(box, "inbox", name), "utf8"));
  let body = raw;
  const limit = held ? HELD_BYTES : MAX_BYTES;
  if (Buffer.byteLength(body) > limit) body = body.slice(0, limit) + `\n[skrátené budičom, celá správa je v ${join(box, "processed", name)}]`;
  let reply;
  if (["tasker", "ranny"].includes(sender)) reply = "odpoveď netreba";
  else if (mode === "na vedomie") reply = "odpoveď sa nepíše";
  else if (mode === "čakám") reply = `odpoveď: ${replyCmd} ${name} <<'EOF' ... EOF (odosielateľ na ňu čaká)`;
  else if (mode === "nečakám") reply = `odpoveď: ${replyCmd} ${name} <<'EOF' ... EOF (odosielateľ nečaká, výsledok prečíta pri ďalšom ťahu)`;
  else reply = `odpoveď: ${replyCmd} ${name} <<'EOF' ... EOF`;
  const attr = mode ? ` odpoveď="${mode}"` : "";
  return `<schranka od="${sender}"${topic ? ` tema="${topic}"` : ""} id="${name}"${attr}>\n${reply}\n\n${body.trimEnd()}\n</schranka>`;
}

export function renderBatch(box, names, replyCmd, notes = {}, held = []) {
  const wake = names.filter((n) => !held.includes(n));
  const one = (n, opt) => (notes[n] ? notes[n] + "\n" : "") + renderMessage(box, n, replyCmd, opt);
  const parts = [];
  if (wake.length > 1) parts.push(`Schránka: ${wake.length} správy.`);
  parts.push(...wake.map((n) => one(n)));
  if (held.length) {
    parts.push(`Na vedomie, ${held.length} ${held.length === 1 ? "správa" : "správ"} bez budenia. Neodpovedá sa na ne, práca z nich je nový pokyn.`);
    parts.push(...held.map((n) => one(n, { held: true })));
  }
  return parts.join("\n\n");
}

// Budí správa čakám, nečakám a správa bez riadku. Správa na vedomie budí
// len ako odpoveď (`k:` v hlavičke) na správu, na ktorú agent čaká
// (route.mjs sent), inak podľa riadku `k správe: čakám`, inak sa drží.
export function classify(cfg, name) {
  const { mode, original, meta } = parseHeader(readFileSync(join(cfg.box, "inbox", name), "utf8"));
  if (mode !== "na vedomie") return { wake: true, mode };
  const w = waitingFor(cfg, name, Date.now(), meta?.k || null);
  return { wake: w === null ? original === "čakám" : w, mode };
}

export async function tick(cfgIn, client, { now = Date.now() } = {}) {
  const cfg = { ...superviseConfig(), ...inboxConfig(), ...cfgIn };
  ensureDir(cfg.state);
  const inflightPath = join(cfg.state, "inflight.json");
  let inflight = readJson(inflightPath);
  // Súbor z rozpracovanej dávky, ktorý medzitým zmizol (presunul ho niekto
  // ručne), z dávky vypadne. Prázdna dávka sa zahodí.
  if (inflight) {
    const left = inflight.files.filter((f) => existsSync(join(cfg.box, "inbox", f)));
    if (left.length === 0) { rmSync(inflightPath, { force: true }); inflight = null; }
    else if (left.length !== inflight.files.length) {
      inflight = { files: left, attempt: inflight.attempt + 1 };
      writeJsonAtomic(inflightPath, inflight);
    }
  }

  let threadId;
  try { threadId = readFileSync(join(cfg.state, "thread_id"), "utf8").trim(); } catch { threadId = ""; }
  if (!threadId) return { sent: 0, reason: `chýba ${join(cfg.state, "thread_id")}, spusti start_agent.mjs` };

  const thread = await client.thread(threadId);

  const rot = await rotationStep(cfg, client, threadId, thread, now);
  if (rot?.block) return { sent: 0, reason: rot.block };
  if (rot?.action) return { sent: 0, ...rot };

  const active = threadActive(thread);
  if (thread?.activeRunId) {
    const st = await stalledStep(cfg, client, threadId, thread, now);
    if (st?.action) return { sent: 0, ...st };
  }
  if (!active) {
    const sup = await superviseStep(cfg, client, threadId, thread, now);
    if (sup?.block) return { sent: 0, reason: sup.block };
    if (sup?.action) return { sent: 0, ...sup };
    if (!inflight) {
      const ctx = await contextStep(cfg, client, threadId, thread, now);
      if (ctx?.action) return { sent: 0, ...ctx };
    }
  }

  // Cieľ každej správy: vlákno z trasy (route.mjs), pri novej správe
  // k téme vlákno zo zoznamu tém, inak hlavné vlákno. Vlákno, ktoré
  // neexistuje alebo je archivované, nahradí hlavné s poznámkou v správe.
  // Jeden priechod pošle jednu dávku, dávka má jedno vlákno, zaneprázdnené
  // vlákno témy hlavné nezdrží.
  let shell = null;
  let topics = null;
  let otherProjects = null;
  const target = async (name) => {
    let k = null;
    let text = "";
    try {
      const h = parseHeader(readFileSync(join(cfg.box, "inbox", name), "utf8"));
      k = h.meta?.k || null;
      text = h.body;
    } catch {}
    const r = routeFor(cfg, name, k);
    if (r) {
      if (r.thread === threadId) return { threadId, thread, via: "hlavné vlákno" };
      shell ??= await client.shell();
      const t = T3Client.threadFromShell(shell, r.thread);
      if (t && !t.archived) return { threadId: r.thread, thread: t, via: "trasa odpovede" };
      return { threadId, thread, via: "hlavné vlákno", note: `[budič] Správa patrí vláknu ${r.thread}${t?.title ? ` (${t.title})` : ""}, to ${t ? "je archivované" : "neexistuje alebo je archivované (T3 0.1.0 archivované vlákna nevracia)"}, preto je tu.` };
    }
    // Správa Taskera o úlohe #N bez trasy ide do vlákna úlohy: nearchivované
    // vlákno s #N v titulku. Vlákna tém bežia aj v projektoch MCP
    // (t3_thread_launch nad priečinkom projektu), preto sa projekt hlavného
    // vlákna nevyžaduje. Vynechá vlákna sub-agentov a vlákna v projekte
    // hlavného vlákna iného agenta (súrodenci $AGENT_STATE, clear_watch.mjs).
    // Má prednosť pred zoznamom tém.
    const taskId = taskerTaskId(name, text);
    if (taskId) {
      shell ??= await client.shell();
      otherProjects ??= foreignProjects(cfg, shell, thread);
      const found = (shell.threads ?? [])
        .filter((t) => t.id !== threadId && !t.archivedAt && !t.deletedAt && !t.id.startsWith("thread:provider:") && !t.parentThreadId
          && !otherProjects.has(t.projectId) && titleTaskId(t.title) === taskId)
        .reduce((best, t) => (best && String(best.updatedAt ?? "") >= String(t.updatedAt ?? "") ? best : t), null);
      if (found) return { threadId: found.id, thread: { ...found, archived: false }, via: "vlákno úlohy" };
    }
    const topic = messageTopic(name, cfg.name ?? "agent");
    if (!topic) return { threadId, thread, via: "hlavné vlákno" };
    // Agent bez zoznamu tém (správca servera) vlákna tém nevedie, správa
    // ide do hlavného vlákna bez riadku [budič], ako v bin/ask_agent.sh.
    if (!existsSync(topicsPath(cfg))) return { threadId, thread, via: "hlavné vlákno" };
    topics ??= readTopics(topicsPath(cfg));
    const tid = topics[topic]?.thread;
    let why = "téma nie je v zozname tém";
    if (tid === threadId) return { threadId, thread, via: "hlavné vlákno" };
    if (tid) {
      shell ??= await client.shell();
      const t = T3Client.threadFromShell(shell, tid);
      if (t && !t.archived) return { threadId: tid, thread: t, via: `téma ${topic}` };
      why = `vlákno ${tid}${t?.title ? ` (${t.title})` : ""} ${t ? "je archivované" : "neexistuje alebo je archivované (T3 0.1.0 archivované vlákna nevracia)"}`;
    }
    return { threadId, thread, via: "hlavné vlákno", note: `[budič] Vlákno témy ${topic} som nenašiel (${why}), posielam do hlavného vlákna.\nVec nerob, kým nezistíš, či tému nevedie iné vlákno (route.mjs topic list, zoznam vlákien T3).` };
  };

  // Rozpracovaná dávka, ktorej vlákno je zaneprázdnené, ostáva v inflight.json
  // a nezdrží ostatné vlákna (úloha 419): tie dostanú dávku bez súboru.
  let blocked = null;
  if (inflight) {
    // Vlákno rozpracovanej dávky, ktoré medzitým zaniklo, nahradí hlavné.
    let t = thread;
    if (inflight.threadId && inflight.threadId !== threadId) {
      t = T3Client.threadFromShell(await client.shell(), inflight.threadId);
      if (!t || t.archived) {
        inflight = { ...inflight, threadId, attempt: inflight.attempt + 1, notes: Object.fromEntries(inflight.files.map((f) => [f, `[budič] Správa patrí vláknu ${inflight.threadId}, to ${t ? "je archivované" : "neexistuje alebo je archivované (T3 0.1.0 archivované vlákna nevracia)"}, preto je tu.`])) };
        writeJsonAtomic(inflightPath, inflight);
        t = thread;
      }
    }
    const busy = threadBusy(t, now);
    if (busy) { blocked = { inflight, busy }; inflight = null; }
  }
  if (!inflight) {
    const entries = inboxEntries(cfg.box).filter((e) => !blocked?.inflight.files.includes(e.name));
    if (entries.length === 0) return { sent: 0, reason: "prázdna schránka" };
    // Správy podľa vlákna a podľa toho, či budia. Držané patria vláknu
    // z trasy, strop držania platí na vlákno.
    const groups = new Map();
    for (const e of entries) {
      const { threadId: tid, thread: t, note, via } = await target(e.name);
      if (blocked && tid === (blocked.inflight.threadId ?? threadId)) continue;
      const g = groups.get(tid) ?? { threadId: tid, thread: t, wake: [], held: [], notes: {}, via: {} };
      (classify(cfg, e.name).wake ? g.wake : g.held).push(e);
      if (note) g.notes[e.name] = note;
      if (via) g.via[e.name] = via;
      groups.set(tid, g);
    }
    const reasons = [];
    let heldTotal = 0;
    let chosen = null;
    const label = (g, text) => (g.threadId === threadId ? text : `${g.threadId}: ${text}`);
    for (const g of groups.values()) {
      heldTotal += g.held.length;
      let files;
      if (g.wake.length) {
        const newest = Math.max(...g.wake.map((e) => e.mtime));
        const oldest = Math.min(...g.wake.map((e) => e.mtime));
        if (now - newest < cfg.batchWaitMs && now - oldest < cfg.batchMaxWaitMs) {
          reasons.push(label(g, `tiché okno, ${g.wake.length} správ čaká na dávku`));
          continue;
        }
        files = g.wake.slice(0, MAX_BATCH).map((e) => e.name);
      } else {
        if (g.held.length) reasons.push(label(g, `držím ${g.held.length} na vedomie`));
        continue;
      }
      const busy = threadBusy(g.thread, now);
      if (busy) { reasons.push(label(g, busy)); continue; }
      const held = g.held.slice(0, MAX_HELD).map((e) => e.name);
      chosen = { threadId: g.threadId, files: [...files, ...held], held, notes: g.notes, via: g.via, title: g.thread?.title ?? null };
      break;
    }
    if (blocked) reasons.unshift(`dávka ${blocked.inflight.threadId ?? threadId}: ${blocked.busy}`);
    if (!chosen) return { sent: 0, held: heldTotal, reason: reasons.join("; ") };
    if (blocked) {
      // Súbor inflight.json drží blokovaná dávka. Táto ide bez neho, batch z mien,
      // časov súborov a minúty, aby pád po odoslaní nezopakoval správu a odmietnutie
      // serverom sa po minúte zmenilo na nové commandId.
      const mt = new Map(entries.map((e) => [e.name, e.mtime]));
      const batch = stableId("nopersist", chosen.threadId, String(Math.floor(now / 60_000)), ...chosen.files.map((f) => `${f}@${mt.get(f)}`));
      inflight = { files: chosen.files, held: chosen.held, attempt: 1, batch, threadId: chosen.threadId, notes: chosen.notes, via: chosen.via, title: chosen.title };
    } else {
      inflight = { files: chosen.files, held: chosen.held, attempt: 1, batch: randomUUID(), threadId: chosen.threadId, notes: chosen.notes, via: chosen.via, title: chosen.title };
      writeJsonAtomic(inflightPath, inflight);
    }
  }
  const to = inflight.threadId ?? threadId;
  const key = [to, inflight.batch ?? "", String(inflight.attempt), ...inflight.files];
  const command = {
    type: "message.dispatch",
    commandId: stableId(`${cfg.name ?? "agent"}-inbox`, ...key),
    messageId: stableId(`${cfg.name ?? "agent"}-inbox-msg`, ...key),
    createdBy: "user",
    creationSource: "web",
    threadId: to,
    text: renderBatch(cfg.box, inflight.files, cfg.replyCmd, inflight.notes ?? {}, inflight.held ?? []),
    attachments: [],
    // Keby medzi čítaním stavu a odoslaním začal beh (napríklad operátor
    // napísal do vlákna), server správu zaradí za neho a beh nepreruší.
    dispatchMode: { type: "queue_after_active" },
  };
  try {
    await client.dispatch(command);
  } catch (e) {
    if (e.rejected && !blocked) writeJsonAtomic(inflightPath, { ...inflight, attempt: inflight.attempt + 1, lastError: e.message });
    throw e;
  }
  // Správu s menom už spracovanej správy presunie s príponou, staršiu neprepíše.
  const routed = [];
  for (const f of inflight.files) {
    try {
      const id = taskerTaskId(f, parseHeader(readFileSync(join(cfg.box, "inbox", f), "utf8")).body);
      if (id) routed.push({ id, via: inflight.via?.[f] ?? null });
    } catch {}
    const dest = join(cfg.box, "processed", f);
    renameSync(join(cfg.box, "inbox", f), existsSync(dest) ? `${dest}.${Date.now()}` : dest);
  }
  if (!blocked) rmSync(inflightPath, { force: true });
  for (const r of routed) recordRoute(cfg, r.id, to, inflight.title ?? (to === threadId ? thread?.title : null) ?? null, r.via);
  return { sent: inflight.files.length, files: inflight.files, held: (inflight.held ?? []).length, commandId: command.commandId, threadId: to === threadId ? undefined : to };
}

// Sledovač ostatných vlákien beží vedľa schránky vo vlastnej slučke, jeho
// chyba ani čakanie nezdrží schránku agenta.
async function watchLoop(cfg, client, once, run) {
  const name = `${cfg.name}-clear-watch`;
  log(name, "beží, vynecháva vlákna agentov z thread_id");
  let backoff = cfg.pollMs;
  for (;;) {
    try {
      for (const a of await run(() => watchStep(cfg, client))) {
        if (a.action === "rejected") alert(cfg, `sledovač: T3 odmietol /clear vo vlákne ${a.threadId} (beh ${a.runId}): ${a.error}`);
        else log(name, `${a.action}: ${JSON.stringify(a)}`);
      }
      backoff = cfg.pollMs;
    } catch (e) {
      log(name, `chyba: ${e.message}`);
      backoff = Math.min(backoff * 2, 300_000);
    }
    if (once) return;
    await sleep(backoff);
  }
}

async function main() {
  const once = process.argv.includes("--once");
  const cfg = config();
  const name = `${cfg.name}-${NAME}`;
  const client = T3Client.fromConfig(cfg);
  // tick() a watchStep() bežia v jednom procese, mutex ich nestriedá.
  const run = serial();
  if (cfg.clearWatch) watchLoop(cfg, client, once, run);
  let lastReason = "";
  let backoff = cfg.pollMs;
  for (;;) {
    try {
      const r = await run(() => tick(cfg, client));
      if (r.sent) log(name, `poslané ${r.sent}${r.held ? ` (${r.held} na vedomie)` : ""}${r.threadId ? ` do ${r.threadId}` : ""}: ${r.files.join(", ")}`);
      else if (r.action) log(name, `${r.action}: ${JSON.stringify({ ...r, sent: undefined, action: undefined })}`);
      else if (r.reason !== lastReason && r.reason !== "prázdna schránka") log(name, `čakám: ${r.reason}`);
      lastReason = r.reason ?? "";
      backoff = cfg.pollMs;
    } catch (e) {
      log(name, `chyba: ${e.message}`);
      if (once) process.exit(1);
      backoff = Math.min(backoff * 2, 300_000);
    }
    if (once) return;
    await sleep(backoff);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
