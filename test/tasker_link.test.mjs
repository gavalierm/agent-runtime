// Každá správa Taskera o jednej úlohe nesie riadok Odkaz hneď za prvým riadkom.
// Prvý riadok sa nemení, driver.mjs ho parsuje (taskerTaskId).
import { test } from "node:test";
import assert from "node:assert/strict";
import { render, renderBridge, renderOrphan, renderDeadComment, taskLink } from "../tasker_events.mjs";

process.env.TASKER_WEB_URL = "https://tasker.example.ts.net:8801";
const URL7 = "https://tasker.example.ts.net:8801/tasks/7";
const cfg = { taskerHome: "/h/.tasker" };
const task = { id: 7, title: "t", status: "todo", assignee: "boris" };
const ev = { task_id: 7, to_status: "done", from_status: "in_progress", actor: "x", at: 0 };
const comment = { author: "operator", created_at: 0, body: "ahoj" };

const messages = {
  "render done": render(ev),
  "render needs_human": render({ ...ev, to_status: "needs_human" }),
  "render failed": render({ ...ev, to_status: "failed" }),
  renderBridge: renderBridge(task, ["created"], null, cfg),
  "renderBridge komentár": renderBridge(task, ["comment"], comment, cfg),
  renderOrphan: renderOrphan(task, comment, cfg),
  renderDeadComment: renderDeadComment(task, "operator", comment),
};

for (const [name, text] of Object.entries(messages)) {
  test(`odkaz na úlohu: ${name}`, () => {
    const [first, second] = text.split("\n");
    assert.match(first, /^Tasker: úloha #7\b/, "prvý riadok ostáva pre driver.mjs");
    assert.equal(second, `Odkaz: ${URL7}`);
    assert.doesNotMatch(text, /127\.0\.0\.1|localhost/);
  });
}

test("odkaz na úlohu: základ z TASKER_WEB_URL, koncové lomky sa zmažú", () => {
  assert.equal(taskLink(9, { TASKER_WEB_URL: "https://x.test:1//" }), "Odkaz: https://x.test:1/tasks/9");
  assert.equal(taskLink(9, {}), "Odkaz: http://127.0.0.1:8801/tasks/9");
});
