import { test } from "node:test";
import assert from "node:assert/strict";
import { T3Client } from "../lib.mjs";

// T3 zahodí príkaz s commandId, ktorý už prijal. Relácia s tým istým id,
// ktorú T3 po odpojení znova pripojí, musí dostať nové commandId, inak druhé
// zastavenie neurobí nič (18. 10. 2026, vlákno témy po /clear).
function fakeClient(session) {
  const cmds = [];
  const c = Object.create(T3Client.prototype);
  c.threadDetail = async () => ({ providerSessions: [session()] });
  c.dispatch = async (p) => { cmds.push(p.commandId); };
  return { c, cmds };
}

test("znova pripojená relácia s tým istým id dostane pri zastavení nové commandId", async () => {
  let updatedAt = "2026-10-18T15:00:00Z";
  const { c, cmds } = fakeClient(() => ({ id: "ps-1", createdAt: "2026-10-18T13:00:00Z", updatedAt }));
  await c.stopThreadSession("thr-1");
  await c.stopThreadSession("thr-1");
  assert.equal(cmds[0], cmds[1], "opakovanie tej istej relácie je idempotentné");
  updatedAt = "2026-10-18T15:40:00Z";
  await c.stopThreadSession("thr-1");
  assert.notEqual(cmds[2], cmds[0], "po znovupripojení nové commandId");
});
