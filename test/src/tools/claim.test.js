// claim.test.js — claim.js: by id, or the next ready task; caps, dryRun, races.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, ATLAS, WORKER } from "./_harness.js";

let h;
beforeEach(() => { h = makeHarness("winch-claim-"); });
afterEach(() => h.teardown());

test("claims the named task for the caller and stamps the session", async () => {
  const { task } = h.seedReadyTask();
  const res = await h.call("backlog_claim", { taskId: task.id });
  assert.equal(res.details.status, "ok");
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.task.assigned, "atlas");
  assert.equal(body.handoff.reason, "by-id claim");
  assert.equal(body.handoff.acceptance_criteria, "AC-1");
  const ev = h.store.db.prepare("SELECT * FROM events WHERE task_id=? ORDER BY id").all(task.id);
  assert.equal(ev.at(-1).kind, "task.claimed");
  assert.equal(ev.at(-1).session_ref, "test:atlas:sess-atlas");
});

test("without an id it takes the highest-priority ready task", async () => {
  const epic = h.store.epic.create({ title: "E", status: "planned" });
  const low = h.store.story.create({ epicId: epic.id, title: "low", status: "ready", priority: 10 });
  const high = h.store.story.create({ epicId: epic.id, title: "high", status: "ready", priority: 90 });
  h.store.task.create({ storyId: low.id, title: "low task", status: "todo", executionKind: "manual" });
  h.store.task.create({ storyId: high.id, title: "high task", status: "todo", executionKind: "manual" });
  const first = await h.call("backlog_claim", {});
  assert.equal(JSON.parse(first.content[0].text).story.priority, 90);
  const second = await h.call("backlog_claim", {});
  assert.equal(JSON.parse(second.content[0].text).story.priority, 10);
  const third = await h.call("backlog_claim", {});
  assert.equal(third.details.status, "empty");
});

test("refuses unknown, non-todo and not-ready ids distinctly", async () => {
  const missing = await h.call("backlog_claim", { taskId: "TASK-nope" });
  assert.equal(missing.details.reason, "not_found");
  const busy = h.seedReadyTask({ assigned: "atlas", taskStatus: "in_progress" });
  assert.equal((await h.call("backlog_claim", { taskId: busy.task.id })).details.reason, "not_claimed");
  const epic = h.store.epic.create({ title: "E2", status: "planned" });
  const story = h.store.story.create({ epicId: epic.id, title: "S2", status: "ready" });
  const t1 = h.store.task.create({ storyId: story.id, title: "T1", status: "todo", executionKind: "manual" });
  const t2 = h.store.task.create({ storyId: story.id, title: "T2", status: "todo", executionKind: "manual" });
  const { addDep } = await import("../../../src/deps.js");
  assert.ok(addDep(h.store, t2.id, t1.id).ok);
  assert.equal((await h.call("backlog_claim", { taskId: t2.id })).details.reason, "not_ready");
  assert.equal(h.store.task.get(t2.id).status, "todo");
});

test("a caps requirement refuses a claim that offers none", async () => {
  const { task } = h.seedReadyTask({ capabilities: ["gpu"] });
  assert.equal((await h.call("backlog_claim", { taskId: task.id })).details.reason, "not_ready");
  const withCaps = await h.call("backlog_claim", { taskId: task.id, capabilities: ["gpu"] });
  assert.equal(withCaps.details.status, "ok");
});

test("dryRun reports without claiming", async () => {
  const { task } = h.seedReadyTask();
  const byId = await h.call("backlog_claim", { taskId: task.id, dryRun: true });
  assert.equal(byId.details.dryRun, true);
  assert.equal(h.store.task.get(task.id).status, "todo");
  assert.equal(h.store.task.get(task.id).assigned, null);
  const next = await h.call("backlog_claim", { dryRun: true });
  assert.equal(next.details.taskId, task.id);
  assert.equal(h.store.task.get(task.id).status, "todo");
});

test("a claim by another agent leaves the assignment alone", async () => {
  const { task } = h.seedReadyTask();
  await h.call("backlog_claim", { taskId: task.id }, WORKER);
  assert.equal(h.store.task.get(task.id).assigned, "worker");
});
