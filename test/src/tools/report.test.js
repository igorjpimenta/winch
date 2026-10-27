// report.test.js — report.js: update, done (with the epic marker), block, resume.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, ATLAS, WORKER } from "./_harness.js";

let h;
beforeEach(() => { h = makeHarness("winch-report-"); });
afterEach(() => h.teardown());

test("update heartbeats and appends a progress event", async () => {
  const { task } = h.seedReadyTask({ assigned: "atlas", taskStatus: "in_progress" });
  const res = await h.call("backlog_update", { taskId: task.id, progressSummary: "half way" });
  assert.equal(res.details.status, "ok");
  assert.ok(h.store.task.get(task.id).last_heartbeat > 0);
  const ev = h.store.db.prepare("SELECT * FROM events WHERE task_id=? AND note LIKE 'progress:%'").get(task.id);
  assert.match(ev.note, /half way/);
});

test("update rejects an unclaimed task", async () => {
  const { task } = h.seedReadyTask();
  assert.equal((await h.call("backlog_update", { taskId: task.id })).details.reason, "not_claimed");
});

test("done rejects a foreign agent and a non-claimed task", async () => {
  const { task } = h.seedReadyTask({ assigned: "atlas", taskStatus: "in_progress" });
  const wrong = await h.call("backlog_done", { taskId: task.id, resultSummary: "x" }, WORKER);
  assert.equal(wrong.details.reason, "not_assignee");
  const never = h.seedReadyTask();
  assert.equal((await h.call("backlog_done", { taskId: never.task.id, resultSummary: "x" })).details.reason, "not_claimed");
});

test("done records the result, artifacts and the session", async () => {
  const { task } = h.seedReadyTask();
  await h.call("backlog_claim", {});
  const res = await h.call("backlog_done", { taskId: task.id, resultSummary: "shipped", artifacts: ["pr:1"] });
  assert.equal(res.details.status, "ok");
  const t = h.store.task.get(task.id);
  assert.equal(t.status, "done");
  assert.match(t.result_summary, /artifacts: pr:1/);
  const ev = h.store.db.prepare("SELECT * FROM events WHERE task_id=? AND kind='task.completed'").get(task.id);
  assert.equal(ev.actor, "atlas");
  assert.equal(ev.session_ref, "test:atlas:sess-atlas");
});

test("the epic is marked complete exactly once, after its last task", async () => {
  const epic = h.store.epic.create({ title: "E-epic", status: "planned" });
  const story = h.store.story.create({ epicId: epic.id, title: "S-epic", status: "ready" });
  const t1 = h.store.task.create({ storyId: story.id, title: "one", status: "in_progress", executionKind: "manual", assigned: "atlas" });
  const t2 = h.store.task.create({ storyId: story.id, title: "two", status: "in_progress", executionKind: "manual", assigned: "atlas" });
  await h.call("backlog_done", { taskId: t1.id, resultSummary: "one done" });
  assert.equal(h.store.db.prepare("SELECT * FROM events WHERE kind='epic.completed' AND note=?").all(epic.id).length, 0);
  await h.call("backlog_done", { taskId: t2.id, resultSummary: "two done" });
  assert.equal(h.store.db.prepare("SELECT * FROM events WHERE kind='epic.completed' AND note=?").all(epic.id).length, 1);
  await h.call("backlog_done", { taskId: t2.id, resultSummary: "again" }).catch(() => {});
  assert.equal(h.store.db.prepare("SELECT * FROM events WHERE kind='epic.completed' AND note=?").all(epic.id).length, 1);
});

test("block records a reason and an optional dependency", async () => {
  const { task } = h.seedReadyTask();
  const blocker = h.store.task.create({ storyId: task.story_id, title: "blocker", status: "todo", executionKind: "manual" });
  const res = await h.call("backlog_block", { taskId: task.id, reason: "waiting", blockedBy: { kind: "task", id: blocker.id } });
  assert.equal(res.details.status, "ok");
  assert.equal(h.store.task.get(task.id).status, "blocked");
  assert.equal(res.details.dep, "added");
  assert.equal(h.store.dep.listOutgoing(task.id)[0].to_id, blocker.id);
});

test("block refuses a task assigned to another agent", async () => {
  const { task } = h.seedReadyTask({ assigned: "worker", taskStatus: "in_progress" });
  assert.equal((await h.call("backlog_block", { taskId: task.id, reason: "x" })).details.reason, "not_assignee");
});

test("gate type opens through openGate and resume accepts only the caller", async () => {
  const { task } = h.seedReadyTask();
  const opened = await h.call("backlog_block", { taskId: task.id, reason: "approve", gateType: "release" });
  assert.equal(opened.details.status, "ok");
  assert.equal(h.store.task.get(task.id).gate_type, "release");
  const ev = h.store.db.prepare("SELECT kind FROM events WHERE task_id=? ORDER BY id DESC LIMIT 1").get(task.id);
  assert.equal(ev.kind, "gate.opened");
  const mismatch = await h.call("backlog_resume", { taskId: task.id, actor: "someone-else" });
  assert.equal(mismatch.details.reason, "actor_mismatch");
  const resumed = await h.call("backlog_resume", { taskId: task.id });
  assert.equal(resumed.details.status, "ok");
  assert.equal(h.store.task.get(task.id).status, "todo");
  assert.equal((await h.call("backlog_resume", { taskId: task.id })).details.reason, "not_resumable");
});
