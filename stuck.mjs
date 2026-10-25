// Dozor nad visiacou požiadavkou na schválenie vo vlákne T3 (úloha 562).
// Vlákno vo full-access na schválenie nečaká, ale Claude Code má vstavanú
// kontrolu nebezpečného rm (circuitBreaker dangerousRemoval), ktorú
// bypassPermissions nevypne, a T3 takú požiadavku pošle človeku. Vlákno
// potom stojí, kým ju niekto nevyrieši (25. 10. 2026 štyri hodiny).
//
// Riadok vlákna z GET /api/orchestration/shell nesie pendingRuntimeRequest
// { id, kind, createdAt, blocking }, vek sa berie z createdAt. Dôvod a príkaz
// sú v detaile vlákna: položka approval_request (requestId, reason, prompt)
// a command_execution s rovnakým nativeItemRef.nativeId (input).
//
// Požiadavka staršia než cfg.stuckMs sa ohlási raz na id: výstraha
// (alert, alerts.log a ALERT_CMD) a správa do schránky iného agenta skriptom
// cfg.stuckAskCmd. Stav je $AGENT_STATE/stuck.json.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { alert, log, readJson, writeJsonAtomic } from "./lib.mjs";

const DEFAULT_MS = 10 * 60_000;
const MAX_TRIES = 5;
const KEEP_MS = 7 * 24 * 3600_000;

function statePath(cfg) { return join(cfg.state, "stuck.json"); }

// Príjemca správy: vlákno samotného príjemcu (budič jeho agenta) ide na
// záložného. Prázdny reťazec = nikto.
export function stuckRecipient(cfg) {
  const to = cfg.stuckAgent ?? "";
  if (!to) return "";
  if (to !== cfg.name) return to;
  const fb = cfg.stuckFallback ?? "";
  return fb && fb !== cfg.name ? fb : "";
}

const oneLine = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

// Dôvod a príkaz požiadavky z detailu vlákna. Chyba čítania ohlásenie
// nezdrží, údaje sú potom prázdne.
export async function requestInfo(client, threadId, requestId) {
  let items = [];
  try { items = (await client.threadDetail(threadId)).turnItems ?? []; } catch { return {}; }
  const ar = items.find((i) => i.type === "approval_request" && i.requestId === requestId)
    ?? items.filter((i) => i.type === "approval_request" && i.status !== "completed").at(-1);
  if (!ar) return {};
  const nativeId = ar.nativeItemRef?.nativeId;
  const cmd = nativeId ? items.find((i) => i.type === "command_execution" && i.nativeItemRef?.nativeId === nativeId) : null;
  return { reason: ar.reason ?? null, prompt: ar.prompt ?? null, command: cmd?.input ?? null, override: ar.fullAccessOverride ?? null };
}

export function stuckText(cfg, t, req, ageMin, info, agent) {
  return [
    `[budič ${cfg.name}] Vlákno T3 visí na schválení ${ageMin} min.`,
    `vlákno: ${t.id} (${oneLine(t.title, 120) || "bez názvu"})`,
    `agent: ${agent}`,
    `vek: ${ageMin} min, požiadavka ${req.kind ?? "?"} z ${req.createdAt}`,
    `dôvod: ${oneLine(info.reason, 300) || "neznámy"}${info.override ? ` (${info.override})` : ""}`,
    `príkaz: ${oneLine(info.command ?? info.prompt, 200) || "neznámy"}`,
    "",
    "Pošli operátorovi notifikáciu do telefónu (PushNotification), schváli v T3.",
  ].join("\n");
}

// Pošle správu do hlavného vlákna príjemcu. Vráti true pri kóde 0.
function ask(cfg, to, text) {
  const r = spawnSync(cfg.stuckAskCmd, ["--hlavne", to], {
    input: text,
    env: { ...process.env, AGENT_NAME: cfg.name ?? "" },
    timeout: 30000,
    stdio: ["pipe", "ignore", "pipe"],
  });
  if (r.status !== 0) log("stuck", `správa pre ${to} zlyhala (${r.status ?? r.signal}): ${String(r.stderr ?? "").slice(0, 300)}`);
  return r.status === 0;
}

// Jedno vlákno: ohlási visiacu požiadavku staršiu než prah. Vráti
// { action: "stuck-request", ... } alebo null. `agent` je text pre správu
// (meno agenta pri jeho hlavnom vlákne).
export async function stuckStep(cfg, client, t, now, { agent = "vlákno mimo hlavných vlákien agentov" } = {}) {
  const req = t?.pendingRuntimeRequest;
  if (!req?.id || t.archived || t.archivedAt || t.deletedAt) return null;
  const limit = cfg.stuckMs ?? DEFAULT_MS;
  if (!(limit > 0)) return null;
  const created = Date.parse(req.createdAt ?? "");
  if (!Number.isFinite(created) || now - created < limit) return null;

  const st = readJson(statePath(cfg)) ?? {};
  st.reported ??= {};
  for (const [id, r] of Object.entries(st.reported)) if (now - Date.parse(r.at ?? "") > KEEP_MS) delete st.reported[id];
  const rec = st.reported[req.id] ?? { at: new Date(now).toISOString(), threadId: t.id, alertedAt: null, askedAt: null, tries: 0 };
  const to = cfg.stuckAskCmd ? stuckRecipient(cfg) : "";
  const askDone = !to || rec.askedAt || rec.tries >= MAX_TRIES;
  if (rec.alertedAt && askDone) return null;

  const ageMin = Math.floor((now - created) / 60_000);
  const info = await requestInfo(client, t.id, req.id);
  const text = stuckText(cfg, t, req, ageMin, info, agent);
  if (!rec.alertedAt) {
    alert(cfg, `vlákno ${t.id} (${oneLine(t.title, 80)}) visí na schválení ${ageMin} min, požiadavka ${req.id.slice(0, 60)}: ${oneLine(info.reason, 150) || "dôvod neznámy"}; príkaz: ${oneLine(info.command ?? info.prompt, 100) || "neznámy"}`);
    rec.alertedAt = new Date(now).toISOString();
  }
  if (!askDone) {
    rec.tries++;
    if (ask(cfg, to, text)) { rec.askedAt = new Date(now).toISOString(); rec.to = to; }
  }
  st.reported[req.id] = rec;
  writeJsonAtomic(statePath(cfg), st);
  return { action: "stuck-request", threadId: t.id, requestId: req.id, ageMin, to: rec.askedAt ? to : null };
}
