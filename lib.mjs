// Spoločné časti runtime agenta na serveri: nastavenie, schránka a klient
// T3 Code servera v0.1.0. Node 22, bez npm závislostí.
//
// Rozhranie T3 je overené naživo 18. 10. 2026: čítanie cez REST, zápis cez WebSocket /ws
// s lístkom z POST /api/auth/websocket-ticket a správami
// Request/Chunk/Ack/Exit/Ping/Pong z Effect RPC.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOME = process.env.HOME || homedir();

// Nastavenie agenta z prostredia. Runtime nesie meno agenta (AGENT_NAME,
// predvolene agent) a z neho odvodí cesty. Ostatné premenné AGENT_* ich
// prepíšu, zoznam je v README.md.
function defaultWorkRepos(home) {
  const repos = ["tasker", "agent-rules", "agent-runtime"].map((d) => join(home, d));
  try {
    for (const d of readdirSync(home)) if (!repos.includes(join(home, d)) && existsSync(join(home, d, "PERSONA.md"))) repos.push(join(home, d));
  } catch { /* domovský priečinok sa nedá čítať */ }
  return repos;
}

export function config(env = process.env) {
  const name = env.AGENT_NAME || "agent";
  const pick = (key, fallback) => env[`AGENT_${key}`] || fallback;
  const home = env.HOME || HOME;
  const taskerHome = env.TASKER_HOME || join(home, ".tasker");
  return {
    name,
    title: env.AGENT_TITLE || name.charAt(0).toUpperCase() + name.slice(1),
    box: pick("BOX", `/var/lib/${name}`),
    state: pick("STATE", join(home, `.local/state/${name}`)),
    // Zoznam tém (route.mjs), predvolene $AGENT_BOX/topics.json.
    topicsFile: pick("TOPICS_FILE", undefined),
    workdir: pick("WORKDIR", join(home, `agenti/${name}`)),
    model: pick("MODEL", undefined),
    t3Instance: pick("T3_INSTANCE", "claudeAgent"),
    runtimeMode: pick("RUNTIME_MODE", "auto"),
    replyCmd: env.AGENT_REPLY_CMD || `AGENT_NAME=${name} ${env.AGENT_RUNTIME ? env.AGENT_RUNTIME + "/" : ""}reply.sh`,
    // Adresa T3 servera. Vlákna založené cez MCP T3_URL nededia, preto ho treba
    // mať v runtime.env každého agenta, inak platí lokálny port.
    t3Url: (env.T3_URL || "http://127.0.0.1:3773").replace(/\/$/, ""),
    t3TokenFile: env.T3_TOKEN_FILE || join(home, `.config/${name}/t3_token`),
    taskerDb: env.TASKER_DB || join(taskerHome, "tasker.db"),
    taskerBin: env.TASKER_BIN || "/opt/tasker/bin/tasker",
    taskerHome,
    // Príkaz, ktorým budič zapíše do Taskera trasu doručenej správy (`route <id> --thread ...`,
    // úloha 486). Prázdna hodnota zápis vypne, cfg bez `routeCmd` (testy) ho nerobí.
    routeCmd: env.AGENT_ROUTE_CMD ?? "/opt/agent-rules/bin/tk",
    // Klon repa pravidiel, z ktorého ranný súhrn číta nové rozhodnutia (úloha 470).
    rulesRepo: env.AGENT_RULES_REPO || "/opt/agent-rules",
    // Repá, z ktorých ranný súhrn počíta commity za 24 h po autorovi (workSection).
    // Predvolene tri repá a každý priečinok pod domovským, ktorý nesie PERSONA.md (klon agenta).
    workRepos: env.AGENT_WORK_REPOS
      ? env.AGENT_WORK_REPOS.split(",").map((x) => x.trim()).filter(Boolean)
      : defaultWorkRepos(home),
    pollMs: Number(pick("POLL_S", 5)) * 1000,
    // Sledovač čistého kontextu ostatných vlákien T3 (clear_watch.mjs), na
    // jednom T3 serveri zapnutý len v budiči jedného agenta.
    clearWatch: (env.AGENT_CLEAR_WATCH ?? "0") === "1",
    // Odovzdávky čistého kontextu od kontext.sh (kontext.mjs), rovnaký
    // adresár ako v skripte.
    kontextDir: env.KONTEXT_DIR || join(home, ".local/state/kontext"),
    clearWatchAgents: (env.AGENT_CLEAR_WATCH_AGENTS || "").split(":").filter(Boolean),
    // Schránky, z ktorých ranný súhrn odnáša držané správy na vedomie:
    // AGENT_SWEEP_BOXES (zoznam cez dvojbodku), inak vlastná schránka a
    // schránky z AGENT_REPLY_ROUTE_<meno>.
    sweepBoxes: sweepBoxes(env, pick("BOX", `/var/lib/${name}`)),
    ...superviseConfig(env),
    ...inboxConfig(env),
  };
}

