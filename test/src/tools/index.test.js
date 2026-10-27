// index.test.js — index.js: assembly, identity refusal, dispatch and config.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, ATLAS } from "./_harness.js";

let h;
beforeEach(() => { h = makeHarness("winch-index-"); });
afterEach(() => h.teardown());

test("createToolHandlers exposes the same surface the definitions declare", () => {
  assert.equal(h.TOOL_DEFS.length, 11);
  for (const def of h.TOOL_DEFS) {
    const handler = h.call(def.name, {}, ATLAS);
    assert.ok(handler instanceof Promise, `${def.name} did not dispatch`);
  }
});

test("every advertised tool has a handler and unknown names are refused", async () => {
  for (const def of h.TOOL_DEFS) {
    const res = await h.call(def.name, {});
    assert.notEqual(res.details.reason, "unknown_tool", `${def.name} has no handler`);
  }
  assert.equal((await h.call("backlog_bogus", {})).details.reason, "unknown_tool");
});

test("a malformed identity is refused before any handler runs", async () => {
  await assert.rejects(
    () => h.handle("backlog_claim", {}, { harness: "test", agent: "unknown", session: "s-1" }),
    /refused caller identity for backlog_claim.*agent/
  );
  await assert.rejects(
    () => h.handle("backlog_claim", {}, { harness: "test", agent: "builder", session: "instance:999" }),
    /bad layers: session/
  );
  const good = await h.call("backlog_claim", {}, ATLAS);
  assert.equal(good.details.status, "empty");
});

test("per-call meta config reaches the handler without touching the store config", async () => {
  const { task } = h.seedReadyTask();
  const res = await h.handle(
    "backlog_update",
    { taskId: task.id, progressSummary: "x".repeat(50) },
    { harness: "test", agent: "atlas", session: "s-meta" },
    { winch: { config: { noteProgressLimit: 10 } } }
  );
  assert.equal(res.details.reason, "not_claimed");
  const claimed = await h.call("backlog_claim", { taskId: task.id });
  assert.equal(claimed.details.status, "ok");
  const updated = await h.handle(
    "backlog_update",
    { taskId: task.id, progressSummary: "y".repeat(50) },
    { harness: "test", agent: "atlas", session: "s-meta" },
    { winch: { config: { noteProgressLimit: 10 } } }
  );
  assert.equal(updated.details.status, "ok");
  const ev = h.store.db.prepare("SELECT note FROM events WHERE task_id=? AND note LIKE 'progress:%'").get(task.id);
  assert.equal(ev.note.length, "progress: ".length + 11);
});
