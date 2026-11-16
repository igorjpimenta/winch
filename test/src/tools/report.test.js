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
  const ev = h.store.db.prepare("SELECT * FROM item_events WHERE item_id=? AND note LIKE 'progress:%'").get(task.id);
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
  const ev = h.store.db.prepare("SELECT * FROM item_events WHERE item_id=? AND kind='task.completed'").get(task.id);
  assert.equal(ev.actor, "atlas");
  assert.equal(h.store.session.get(ev.session_id).session_key, "test:atlas:sess-atlas");
});

test("reopening and closing the epic again writes a second marker", async () => {
  const epic = h.store.epic.create({ title: "E-epic", status: "in_progress" });
  const story = h.store.story.create({ epicId: epic.id, title: "S-epic", status: "in_progress" });
  const t1 = h.store.task.create({ storyId: story.id, title: "one", status: "in_progress", executionKind: "manual", assigned: "atlas", assigneeHarness: "test" });
  const t2 = h.store.task.create({ storyId: story.id, title: "two", status: "in_progress", executionKind: "manual", assigned: "atlas", assigneeHarness: "test" });
  await h.call("backlog_done", { taskId: t1.id, resultSummary: "one done" });
  assert.equal(h.store.db.prepare("SELECT * FROM item_events WHERE kind='epic.completed' AND note=?").all(epic.id).length, 0);
  await h.call("backlog_done", { taskId: t2.id, resultSummary: "two done" });
  assert.equal(h.store.db.prepare("SELECT * FROM item_events WHERE kind='epic.completed' AND note=?").all(epic.id).length, 1);
  // A review finding reopens the epic; the next close is a new cycle.
  const t3 = h.store.task.create({ storyId: story.id, title: "three", status: "in_progress", executionKind: "manual", assigned: "atlas", assigneeHarness: "test" });
  h.store.epic.update(epic.id, { status: "in_progress" });
  h.store.story.update(story.id, { status: "in_progress" });
  await h.call("backlog_done", { taskId: t3.id, resultSummary: "fix" });
  assert.equal(h.store.db.prepare("SELECT * FROM item_events WHERE kind='epic.completed' AND note=?").all(epic.id).length, 2);
});

test("a story closes with its last task and records the transition", async () => {
  const epic = h.store.epic.create({ title: "E-story-close", status: "in_progress" });
  const story = h.store.story.create({ epicId: epic.id, title: "S-close", status: "in_progress" });
  const a = h.store.task.create({ storyId: story.id, title: "a", status: "in_progress", executionKind: "manual", assigned: "atlas", assigneeHarness: "test" });
  const b = h.store.task.create({ storyId: story.id, title: "b", status: "ready", executionKind: "manual", assigned: "atlas", assigneeHarness: "test" });
  await h.call("backlog_done", { taskId: a.id, resultSummary: "a done" });
  assert.equal(h.store.story.get(story.id).status, "in_progress");
  await h.call("backlog_claim", { taskId: b.id });
  await h.call("backlog_done", { taskId: b.id, resultSummary: "b done" });
  assert.equal(h.store.story.get(story.id).status, "done");
  const ev = h.store.db.prepare("SELECT * FROM item_events WHERE item_id=? AND kind='story.completed'").all(story.id);
  assert.equal(ev.length, 1);
  assert.equal(h.store.itemKindOf(ev[0].item_id), "story");
});

test("the epic closes only when its last story does", async () => {
  const epic = h.store.epic.create({ title: "E-two", status: "in_progress" });
  const s1 = h.store.story.create({ epicId: epic.id, title: "s1", status: "in_progress" });
  const s2 = h.store.story.create({ epicId: epic.id, title: "s2", status: "in_progress" });
  const a = h.store.task.create({ storyId: s1.id, title: "a", status: "ready", executionKind: "manual", assigned: "atlas", assigneeHarness: "test" });
  const b = h.store.task.create({ storyId: s2.id, title: "b", status: "ready", executionKind: "manual", assigned: "atlas", assigneeHarness: "test" });
  for (const t of [a, b]) {
    await h.call("backlog_claim", { taskId: t.id });
    await h.call("backlog_done", { taskId: t.id, resultSummary: "done" });
  }
  assert.equal(h.store.epic.get(epic.id).status, "done");
  assert.equal(h.store.db.prepare("SELECT * FROM item_events WHERE kind='epic.completed' AND note=?").all(epic.id).length, 1);
});

test("block records a reason and an optional dependency", async () => {
  const { task } = h.seedReadyTask();
  const blocker = h.store.task.create({ storyId: task.story_id, title: "blocker", status: "ready", executionKind: "manual", assigned: "atlas", assigneeHarness: "test" });
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
  const ev = h.store.db.prepare("SELECT kind FROM item_events WHERE item_id=? ORDER BY id DESC LIMIT 1").get(task.id);
  assert.equal(ev.kind, "gate.opened");
  const mismatch = await h.call("backlog_resume", { taskId: task.id, actor: "someone-else" });
  assert.equal(mismatch.details.reason, "actor_mismatch");
  const resumed = await h.call("backlog_resume", { taskId: task.id });
  assert.equal(resumed.details.status, "ok");
  assert.equal(h.store.task.get(task.id).status, "ready");
  assert.equal((await h.call("backlog_resume", { taskId: task.id })).details.reason, "not_resumable");
});
