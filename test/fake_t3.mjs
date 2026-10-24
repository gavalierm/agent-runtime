// Falošný T3 Code server pre testy: REST časti, ktoré runtime číta,
// a /ws s Effect RPC rámcami Request/Exit. WebSocket je napísaný ručne,
// bez npm závislostí, len textové rámce.
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function frame(text) {
  const data = Buffer.from(text);
  let head;
  if (data.length < 126) head = Buffer.from([0x81, data.length]);
  else if (data.length < 65536) { head = Buffer.alloc(4); head[0] = 0x81; head[1] = 126; head.writeUInt16BE(data.length, 2); }
  else { head = Buffer.alloc(10); head[0] = 0x81; head[1] = 127; head.writeBigUInt64BE(BigInt(data.length), 2); }
  return Buffer.concat([head, data]);
}

// Vráti [správy, zvyšok bufferu]. Klient vždy maskuje.
function parseFrames(buf) {
  const out = [];
  for (;;) {
    if (buf.length < 2) break;
    const op = buf[0] & 0x0f;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
    const masked = buf[1] & 0x80;
    const mask = masked ? buf.subarray(off, off + 4) : null;
    if (masked) off += 4;
    if (buf.length < off + len) break;
    const payload = Buffer.from(buf.subarray(off, off + len));
    if (mask) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
    out.push({ op, text: payload.toString() });
    buf = buf.subarray(off + len);
  }
  return [out, buf];
}

