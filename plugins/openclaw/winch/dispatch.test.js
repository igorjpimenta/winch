// dispatch.test.js — dispatch.js: which row wakes which agent, and dedupe.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { wakeFor, createRouter, defaultStatePath } from "./dispatch.js";

function taskEvent(kind, { id = "TASK-1", assigned = "builder", epicCreatedBy = "atlas" } = {}) {
  return {
    type: "event",
    kind,
    item: { id, kind: "task", assigned },
    task: { id, assignee: assigned },
    epicCreatedBy,
  };
}

test("a task assignment wakes its assignee with the id alone", () => {
  const route = wakeFor(taskEvent("task.assigned"));
  assert.deepEqual(route, { agent: "builder", sessionKey: "winch-task-TASK-1", message: "TASK-1", kind: "task" });
});

test("the planner is never woken to work its own assignment", () => {
  assert.equal(wakeFor(taskEvent("task.assigned", { assigned: "atlas" })), null);
  assert.equal(wakeFor(taskEvent("task.assigned", { assigned: null })), null);
});

test("a story assignment wakes its owner to break it down", () => {
  const route = wakeFor({ kind: "story.assigned", item: { id: "STORY-1", kind: "story", assigned: "tester" } });
  assert.equal(route.agent, "tester");
  assert.equal(route.sessionKey, "winch-story-STORY-1");
  assert.equal(route.message, "STORY-1");
});

test("appended work and a finished epic wake the epic's creator", () => {
  const append = wakeFor(taskEvent("task.appended"));
  assert.equal(append.agent, "atlas");
  assert.equal(append.kind, "append");
  const review = wakeFor({ kind: "epic.completed", item: { id: "EPIC-9", kind: "epic" }, epicCreatedBy: "scout" });
  assert.equal(review.agent, "scout");
  assert.equal(review.sessionKey, "winch-epic-EPIC-9");
  assert.equal(review.message, "EPIC-9");
});

test("history replay does not wake anyone for work that already moved", () => {
  assert.equal(wakeFor({ kind: "task.assigned", item: { id: "TASK-1", status: "done", assigned: "builder" } }), null);
  assert.equal(wakeFor({ kind: "task.assigned", item: { id: "TASK-1", status: "in_progress", assigned: "builder" } }), null);
  assert.equal(wakeFor({ kind: "task.appended", item: { id: "TASK-1", status: "cancelled" } }), null);
  assert.equal(wakeFor({ kind: "story.assigned", item: { id: "STORY-1", status: "done", assigned: "tester" } }), null);
  assert.equal(wakeFor({ kind: "task.assigned", item: { id: "TASK-1", status: "todo", assigned: "builder" } }).agent, "builder");
});

test("a close wakes the work it made claimable", () => {
  const woken = [];
  const router = createRouter({ wake: (r) => woken.push(r), planner: "atlas" });
  router.handle({ kind: "task.completed", id: 11, item: { id: "TASK-1", status: "done" }, unblocked: [{ id: "TASK-2", assigned: "tester" }] });
  assert.equal(woken.length, 1);
  assert.equal(woken[0].agent, "tester");
  assert.equal(woken[0].message, "TASK-2");
  router.handle({ kind: "task.completed", id: 11, item: { id: "TASK-1", status: "done" }, unblocked: [{ id: "TASK-2", assigned: "tester" }] });
  assert.equal(woken.length, 1);
  router.handle({ kind: "task.completed", id: 11, item: { id: "TASK-1", status: "done" }, unblocked: [{ id: "TASK-2", assigned: "tester" }] });
  assert.equal(woken.length, 1, "the same replayed row does not wake twice");
});

test("an unblock re-wakes a task that was refused earlier", () => {
  const woken = [];
  let clock = 1000;
  const router = createRouter({ wake: (r) => woken.push(r), planner: "atlas", now: () => clock });
  router.handle(taskEvent("task.assigned", { id: "TASK-2", assigned: "tester" }));
  clock += 5000;
  router.handle({ kind: "task.completed", item: { id: "TASK-1", status: "done" }, unblocked: [{ id: "TASK-2", assigned: "tester" }] });
  assert.equal(woken.length, 2, "the close outranks the earlier suppression");
});

test("a row that routed nothing is retried on the next replay", () => {
  const woken = [];
  const router = createRouter({ wake: (r) => woken.push(r), planner: "atlas" });
  router.handle({ kind: "task.claimed", id: 7, item: { id: "TASK-1", status: "in_progress" } });
  assert.equal(woken.length, 0);
  router.handle(taskEvent("task.assigned", { id: "TASK-7", assigned: "builder" }));
  assert.equal(woken.length, 1, "the unroutable row did not consume the task");
});

test("a restored task wakes the assignee it already had", () => {
  const route = wakeFor({ kind: "task.restored", item: { id: "TASK-4", kind: "task", status: "todo", assigned: "builder" } });
  assert.equal(route.agent, "builder");
  assert.equal(route.sessionKey, "winch-task-TASK-4");
  assert.equal(wakeFor({ kind: "task.restored", item: { id: "TASK-4", status: "cancelled", assigned: "builder" } }), null);
  assert.equal(wakeFor({ kind: "task.restored", item: { id: "TASK-4", status: "todo", assigned: null } }), null);
});

test("unroutable rows are ignored", () => {
  assert.equal(wakeFor({ kind: "task.claimed", item: { id: "TASK-1" } }), null);
  assert.equal(wakeFor({ kind: "epic.completed", item: { id: "TASK-1" } }), null);
  assert.equal(wakeFor({}), null);
  assert.equal(wakeFor(null), null);
});

test("a task wake is not repeated inside the in-flight window", () => {
  const woken = [];
  let clock = 1000;
  const router = createRouter({ wake: (r) => woken.push(r), planner: "atlas", now: () => clock });
  router.handle(taskEvent("task.assigned"));
  clock += 1000;
  router.handle(taskEvent("task.assigned"));
  assert.equal(woken.length, 1);
  clock += 36 * 60 * 1000;
  router.handle(taskEvent("task.assigned"));
  assert.equal(woken.length, 2);
});

test("an epic review happens once per close cycle, across restarts", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "winch-dispatch-"));
  const statePath = path.join(dir, "state.json");
  const review = (id) => ({ kind: "epic.completed", id, item: { id: "EPIC-1", kind: "epic" }, epicCreatedBy: "atlas" });
  try {
    const first = [];
    const router = createRouter({ wake: (r) => first.push(r), statePath });
    router.handle(review(5));
    router.handle(review(5));
    assert.equal(first.length, 1, "same marker replayed");
    router.handle(review(9));
    assert.equal(first.length, 2, "a new marker is a new review cycle");
    const second = [];
    const rebooted = createRouter({ wake: (r) => second.push(r), statePath });
    rebooted.handle(review(9));
    assert.equal(second.length, 0, "the reviewed marker survives a restart");
    rebooted.handle(review(12));
    assert.equal(second.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the default state file lives under the openclaw state dir", () => {
  assert.match(defaultStatePath(), /\.openclaw[/\\]state[/\\]winch-plugin-dispatch\.json$/);
});
