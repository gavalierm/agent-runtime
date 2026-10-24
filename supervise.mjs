// Dozor nad vláknom agenta a čistý kontext. Volá ho driver.mjs v každom
// priechode pred doručením schránky. Model nevolá.
//
// Ako T3 Code v0.1.0 končí beh (zdroj, cesty v README.md runtime):
// - riadne: run.status "completed"
// - chyba poskytovateľa alebo zabitý proces claude: "failed", trieda
//   v lastErrorClass (zabitý proces je transport_error)
// - limit predplatného: "failed" s lastErrorClass "usage_limit" a
//   usageLimitResetAt, to nie je pád
// - Stop alebo run.interrupt: "interrupted" a vo vlákne položka
//   run_interrupt_request s runId behu, to je zámer človeka, nie pád
// - zabitý alebo reštartovaný T3 server: obnova pri štarte dá
//   rozbehnutému behu "cancelled" (startedAt nie je null). T3 sám môže
//   pokračovať správou "Continue where you left off." (najviac 3 za sebou),
//   preto budič čaká AGENT_WAKE_DELAY_S od konca behu.
//
// Stav je v $AGENT_STATE: supervise.json (dozor aktuálneho vlákna),
// rotation.json (rozbehnutý čistý kontext), alerts.log.
import { appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { alert, readJson, stableId, writeJsonAtomic } from "./lib.mjs";
import { datedTitle, launchAgentThread, startPrompt, writeThreadId } from "./start_agent.mjs";
import { afterClearText, decideClear, DONE_WORD, markConsumed, parseDoneLine } from "./kontext.mjs";

export { DONE_WORD };

const TERMINAL = ["idle", "completed", "interrupted", "failed", "cancelled", "rolled_back"];

// Beh, ktorý ešte nedobehol, alebo vlákno čakajúce na človeka. Budič do
// takého vlákna nepíše a dozor ho neposudzuje.
export function threadActive(t) {
  if (!t) return "vlákno neexistuje";
  if (t.archived) return "vlákno je archivované";
  if (t.activeRunId) return `beží ${t.activeRunId}`;
  if (t.activityRunStatus) return `beh ${t.activityRunStatus}`;
  if (t.pendingRuntimeRequest) return "čaká na schválenie vo vlákne";
  if (!TERMINAL.includes(t.status)) return `stav ${t.status}`;
  return null;
}

// Druh konca posledného behu podľa riadku vlákna z /api/orchestration/shell.
// "interrupted" bez detailu nevie, či prerušil človek, to rozhodne
// interruptRequested nad detailom.
export function classifyEnd(t) {
  if (!t?.latestRunId) return "none";
  switch (t.status) {
    case "completed": return "ok";
    case "failed": return t.lastErrorClass === "usage_limit" ? "limit" : "crash";
    case "cancelled": return t.latestRunStartedAt ? "crash" : "none";
    case "interrupted": return "interrupted";
    default: return "none";
  }
}

export function interruptRequested(detail, runId) {
  return (detail?.turnItems ?? []).some((i) => i.type === "run_interrupt_request" && i.runId === runId);
}

// usedTokens posledného ťahu poskytovateľa v behu runId. Pri Claude je to
// vstup vrátane cache plus výstup posledného volania API, teda obsadenie
// kontextu (ClaudeAdapterV2.ts claudeProviderTurnTokenUsage), po kompakcii
// post_tokens. Ťah sa vyberá podľa activeAttemptId behu ako
// latestProviderTurnForAttempt v orchestrationV2.ts.
export function usedTokensOfRun(detail, runId) {
  const run = (detail?.runs ?? []).find((r) => r.id === runId);
  if (!run) return null;
  let latest = null;
  for (const turn of detail.providerTurns ?? []) {
    if (run.activeAttemptId == null || turn.runAttemptId !== run.activeAttemptId) continue;
    if (!latest || turn.ordinal > latest.ordinal) latest = turn;
  }
  return latest?.tokenUsage?.usedTokens ?? null;
}

// Text poslednej odpovede agenta v behu runId z detailu vlákna. Riadok
// shell má latestVisibleMessage v T3 0.1.0 null (overené 18. 10. 2026),
// preto sa číta detail, kde správa nesie runId.
export function lastAgentText(detail, runId) {
  const own = (detail?.messages ?? []).filter((m) => m.role === "assistant" && m.runId === runId);
  return own.length ? String(own.at(-1).text ?? "") : "";
}

// Beh, ktorý žije, ale nič nerobí: activeRunId, žiadna položka behu v stave
// running a posledná položka behu staršia než prah. Prípad 23. 10. 2026:
// beh otvorila notifikácia o skončení sub-agenta, Claude na ňu nevydal ťah
// a beh stál 52 minút, správy budiča čakali v rade. Položka running
// (príkaz, sub-agent) beh drží nažive, čaká sa aj na schválenie a na vlákno.
// Vráti { runId, idleMs } alebo null.
export function stalledRun(t, detail, now, thresholdMs) {
  const runId = t?.activeRunId;
  if (!runId || t.pendingRuntimeRequest || t.blockedOnThreadWait) return null;
  const items = (detail?.turnItems ?? []).filter((i) => i.runId === runId);
  if (items.some((i) => i.status === "running")) return null;
  const times = items.map((i) => Date.parse(i.updatedAt ?? i.completedAt ?? i.startedAt ?? "")).filter(Number.isFinite);
  const last = times.length ? Math.max(...times) : Date.parse(t.activityRunStartedAt ?? t.latestRunStartedAt ?? "");
  if (!Number.isFinite(last) || now - last < thresholdMs) return null;
  return { runId, idleMs: now - last };
}

// Preruší stojaci beh príkazom run.interrupt, T3 zapíše položku
// run_interrupt_request, takže koniec je zámer a nie pád (classifyEnd,
// interruptRequested) a správy v rade pokračujú. Raz na beh.
// Spoločné jadro: preruší beh vlákna, ak stojí (stalledRun). Vráti stojaci
// beh alebo null; stav "už prerušené" drží volajúci.
export async function interruptStalled(cfg, client, threadId, t, now) {
  const idleMs = cfg.stalledMs ?? 10 * 60_000;
  if (!t?.activeRunId || !(idleMs > 0)) return null;
  // Detail vlákna je drahý (tisíce položiek), vlákno zmenené v rámci prahu
  // stáť nemôže.
  const touched = Date.parse(t.updatedAt ?? "");
  if (Number.isFinite(touched) && now - touched < idleMs) return null;
  const stalled = stalledRun(t, await client.threadDetail(threadId), now, idleMs);
  if (!stalled) return null;
  await client.dispatch({
    type: "run.interrupt",
    commandId: stableId("agent-stalled", threadId, stalled.runId),
    threadId,
    runId: stalled.runId,
    reason: `budič: beh ${Math.round(stalled.idleMs / 60000)} min bez činnosti`,
  });
  alert(cfg, `vlákno ${threadId}: beh ${stalled.runId} stál ${Math.round(stalled.idleMs / 60000)} min bez činnosti (žiadna položka running), budič ho prerušil.`);
  return stalled;
}

export async function stalledStep(cfg, client, threadId, t, now) {
  if (!t?.activeRunId) return null;
  const s = loadSupervise(cfg, threadId);
  if (s.interruptedRunId === t.activeRunId) return null;
  const stalled = await interruptStalled(cfg, client, threadId, t, now);
  if (!stalled) return null;
  s.interruptedRunId = stalled.runId;
  saveSupervise(cfg, s);
  return { action: "interrupt-stalled", runId: stalled.runId };
}

export function heldQueue(detail) {
  return (detail?.runs ?? []).some((r) => r.status === "queued" && r.queueHeld === true);
}

function supPath(cfg) { return join(cfg.state, "supervise.json"); }
function rotPath(cfg) { return join(cfg.state, "rotation.json"); }

export function loadSupervise(cfg, threadId) {
  const s = readJson(supPath(cfg));
  if (s && s.threadId === threadId) return s;
  return { threadId, judgedRunId: null, wakes: [], halted: false, ctxCheckedRunId: null };
}

function saveSupervise(cfg, s) { writeJsonAtomic(supPath(cfg), s); }

function dispatchText(client, threadId, kind, key, text) {
  return client.dispatch({
    type: "message.dispatch",
    commandId: stableId(`agent-${kind}`, threadId, ...key),
    messageId: stableId(`agent-${kind}-msg`, threadId, ...key),
    createdBy: "user",
    creationSource: "web",
    threadId,
    text,
    attachments: [],
    dispatchMode: { type: "queue_after_active" },
  });
}

export function wakeText(t) {
  const err = t.lastError ? `, chyba: ${t.lastErrorClass ?? "?"}: ${String(t.lastError).slice(0, 300)}` : "";
  return [
    `[budič] Posledný beh tohto vlákna neskončil riadne (stav ${t.status}${err}).`,
    "Pokračuj v rozpracovanej práci podľa pamäte a stavu práce (git status, súbory tém, schránka).",
    "Keď nie je čo dokončiť, odpovedz jednou vetou.",
  ].join("\n");
}

export const LIMIT_TEXT = [
  "[budič] Limit predplatného skončil.",
  "Pokračuj v rozpracovanej práci podľa pamäte a stavu práce. Keď nie je čo dokončiť, odpovedz jednou vetou.",
].join("\n");

export const CLEAR_TEXT = "/clear";

// Náhradné nové vlákno (T3 odmietol /clear) potrebuje úvodnú správu, preto je
// to jediné miesto, kde ostáva startPrompt. Pri pokracuj nesie ďalší krok.
export function continueText(cfg, rot) {
  const tokens = rot.tokens;
  return [
    startPrompt(cfg.title, cfg.replyCmd),
    "",
    `Toto vlákno nahradilo vlákno ${rot.oldThreadId}${tokens ? `, ktoré malo ${tokens} tokenov kontextu,` : ""} na slovo ${DONE_WORD}, lebo T3 odmietol /clear. Staré ostáva v T3 na čítanie.`,
    ...(rot.stav ? [`Stav: ${rot.stav}`] : []),
    rot.dalej ? `Ďalší krok: ${rot.dalej}` : "Nič nerozpracované, čakaj na ďalšiu správu.",
  ].join("\n");
}

// Dozor nad posledným behom voľného vlákna. Vráti
// { action } keď niečo poslal, { block } keď schránka musí počkať,
// inak null a budič pokračuje schránkou.
export async function superviseStep(cfg, client, threadId, t, now) {
  const kind = classifyEnd(t);
  const runId = t.latestRunId;
  const s = loadSupervise(cfg, threadId);

  if (kind === "ok") {
    if (s.halted) { s.halted = false; saveSupervise(cfg, s); }
    return null;
  }

  if (kind === "limit") {
    const reset = t.usageLimitResetAt ? Date.parse(t.usageLimitResetAt) : NaN;
    if (!(reset <= now)) return { block: `limit predplatného do ${t.usageLimitResetAt ?? "neznámo"}` };
    if (s.judgedRunId === runId) return null;
    // T3 vie po resete pokračovať sám (UsageLimitRecoveryWorker), dáme mu čas.
    if (now < reset + cfg.limitGraceMs) return { block: "limit skončil, čakám, či T3 pokračuje sám" };
    await dispatchText(client, threadId, "limit", [runId], LIMIT_TEXT);
    s.judgedRunId = runId;
    saveSupervise(cfg, s);
    return { action: "limit", runId };
  }

  let crash = kind === "crash";
  if (kind === "interrupted" && cfg.wakeOnInterrupt && s.judgedRunId !== runId) {
    crash = !interruptRequested(await client.threadDetail(threadId), runId);
    if (!crash) { s.judgedRunId = runId; saveSupervise(cfg, s); }
  }
  if (!crash || s.judgedRunId === runId || s.halted) return null;

  s.wakes = s.wakes.filter((at) => now - at < cfg.wakeWindowMs);
  if (s.wakes.length >= cfg.wakeMax) {
    s.halted = true;
    s.judgedRunId = runId;
    saveSupervise(cfg, s);
    alert(cfg, `vlákno ${threadId} spadlo ${s.wakes.length + 1}. raz za ${Math.round(cfg.wakeWindowMs / 60000)} min (beh ${runId}, stav ${t.status}, ${t.lastErrorClass ?? "bez triedy"}: ${String(t.lastError ?? "").slice(0, 200)}). Budič ďalej nebudí, kým beh neskončí riadne.`);
    return { action: "halt", runId };
  }
  const ended = Date.parse(t.latestRunCompletedAt ?? "") || now;
  const due = ended + cfg.wakeDelayMs * 2 ** s.wakes.length;
  if (now < due) return { block: `beh ${runId} spadol (${t.status}), budím o ${Math.ceil((due - now) / 1000)} s` };
  await dispatchText(client, threadId, "wake", [runId], wakeText(t));
  s.wakes.push(now);
  s.judgedRunId = runId;
  saveSupervise(cfg, s);
  return { action: "wake", runId, attempt: s.wakes.length };
}

// Agent sám ukončí odpoveď riadkom HOTOVO-KONTEXT, keď je nad hranicou
// hooku context_warning.mjs repa agent-rules a rozpracované má v pamäti.
// Budič ho nevyzýva, výzva stála celý ťah navyše (čistý kontext na
// slovo agenta, 2026-10-18). Riadok platí len
// ako posledný neprázdny riadok odpovede, citát v texte prechod nespustí.
// Tvar riadku a odovzdávka sú v kontext.mjs (úloha 420).
export function endsWithDoneWord(text) {
  return parseDoneLine(text) !== null;
}

// Po riadne skončenom behu: slovo agenta, prípadne zadržaný front správ.
export async function contextStep(cfg, client, threadId, t, now) {
  if (classifyEnd(t) !== "ok") return null;
  const s = loadSupervise(cfg, threadId);
  if (s.ctxCheckedRunId === t.latestRunId) return null;
  const detail = await client.threadDetail(threadId);
  s.ctxCheckedRunId = t.latestRunId;
  const decision = decideClear(cfg, lastAgentText(detail, t.latestRunId));
  if (decision) {
    if (decision.warn) alert(cfg, `vlákno ${threadId}: ${decision.warn}`);
    const rot = {
      phase: "clear",
      oldThreadId: threadId,
      fromRunId: t.latestRunId,
      tokens: usedTokensOfRun(detail, t.latestRunId),
      startedAt: now,
      projectId: t.projectId,
      modelSelection: t.modelSelection,
      runtimeMode: t.runtimeMode,
      interactionMode: t.interactionMode ?? "default",
      mode: decision.rezim,
      dalej: decision.dalej,
      stav: decision.stav,
    };
    writeJsonAtomic(rotPath(cfg), rot);
    // Odovzdávka sa označí až po zápise rotation.json, pád medzi tým nestratí krok.
    if (decision.handoff) markConsumed(decision.handoff);
    saveSupervise(cfg, s);
    return rotationStep(cfg, client, threadId, t, now);
  }
  if (heldQueue(detail)) {
    // Obnova po reštarte T3 alebo chyba behu zadrží front (queueHeld). Bez
    // queue.resume by správy v ňom čakali na človeka.
    await client.dispatch({ type: "queue.resume", commandId: stableId("agent-resume", threadId, t.latestRunId), threadId });
    saveSupervise(cfg, s);
    return { action: "resume-queue" };
  }
  saveSupervise(cfg, s);
  return null;
}

// Rozbehnutý čistý kontext: /clear v tom istom vlákne, náhradou nové
// vlákno, keď T3 /clear odmietne. T3 0.1.0 po /clear neaktualizuje
// nativeThreadRef.nativeId vlákna a ďalší proces claude ide s --resume na
// reláciu spred /clear. Starý kontext sa nevráti vďaka hooku
// hooku clear_bridge.mjs repa pravidiel, ktorý pri SessionStart so source
// "clear" nahradí prepis pôvodnej relácie odkazom na novú (/clear v T3
// cez most prepisu, 2026-10-18).
// Vráti { action } alebo { block }, null keď prechod nie je.
export async function rotationStep(cfg, client, threadId, t, now) {
  const rot = readJson(rotPath(cfg));
  if (!rot) return null;
  if (rot.oldThreadId !== threadId) {
    // thread_id už ukazuje na náhradné nové vlákno, budič spadol pred
    // zmazaním súboru.
    await stopOldSession(cfg, client, rot.oldThreadId);
    rmSync(rotPath(cfg), { force: true });
    return null;
  }
  if (rot.phase === "clear") {
    try {
      await dispatchText(client, threadId, "clear", [rot.fromRunId], CLEAR_TEXT);
      // Spanok: len /clear, model sa nevolá. Pokračuj: jedna krátka správa.
      if (rot.mode === "pokracuj" && rot.dalej) {
        await dispatchText(client, threadId, "cleared", [rot.fromRunId], afterClearText(rot.dalej));
      }
    } catch (e) {
      if (!e.rejected) throw e;
      alert(cfg, `vlákno ${threadId}: T3 odmietol /clear (${e.message.slice(0, 200)}), čistý kontext robím novým vláknom.`);
      rot.phase = "launch";
      rot.launchCommandId = stableId("agent-rotate", rot.oldThreadId, rot.fromRunId);
      rot.title = datedTitle(cfg.title, new Date(now));
      writeJsonAtomic(rotPath(cfg), rot);
    }
    if (rot.phase === "clear") {
      // Vlákno ostáva, relácia sa nezastavuje.
      rmSync(rotPath(cfg), { force: true });
      return { action: "cleared", threadId };
    }
  }
  if (rot.phase === "launch") {
    const newThreadId = await launchAgentThread(client, {
      commandId: rot.launchCommandId,
      projectId: rot.projectId,
      title: rot.title,
      modelSelection: rot.modelSelection,
      runtimeMode: rot.runtimeMode,
      interactionMode: rot.interactionMode,
      text: continueText(cfg, rot),
    });
    // Staré vlákno končí slovom HOTOVO-KONTEXT. Sledovač ostatných vlákien
    // (clear_watch.mjs) by mu inak poslal /clear a pokračovanie a v starom
    // vlákne by bežal druhý agent.
    appendFileSync(join(cfg.state, "retired_threads"), `${rot.oldThreadId}\n`, { mode: 0o600 });
    writeThreadId(cfg.state, newThreadId);
    await stopOldSession(cfg, client, rot.oldThreadId);
    rmSync(rotPath(cfg), { force: true });
    return { action: "rotated", oldThreadId: rot.oldThreadId, threadId: newThreadId };
  }
  return { block: `prechod: neznáma fáza ${rot.phase}` };
}

// Po náhradnom prechode na nové vlákno by proces claude starého vlákna
// ostal bežať nečinný, každý prechod by pridal jeden (18. 10. 2026 tri také procesy). Zastaví sa len
// staré vlákno z rotation.json a len bez bežiaceho ťahu: do starého vlákna
// môže medzitým písať človek. Relácia poskytovateľa má počas ťahu stav
// "ready", preto rozhoduje riadok vlákna a behy z detailu. Vlákno ostane na
// čítanie, nearchivuje sa. Zlyhanie ani preskočenie prechod nezastaví,
// ide do výstrahy.
export async function stopOldSession(cfg, client, oldThreadId) {
  try {
    const t = await client.thread(oldThreadId);
    if (!t) return null;
    let busy = threadActive(t);
    if (!busy) {
      const run = ((await client.threadDetail(oldThreadId)).runs ?? []).find((r) => !TERMINAL.includes(r.status));
      if (run) busy = `beh ${run.id} v stave ${run.status}`;
    }
    if (busy) {
      alert(cfg, `prechod: reláciu starého vlákna ${oldThreadId} nezastavujem, ${busy}`);
      return null;
    }
    return await client.stopThreadSession(oldThreadId);
  } catch (e) {
    alert(cfg, `prechod: zastavenie relácie starého vlákna ${oldThreadId} zlyhalo: ${e.message}`);
    return null;
  }
}
