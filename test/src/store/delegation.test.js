// Dependency waits: a delegated parent parks in blocked and returns to ready
// only when every child dependency is terminal.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addDep } from "../../../src/deps.js";
import { makeStore } from "./_helpers.js";

function hierarchy(store) {
  const epic = store.epic.create({ title: "E", status: "in_progress" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "in_progress" });
  return { epic, story };
}

test("blockOnDeps marks a dependency wait and releases a live attempt", (t) => {
  const store = makeStore(t);
  const { story } = hierarchy(store);
  const parent = store.task.create({ storyId: story.id, title: "P", status: "ready", assigned: "a", assigneeHarness: "test" });
  store.task.claim({ id: parent.id, agentId: "a", harness: "test" });
  const child = store.task.create({ storyId: parent.id, title: "C", status: "ready", assigned: "b", assigneeHarness: "test" });
  assert.ok(addDep(store, parent.id, child.id).ok);

  const blocked = store.task.blockOnDeps({ id: parent.id, childId: child.id, actor: "test:a", note: "delegate" });
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.state_json.wait.kind, "deps");
  assert.equal(blocked.state_json.wait.childId, child.id);
  assert.equal(store.attempt.list({ itemId: parent.id, live: true }).length, 0);
  assert.equal(store.attempt.list({ itemId: parent.id })[0].status, "released");
});

test("resumeDependencyWaits waits for every child, then returns the parent to ready", (t) => {
  const store = makeStore(t);
  const { story } = hierarchy(store);
  const parent = store.task.create({ storyId: story.id, title: "P", status: "ready", assigned: "a", assigneeHarness: "test" });
  const one = store.task.create({ storyId: parent.id, title: "C1", status: "ready", assigned: "b", assigneeHarness: "test" });
  const two = store.task.create({ storyId: parent.id, title: "C2", status: "ready", assigned: "c", assigneeHarness: "test" });
  addDep(store, parent.id, one.id);
  addDep(store, parent.id, two.id);
  store.task.blockOnDeps({ id: parent.id, actor: "test:a" });

  store.task.update(one.id, { status: "done" });
  assert.deepEqual(store.task.resumeDependencyWaits(), []);
  assert.equal(store.task.get(parent.id).status, "blocked");

  store.task.update(two.id, { status: "done" });
  assert.deepEqual(store.task.resumeDependencyWaits(), [parent.id]);
  const fresh = store.task.get(parent.id);
  assert.equal(fresh.status, "ready");
  assert.equal(fresh.state_json.wait, undefined);
  const event = store.db.prepare("SELECT kind FROM item_events WHERE item_id=? ORDER BY id DESC LIMIT 1").get(parent.id);
  assert.equal(event.kind, "deps.resolved");
});

test("a dropped child counts as resolved", (t) => {
  const store = makeStore(t);
  const { story } = hierarchy(store);
  const parent = store.task.create({ storyId: story.id, title: "P", status: "ready", assigned: "a", assigneeHarness: "test" });
  const child = store.task.create({ storyId: parent.id, title: "C", status: "ready", assigned: "b", assigneeHarness: "test" });
  addDep(store, parent.id, child.id);
  store.task.blockOnDeps({ id: parent.id, actor: "test:a" });
  store.item.drop(child.id, { reason: "no longer needed", actor: "test:a" });

  assert.deepEqual(store.task.resumeDependencyWaits(), [parent.id]);
  assert.equal(store.task.get(parent.id).status, "ready");
});

test("dependency waits ignore gate blocks", (t) => {
  const store = makeStore(t);
  const { story } = hierarchy(store);
  const task = store.task.create({ storyId: story.id, title: "T", status: "ready", assigned: "a", assigneeHarness: "test" });
  store.task.openGate({ id: task.id, gateType: "architecture", reason: "review", actor: "a" });
  assert.deepEqual(store.task.resumeDependencyWaits(), []);
  assert.equal(store.task.get(task.id).status, "blocked");
});
