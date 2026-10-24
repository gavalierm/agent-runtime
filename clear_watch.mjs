// Sledovač čistého kontextu vo všetkých vláknach T3 servera okrem vlákien
// agentov z thread_id. Vlákno agenta rieši jeho budič (supervise.mjs,
// cesta "cleared"). Model nevolá. Beží v budiči jedného agenta
// (AGENT_CLEAR_WATCH=1 v jeho runtime.env), aby dva budiče na tom istom
// T3 serveri neposlali /clear dvakrát (README.md runtime, Čistý kontext
// vo všetkých vláknach).
//
// Jeden priechod:
// 1. Rozpracované z pending (pád medzi /clear a pokračovaním) dokončí
//    s tými istými commandId, T3 ich podľa záznamu príjmu nezopakuje.
// 2. Zo shell vezme nearchivované vlákna, vynechá vlákna agentov
//    (thread_id, oldThreadId z rotation.json, retired_threads), vlákna
//    s bežiacim behom, schválením, limitom alebo úlohou na pozadí.
// 3. Pri riadne skončenom behu, ktorý ešte nevidel, prečíta poslednú
//    odpoveď asistenta v behu. Keď jej posledný neprázdny riadok je
//    HOTOVO-KONTEXT (kontext.mjs), pošle /clear. Pri riadku pokracuj
//    s platným kľúčom pošle za ním správu s ďalším krokom, inak žiadnu.
//
// Stav $AGENT_STATE/clear_watch.json: checked (vlákno -> posúdený beh),
// pending (rozpracovaný /clear). Prvý štart bez stavu zapíše posledné behy
// všetkých vlákien ako posúdené a nič nepošle: staré vlákna agentov
// nahradené novým vláknom končia slovom a pokračovanie by v nich spustilo
// druhého agenta.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { alert, readJson, stableId, threadBusy, writeJsonAtomic } from "./lib.mjs";
import { CLEAR_TEXT, interruptStalled, classifyEnd, lastAgentText, usedTokensOfRun } from "./supervise.mjs";
import { afterClearText, decideClear, markConsumed } from "./kontext.mjs";

function statePath(cfg) { return join(cfg.state, "clear_watch.json"); }

// Priečinky stavu agentov, ktorých vlákna sledovač vynechá. Predvolene
// každý súrodenec $AGENT_STATE s thread_id (~/.local/state/<meno>).
export function agentStates(cfg) {
  if (cfg.clearWatchAgents?.length) return cfg.clearWatchAgents;
  const root = dirname(cfg.state);
  let names = [];
  try { names = readdirSync(root); } catch { return [cfg.state]; }
  const dirs = names.map((n) => join(root, n)).filter((d) => existsSync(join(d, "thread_id")));
  return dirs.includes(cfg.state) ? dirs : [cfg.state, ...dirs];
}

// Vlákna agentov: aktuálne z thread_id, staré z rozbehnutého prechodu
// (rotation.json) a nahradené (retired_threads, zapisuje supervise.mjs).
export function agentThreadIds(cfg) {
  const ids = new Set();
  for (const dir of agentStates(cfg)) {
    try { ids.add(readFileSync(join(dir, "thread_id"), "utf8").trim()); } catch {}
    const rot = readJson(join(dir, "rotation.json"));
    if (rot?.oldThreadId) ids.add(rot.oldThreadId);
    try {
      for (const l of readFileSync(join(dir, "retired_threads"), "utf8").split("\n")) if (l.trim()) ids.add(l.trim());
    } catch {}
  }
  ids.delete("");
  return ids;
}

function send(client, kind, threadId, runId, text) {
  return client.dispatch({
    type: "message.dispatch",
    commandId: stableId(`clearwatch-${kind}`, threadId, runId),
    messageId: stableId(`clearwatch-${kind}-msg`, threadId, runId),
    createdBy: "user",
    creationSource: "web",
    threadId,
    text,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
  });
}