export function sweepBoxes(env, own) {
  if (env.AGENT_SWEEP_BOXES) return env.AGENT_SWEEP_BOXES.split(":").filter(Boolean);
  const routes = Object.entries(env)
    .filter(([k, v]) => /^AGENT_REPLY_ROUTE_/.test(k) && v)
    .map(([, v]) => dirname(v.replace(/\/$/, "")));
  return [...new Set([own, ...routes])];
}

// Budenie: držanie správ na vedomie a tiché okno dávky, opis v README.md,
// časť Budenie. Predvolené hodnoty platia aj pre cfg bez týchto polí.
export function inboxConfig(env = {}) {
  const num = (key, fallback) => (env[key] === undefined || env[key] === "" ? fallback : Number(env[key]));
  return {
    batchWaitMs: num("AGENT_BATCH_WAIT_S", 30) * 1000,
    batchMaxWaitMs: num("AGENT_BATCH_MAX_WAIT_S", 120) * 1000,
  };
}

// Prvý riadok správy nesie, čo odosielateľ od nej čaká: `odpoveď: čakám`,
// `odpoveď: nečakám` alebo `odpoveď: na vedomie`. Odpoveď má druhý riadok
// `k správe: <hodnota pôvodnej správy>`. Riadky píšu skripty, nie model.
export const MODES = ["čakám", "nečakám", "na vedomie"];

export function normalizeMode(s) {
  const v = String(s ?? "").trim().toLowerCase();
  if (["čakám", "cakam", "cakám", "čakam"].includes(v)) return "čakám";
  if (["nečakám", "necakam", "necakám", "nečakam"].includes(v)) return "nečakám";
  if (["na vedomie", "vedomie", "navedomie"].includes(v)) return "na vedomie";
  return null;
}

// Rozloží text správy na hlavičku a telo. mode a original sú null, keď
// riadok chýba alebo nesie neznámu hodnotu, telo potom ostane celé.
// Po riadku režimu (a `k správe:`) môže nasledovať blok riadkov `id:`,
// `od:`, `komu:`, `téma:` a `k:` (id pôvodnej správy, na ktorú toto
// odpovedá), ktoré píšu skripty. meta je null, keď blok chýba. Dnešný
// `k správe:` nesie pôvodný režim, `k:` nesie id pôvodnej správy.
const META_KEYS = { "id": "id", "od": "od", "komu": "komu", "téma": "tema", "k": "k" };
export function parseHeader(text) {
  const lines = String(text).split("\n");
  let mode = null;
  let original = null;
  let meta = null;
  let i = 0;
  const m1 = lines[0]?.match(/^odpoveď:\s*(.+)$/i);
  if (m1 && normalizeMode(m1[1])) { mode = normalizeMode(m1[1]); i = 1; }
  const m2 = lines[i]?.match(/^k správe:\s*(.+)$/i);
  if (i === 1 && m2 && normalizeMode(m2[1])) { original = normalizeMode(m2[1]); i = 2; }
  if (i >= 1) {
    for (let m; (m = lines[i]?.match(/^(id|od|komu|téma|k):[ \t]*(.*)$/)); i++) {
      meta ??= {};
      meta[META_KEYS[m[1]]] = m[2].trim();
    }
  }
  return { mode, original, meta, body: lines.slice(i).join("\n") };
}

export function headerLines(mode, original = null) {
  const out = [];
  if (mode) out.push(`odpoveď: ${mode}`);
  if (mode && original) out.push(`k správe: ${original}`);
  return out;
}

