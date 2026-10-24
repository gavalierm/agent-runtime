import test from "node:test";
import assert from "node:assert/strict";
import { BURST, renderBurst } from "../tasker_events.mjs";

test("dávka sa zhrnie do jednej správy", () => {
  const rows = Array.from({ length: BURST + 20 }, (_, i) => ({ task_id: i + 1, to_status: "failed" }));
  const out = renderBurst(rows);
  assert.match(out, /25 prechodov úloh naraz/);
  assert.match(out, /failed: 25/);
  assert.equal(out.split("\n").filter((l) => l.startsWith("Tasker:")).length, 1);
});