async function finish(client, p) {
  await send(client, "clear", p.threadId, p.runId, CLEAR_TEXT);
  if (p.dalej) await send(client, "cleared", p.threadId, p.runId, afterClearText(p.dalej));
}

// Vráti zoznam akcií { action, threadId, runId } tohto priechodu.
export async function watchStep(cfg, client, { now = Date.now() } = {}) {
  const path = statePath(cfg);
  const st = readJson(path);
  const shell = await client.http("GET", "/api/orchestration/shell");
  const threads = shell.threads ?? [];
  if (!st) {
    const checked = {};
    for (const t of threads) if (t.latestRunId) checked[t.id] = t.latestRunId;
    writeJsonAtomic(path, { baselineAt: new Date(now).toISOString(), checked, pending: {} });
    return [{ action: "baseline", count: Object.keys(checked).length }];
  }
  st.checked ??= {};
  st.pending ??= {};
  st.interrupted ??= {};
  const out = [];

  for (const p of Object.values(st.pending)) {
    try {
      await finish(client, p);
      out.push({ action: "cleared", threadId: p.threadId, runId: p.runId, resumed: true });
    } catch (e) {
      if (!e.rejected) throw e;
      out.push({ action: "rejected", threadId: p.threadId, runId: p.runId, error: e.message.slice(0, 200) });
    }
    delete st.pending[p.threadId];
    writeJsonAtomic(path, st);
  }

  const skip = agentThreadIds(cfg);
  const live = new Set(threads.map((t) => t.id));
  for (const id of Object.keys(st.checked)) if (!live.has(id)) delete st.checked[id];
  for (const id of Object.keys(st.interrupted)) if (!live.has(id)) delete st.interrupted[id];

  for (const t0 of threads) {
    const t = { ...t0, archived: false };
    if (skip.has(t.id) || t.archivedAt || t.deletedAt) continue;
    // Stojaci beh (supervise.mjs stalledRun): preruší sa raz na beh. Vlákno
    // s položkou running (sub-agent, príkaz) stalledRun nepreruší.
    if (t.activeRunId && st.interrupted[t.id] !== t.activeRunId) {
      const stalled = await interruptStalled(cfg, client, t.id, t, now);
      if (stalled) {
        st.interrupted[t.id] = stalled.runId;
        writeJsonAtomic(path, st);
        out.push({ action: "interrupt-stalled", threadId: t.id, runId: stalled.runId });
        continue;
      }
    }
    if (classifyEnd(t) !== "ok" || st.checked[t.id] === t.latestRunId) continue;
    if (threadBusy(t, now) || (t.pendingBackgroundTasks ?? []).length) continue;
    const runId = t.latestRunId;
    const detail = await client.threadDetail(t.id);
    const decision = decideClear(cfg, lastAgentText(detail, runId));
    if (decision) {
      // Medzitým mohla prísť správa a začať nový beh, /clear by potom prišiel
      // za ňu a vyčistil kontext uprostred práce. Beh sa neposúdi, ďalší
      // priechod posúdi ten nový.
      const fresh = await client.thread(t.id);
      if (!fresh || fresh.archived || fresh.latestRunId !== runId || threadBusy(fresh, now)) {
        continue;
      }
      const p = { threadId: t.id, runId, title: t.title ?? "", tokens: usedTokensOfRun(detail, runId), rezim: decision.rezim, dalej: decision.dalej };
      st.pending[t.id] = p;
      writeJsonAtomic(path, st);
      if (decision.handoff) markConsumed(decision.handoff);
      if (decision.warn) alert(cfg, `vlákno ${t.id}: ${decision.warn}`);
      try {
        await finish(client, p);
        out.push({ action: "cleared", threadId: t.id, runId });
      } catch (e) {
        if (!e.rejected) throw e;
        out.push({ action: "rejected", threadId: t.id, runId, error: e.message.slice(0, 200) });
      }
      delete st.pending[t.id];
    }
    st.checked[t.id] = runId;
    writeJsonAtomic(path, st);
  }
  writeJsonAtomic(path, st);
  return out;
}