export async function startFakeT3({ token = "tok" } = {}) {
  const state = {
    threads: new Map(),
    projects: [],
    commands: [],     // každé prijaté dispatchCommand (aj opakované)
    messages: [],     // správy, ktoré naozaj vznikli (bez opakovaní)
    receipts: new Map(),
    launches: [],
    rejectNext: 0,    // počet nasledujúcich message.dispatch, ktoré server odmietne
    dropAfterAccept: 0, // počet prijatých príkazov, po ktorých server zavrie spojenie bez Exit
    dropLaunchAfterAccept: 0, // to isté pre orchestration.launchThread
    rejectDetach: 0,  // počet nasledujúcich provider-session.detach, ktoré server odmietne
    launchReceipts: new Map(),
    runSeq: 0,
    httpCalls: [],
  };

  const server = createServer(async (req, res) => {
    state.httpCalls.push(`${req.method} ${req.url}`);
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401).end("{}"); return; }
    let body = "";
    for await (const c of req) body += c;
    const json = (code, v) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    if (req.method === "POST" && req.url === "/api/auth/websocket-ticket") return json(200, { ticket: "t-" + randomUUID() });
    if (req.method === "GET" && req.url === "/api/orchestration/shell") {
      const all = [...state.threads.values()].map(shell);
      return json(200, { threads: all.filter((t) => !t.archived), archivedThreads: all.filter((t) => t.archived), projects: [] });
    }
    const detail = req.method === "GET" && req.url.match(/^\/api\/orchestration\/threads\/([^/]+)\/bounded$/);
    if (detail) {
      const t = state.threads.get(decodeURIComponent(detail[1]));
      if (!t) return json(404, {});
      return json(200, { snapshotSequence: 1, hasMoreHistory: false, historyCursor: null, latestLocalTurnOrdinal: null,
        projection: { thread: { id: t.id, title: t.title }, runs: t._runs, providerSessions: t._providerSessions, providerThreads: t._providerThreads ?? [], providerTurns: t._providerTurns, turnItems: t._turnItems, messages: t._messages } });
    }
    if (req.method === "GET" && req.url === "/api/projects") return json(200, { projects: state.projects, updatedAt: new Date().toISOString() });
    if (req.method === "POST" && req.url === "/api/projects/mutate") {
      const m = JSON.parse(body);
      const p = { id: m.projectId, title: m.title, workspaceRoot: m.workspaceRoot, deletedAt: null };
      state.projects.push(p);
      return json(200, p);
    }
    json(404, {});
  });

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    const send = (v) => socket.write(frame(JSON.stringify(v)));
    socket.on("error", () => {});
    socket.on("data", (d) => {
      let msgs;
      [msgs, buf] = parseFrames(Buffer.concat([buf, d]));
      for (const m of msgs) {
        if (m.op === 8) { socket.end(Buffer.from([0x88, 0])); return; }
        if (m.op !== 1) continue;
        const req = JSON.parse(m.text);
        if (req._tag !== "Request") continue;
        const exit = handle(req.tag, req.payload);
        if (exit === "drop") { socket.destroy(); return; }
        send({ _tag: "Exit", requestId: req.id, exit });
      }
    });
  });

  function handle(tag, p) {
    if (tag === "orchestration.dispatchCommand") {
      state.commands.push(p);
      const prior = state.receipts.get(p.commandId);
      if (prior) return prior;
      let exit;
      if (p.type === "message.dispatch" && state.rejectNext > 0) {
        state.rejectNext--;
        exit = { _tag: "Failure", cause: { _tag: "Fail", error: { _tag: "OrchestrationV2DispatchCommandError", detail: "odmietnuté" } } };
      } else {
        if (p.type === "message.dispatch") {
          const t = state.threads.get(p.threadId);
          if (!t) exit = { _tag: "Failure", cause: { _tag: "Fail", error: { detail: "thread not found" } } };
          else {
            state.messages.push(p);
            startRun(t, p.text);
          }
        }
        if (p.type === "provider-session.detach") {
          if (state.rejectDetach > 0) {
            state.rejectDetach--;
            exit = { _tag: "Failure", cause: { _tag: "Fail", error: { detail: "detach odmietnutý" } } };
          } else {
            const s = state.threads.get(p.threadId)?._providerSessions.find((x) => x.id === p.providerSessionId);
            if (!s) exit = { _tag: "Failure", cause: { _tag: "Fail", error: { detail: "session not found" } } };
            else s.status = "stopped";
          }
        }
        if (p.type === "run.interrupt") {
          const t = state.threads.get(p.threadId);
          t._turnItems.push({ type: "run_interrupt_request", runId: p.runId, message: p.reason });
          endRun(p.threadId, { status: "interrupted" });
        }
        exit ??= { _tag: "Success", value: { sequence: state.commands.length } };
      }
      state.receipts.set(p.commandId, exit);
      if (exit._tag === "Success" && state.dropAfterAccept > 0) { state.dropAfterAccept--; return "drop"; }
      return exit;
    }
    if (tag === "orchestration.launchThread") {
      state.launches.push(p);
      const prior = state.launchReceipts.get(p.commandId);
      if (prior) return { _tag: "Success", value: { threadId: prior, resumed: true, projection: {} } };
      const threadId = "thr-" + (state.launchReceipts.size + 1);
      const t = newThread(threadId, { projectId: p.projectId, title: p.title, modelSelection: p.modelSelection, runtimeMode: p.runtimeMode, interactionMode: p.interactionMode });
      state.threads.set(threadId, t);
      startRun(t, p.initialMessage?.text ?? "");
      state.launchReceipts.set(p.commandId, threadId);
      if (state.dropLaunchAfterAccept > 0) { state.dropLaunchAfterAccept--; return "drop"; }
      return { _tag: "Success", value: { threadId, resumed: false, projection: {} } };
    }
    return { _tag: "Failure", cause: { _tag: "Fail", error: { detail: "neznámy tag " + tag } } };
  }

  // Vlákno drží polia riadku shell (status, activeRunId, latestRunId, ...)
  // a skryté _runs, _providerTurns, _turnItems pre detail /bounded.
  function newThread(id, extra = {}) {
    return { id, projectId: "p1", title: id, status: "idle", activeRunId: null, latestRunId: null, archived: false,
      modelSelection: { instanceId: "claudeAgent", model: "claude-test" }, runtimeMode: "auto", interactionMode: "default",
      lastError: null, lastErrorClass: null, usageLimitResetAt: null, latestVisibleMessage: null, pendingRuntimeRequest: null,
      latestRunStartedAt: null, latestRunCompletedAt: null,
      _runs: [], _providerSessions: [{ id: `ps-${id}`, status: "ready" }], _providerThreads: [], _providerTurns: [], _turnItems: [], _messages: [], ...extra };
  }

  function shell(t) {
    const { _runs, _providerSessions, _providerThreads, _providerTurns, _turnItems, _messages, ...rest } = t;
    return rest;
  }

  function startRun(t, text) {
    const n = ++state.runSeq;
    const run = { id: `run-${n}`, status: "running", activeAttemptId: `att-${n}`, startedAt: new Date().toISOString(), completedAt: null, text };
    t._runs.push(run);
    t._messages.push({ role: "user", runId: run.id, text });
    // Ako T3 0.1.0: riadok shell má latestVisibleMessage null, text je v detaile.
    Object.assign(t, { status: "running", activeRunId: run.id, latestRunId: run.id, latestRunStartedAt: run.startedAt, latestRunCompletedAt: null,
      lastError: null, lastErrorClass: null, usageLimitResetAt: null });
    return run;
  }

  // Koniec behu: status completed, failed, interrupted alebo cancelled.
  function endRun(id, { status = "completed", errorClass = null, error = null, resetAt = null, usedTokens, reply, completedAt } = {}) {
    const t = state.threads.get(id);
    const run = t._runs.find((r) => r.id === t.activeRunId) ?? t._runs.at(-1);
    if (run) {
      run.status = status;
      run.completedAt = completedAt ?? new Date().toISOString();
      if (usedTokens !== undefined) t._providerTurns.push({ id: `turn-${run.id}`, runAttemptId: run.activeAttemptId, ordinal: t._providerTurns.length + 1, status, tokenUsage: { usedTokens, updatedAt: run.completedAt } });
    }
    Object.assign(t, { status, activeRunId: null, latestRunCompletedAt: run?.completedAt ?? null,
      lastErrorClass: status === "failed" ? errorClass : null, lastError: status === "failed" ? error : null,
      usageLimitResetAt: errorClass === "usage_limit" ? resetAt : null,
    });
    if (reply !== undefined) t._messages.push({ role: "assistant", runId: run?.id, text: reply });
  }

  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url, token, state,
    addThread(id, extra = {}) {
      const t = newThread(id, extra);
      if (extra.activeRunId) t._runs.push({ id: extra.activeRunId, status: "running", activeAttemptId: `att-${extra.activeRunId}`, startedAt: new Date().toISOString(), completedAt: null });
      state.threads.set(id, t);
      return t;
    },
    finishRun(id, opts) { endRun(id, opts); },
    // Reštart T3 servera: obnova dá rozbehnutému behu cancelled.
    restartServer(id) { endRun(id, { status: "cancelled" }); },
    holdQueued(id) { state.threads.get(id)._runs.push({ id: "run-held", status: "queued", queueHeld: true, startedAt: null }); },
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