// Dozor a čistý kontext, opis v README.md. Predvolené hodnoty platia aj
// pre cfg bez týchto polí (testy, staršie volania).
export function superviseConfig(env = {}) {
  const num = (key, fallback) => (env[key] === undefined || env[key] === "" ? fallback : Number(env[key]));
  return {
    wakeMax: num("AGENT_WAKE_MAX", 3),
    wakeWindowMs: num("AGENT_WAKE_WINDOW_S", 3600) * 1000,
    wakeDelayMs: num("AGENT_WAKE_DELAY_S", 60) * 1000,
    wakeOnInterrupt: (env.AGENT_WAKE_ON_INTERRUPT ?? "1") !== "0",
    limitGraceMs: num("AGENT_LIMIT_GRACE_S", 120) * 1000,
    stalledMs: num("AGENT_STALLED_S", 600) * 1000,
    alertCmd: env.ALERT_CMD || "",
  };
}

export function log(name, text) {
  process.stderr.write(`${name}: ${text}\n`);
}

// Výstraha: riadok do $STATE/alerts.log a, keď je nastavený, príkaz
// ALERT_CMD cez sh s textom na stdin a v premennej ALERT_TEXT. Zlyhanie
// príkazu výstrahu nezastaví, ostane v logu služby.
export function alert(cfg, text) {
  const line = `${new Date().toISOString()} ${cfg.name ?? "agent"}: ${text}`;
  try {
    ensureDir(cfg.state);
    appendFileSync(join(cfg.state, "alerts.log"), line + "\n", { mode: 0o600 });
  } catch (e) {
    log("alert", `zápis alerts.log zlyhal: ${e.message}`);
  }
  log("alert", text);
  if (!cfg.alertCmd) return;
  const r = spawnSync("sh", ["-c", cfg.alertCmd], {
    input: line + "\n",
    env: { ...process.env, ALERT_TEXT: text, AGENT_NAME: cfg.name ?? "" },
    timeout: 30000,
    stdio: ["pipe", "ignore", "pipe"],
  });
  if (r.status !== 0) log("alert", `ALERT_CMD skončil ${r.status ?? r.signal}: ${String(r.stderr ?? "").slice(0, 300)}`);
}

// Meno súboru v schránke: <odosielateľ>-[<téma>-]<YYYYMMDD-HHMMSS>-<pid>.md
// ako v schránke iného agenta. Iné meno budič nečíta.
export const NAME_RE = /^[a-z][a-z0-9_]{0,30}-[A-Za-z0-9._-]{1,120}$/;

export function parseName(name) {
  const sender = name.slice(0, name.indexOf("-"));
  const rest = name.slice(sender.length + 1);
  const m = rest.match(/^([a-z][a-z0-9_]*)-[0-9]/);
  return { sender, topic: m ? m[1] : null };
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Zapíše správu do schránky: najprv skrytý dočasný súbor, potom rename,
// budič tak nikdy nevidí polovičný súbor. Vráti meno správy.
export function writeInbox(box, sender, text, topic = null, mode = null) {
  const name = `${sender}-${topic ? topic + "-" : ""}${stamp()}-${process.pid}-${randomUUID().slice(0, 8)}.md`;
  const dir = join(box, "inbox");
  const tmp = join(dir, `.${name}.tmp`);
  const head = headerLines(normalizeMode(mode)).map((l) => l + "\n").join("");
  writeFileSync(tmp, head + (text.endsWith("\n") ? text : text + "\n"), { mode: 0o660 });
  renameSync(tmp, join(dir, name));
  return name;
}

// Správy v inboxe v poradí príchodu (mtime, potom meno).
export function inboxEntries(box) {
  const dir = join(box, "inbox");
  return readdirSync(dir)
    .filter((n) => !n.startsWith(".") && !n.endsWith(".tmp") && NAME_RE.test(n))
    .map((n) => ({ name: n, mtime: statSync(join(dir, n)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime || (a.name < b.name ? -1 : 1));
}

export function listInbox(box) {
  return inboxEntries(box).map((x) => x.name);
}

export function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

export function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 1) + "\n", { mode: 0o600 });
  renameSync(tmp, path);
}

// Mutex: úlohy zadané cez run(fn) bežia po jednej v poradí zadania. Chyba
// jednej úlohy ďalšiu nezastaví, run vráti jej výsledok alebo chybu.
export function serial() {
  let tail = Promise.resolve();
  return (fn) => {
    const p = tail.then(fn);
    tail = p.catch(() => {});
    return p;
  };
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

// Stabilné id odvodené z obsahu. T3 si pamätá príjem každého commandId
// (receipt v Orchestrator.ts), opakované poslanie s tým istým id nevytvorí
// druhú správu.
export function stableId(prefix, ...parts) {
  return `${prefix}-${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32)}`;
}

export class T3Error extends Error {
  // rejected=true znamená, že server príkaz odmietol (Exit Failure). Inak
  // je to chyba spojenia a nevieme, či príkaz prišiel.
  constructor(message, { rejected = false } = {}) {
    super(message);
    this.rejected = rejected;
  }
}

export class T3Client {
  constructor({ url, token, timeoutMs = 30000 }) {
    this.url = url;
    this.token = token;
    this.timeoutMs = timeoutMs;
  }

  static fromConfig(cfg) {
    const token = readFileSync(cfg.t3TokenFile, "utf8").trim();
    return new T3Client({ url: cfg.t3Url, token });
  }

  headers(json) {
    return {
      authorization: `Bearer ${this.token}`,
      "x-t3-orchestration-protocol": "2",
      ...(json ? { "content-type": "application/json" } : {}),
    };
  }

  async http(method, path, body) {
    let res;
    try {
      res = await fetch(this.url + path, {
        method,
        headers: this.headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new T3Error(`${method} ${path}: ${e.message}`);
    }
    const text = await res.text();
    if (!res.ok) throw new T3Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`, { rejected: res.status >= 400 && res.status < 500 });
    try { return JSON.parse(text); } catch { throw new T3Error(`${method} ${path}: odpoveď nie je JSON`); }
  }

  async shell() {
    return await this.http("GET", "/api/orchestration/shell");
  }

  // Riadok vlákna zo shellu s poľom archived, null keď vlákno neexistuje.
  static threadFromShell(shell, threadId) {
    const active = (shell.threads ?? []).find((t) => t.id === threadId);
    if (active) return { ...active, archived: false };
    const archived = (shell.archivedThreads ?? []).find((t) => t.id === threadId);
    return archived ? { ...archived, archived: true } : null;
  }

  async thread(threadId) {
    return T3Client.threadFromShell(await this.shell(), threadId);
  }

  // Vlákno projektu, ktorého providerThreads majú nativeThreadRef.nativeId
  // z daných id (id relácie claude). Vlákna sub-agentov (thread:provider:)
  // a vlákna mcp: s rodičom preskočí, tie patria svojmu rodičovi. Samostatné
  // vlákno mcp: (t3_thread_launch, napríklad vlákno témy) sa prehľadáva.
  // Nearchivované najprv.
  async threadForNativeId(ids) {
    const shell = await this.shell();
    const rows = [...(shell.threads ?? []), ...(shell.archivedThreads ?? [])].filter((t) => t.id.startsWith("thread:project:") || (t.id.startsWith("mcp:") && !t.parentThreadId));
    for (const t of rows) {
      const detail = await this.threadDetail(t.id);
      for (const pt of detail.providerThreads ?? []) {
        const nativeId = pt.nativeThreadRef?.nativeId;
        if (nativeId && ids.includes(nativeId)) return { threadId: t.id, nativeId };
      }
    }
    return null;
  }

  // Projekcia vlákna s úplnými poľami runs a providerTurns a len posledným
  // oknom časovej osi (threadHistoryPaging.ts buildBoundedThreadProjection).
  async threadDetail(threadId) {
    const r = await this.http("GET", `/api/orchestration/threads/${encodeURIComponent(threadId)}/bounded`);
    return r.projection ?? r;
  }

  async projects() {
    return (await this.http("GET", "/api/projects")).projects ?? [];
  }

  async createProject({ title, workspaceRoot }) {
    return await this.http("POST", "/api/projects/mutate", {
      type: "project.create", commandId: randomUUID(), projectId: randomUUID(),
      title, workspaceRoot, createWorkspaceRootIfMissing: false,
    });
  }

  // Jedno volanie Effect RPC cez /ws. Vráti hodnotu z Exit Success.
  async rpc(tag, payload) {
    const t = await this.http("POST", "/api/auth/websocket-ticket");
    const wsUrl = this.url.replace(/^http/, "ws") + `/ws?orchestrationProtocol=2&wsTicket=${encodeURIComponent(t.ticket)}`;
    const ws = new WebSocket(wsUrl);
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { ws.close(); } catch {}
        fn(v);
      };
      const timer = setTimeout(() => finish(reject, new T3Error(`${tag}: bez odpovede do ${this.timeoutMs} ms`)), this.timeoutMs);
      ws.onopen = () => ws.send(JSON.stringify({ _tag: "Request", id: "1", tag, payload, headers: [] }));
      ws.onerror = (e) => finish(reject, new T3Error(`${tag}: chyba WebSocket ${e.message ?? ""}`));
      ws.onclose = (e) => finish(reject, new T3Error(`${tag}: spojenie zatvorené ${e.code} ${e.reason ?? ""}`));
      ws.onmessage = (ev) => {
        let parsed;
        try { parsed = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString()); } catch { return; }
        for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
          if (m._tag === "Ping") { ws.send(JSON.stringify({ _tag: "Pong" })); continue; }
          if (m._tag === "Chunk") { ws.send(JSON.stringify({ _tag: "Ack", requestId: m.requestId })); continue; }
          if (m._tag === "Exit") {
            const ex = m.exit ?? {};
            if (ex._tag === "Success") return finish(resolve, ex.value);
            return finish(reject, new T3Error(`${tag}: server odmietol: ${JSON.stringify(ex.cause ?? ex).slice(0, 500)}`, { rejected: true }));
          }
          if (m._tag === "Defect" || m._tag === "ClientProtocolError") {
            return finish(reject, new T3Error(`${tag}: ${m._tag} ${JSON.stringify(m).slice(0, 500)}`));
          }
        }
      };
    });
  }

  dispatch(command) {
    return this.rpc("orchestration.dispatchCommand", command);
  }

  launchThread(payload) {
    return this.rpc("orchestration.launchThread", payload);
  }

  // Zastaví procesy poskytovateľa (claude) vlákna, vlákno ostane na čítanie.
  // Ako príkaz klienta "thread session stop" v T3 0.1.0
  // (EnvironmentCommands.stopThreadSession v client/assets/runtime-*.js):
  // pre každú reláciu z providerSessions projekcie vlákna jeden
  // provider-session.detach. Vráti počet odpojených relácií.
  async stopThreadSession(threadId) {
    const detail = await this.threadDetail(threadId);
    let n = 0;
    for (const s of detail.providerSessions ?? []) {
      await this.dispatch({
        type: "provider-session.detach",
        // Čas relácie v commandId: T3 znova pripojí reláciu s tým istým id.
        commandId: stableId("agent-detach", threadId, s.id, s.createdAt ?? "", s.updatedAt ?? ""),
        threadId,
        providerSessionId: s.id,
        reason: "client-requested",
      });
      n++;
    }
    return n;
  }
}

// Vlákno je voľné, keď v ňom nebeží beh, nečaká na schválenie a nie je
// v limite predplatného. Do zaneprázdneného vlákna budič nepíše.
export function threadBusy(t, now = Date.now()) {
  if (!t) return "vlákno neexistuje";
  if (t.archived) return "vlákno je archivované";
  if (t.activeRunId) return `beží ${t.activeRunId}`;
  if (t.activityRunStatus) return `beh ${t.activityRunStatus}`;
  if (t.pendingRuntimeRequest) return "čaká na schválenie vo vlákne";
  if (!["idle", "completed", "interrupted", "failed", "cancelled", "rolled_back"].includes(t.status)) return `stav ${t.status}`;
  if (t.lastErrorClass === "usage_limit" && t.status === "failed") {
    const reset = t.usageLimitResetAt ? Date.parse(t.usageLimitResetAt) : NaN;
    if (!(reset <= now)) return `limit predplatného do ${t.usageLimitResetAt ?? "neznámo"}`;
  }
  return null;
}
