// Human assignments use the reserved `human` / `human_in_the_loop` pair so
// they keep ready/in_progress semantics without pretending to be an agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { HUMAN_AGENT, HUMAN_HARNESS } from "../../../../src/reserved.js";
import { makeStore } from "./_helpers.js";

function hierarchy(store) {
  const epic = store.epic.create({ title: "E", status: "in_progress" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "in_progress" });
  return { epic, story };
}

test("creating human work stamps the reserved harness and lands ready", (t) => {
  const store = makeStore(t);
  const { story } = hierarchy(store);
  const task = store.task.create({
    storyId: story.id, title: "T", status: "backlog",
    assigned: HUMAN_AGENT, assigneeHarness: "caller-harness",
  });
  assert.equal(task.status, "ready");
  assert.equal(task.assignee_agent, HUMAN_AGENT);
  assert.equal(task.assignee_harness, HUMAN_HARNESS);
});

test("assigning human work over an existing agent replaces the harness pair", (t) => {
  const store = makeStore(t);
  const { story } = hierarchy(store);
  const task = store.task.create({
    storyId: story.id, title: "T", assigned: "builder", assigneeHarness: "test",
  });
  const updated = store.task.assign({ id: task.id, agentId: HUMAN_AGENT, harness: "test", actor: "test:planner" });
  assert.equal(updated.status, "ready");
  assert.equal(updated.assignee_agent, HUMAN_AGENT);
  assert.equal(updated.assignee_harness, HUMAN_HARNESS);
});

test("clearing human work returns it to backlog and drops the pair", (t) => {
  const store = makeStore(t);
  const { story } = hierarchy(store);
  const task = store.task.create({ storyId: story.id, title: "T", assigned: HUMAN_AGENT });
  const cleared = store.task.assign({ id: task.id, agentId: null });
  assert.equal(cleared.status, "backlog");
  assert.equal(cleared.assignee_agent, null);
  assert.equal(cleared.assignee_harness, null);
});

test("story updates normalize the human pair too", (t) => {
  const store = makeStore(t);
  const { epic } = hierarchy(store);
  const story = store.story.create({ epicId: epic.id, title: "S2" });
  const updated = store.story.update(story.id, { assigned: HUMAN_AGENT, assigneeHarness: "test" });
  assert.equal(updated.status, "ready");
  assert.equal(updated.assignee_harness, HUMAN_HARNESS);
});

test("agents cannot use the human harness, and humans cannot be claimed", (t) => {
  const store = makeStore(t);
  const { story } = hierarchy(store);
  assert.throws(
    () => store.task.create({ storyId: story.id, title: "bad", assigned: "builder", assigneeHarness: HUMAN_HARNESS }),
    /reserved assignment harness/
  );
  const task = store.task.create({ storyId: story.id, title: "T", assigned: HUMAN_AGENT });
  assert.equal(store.task.claim({ id: task.id, agentId: HUMAN_AGENT, harness: HUMAN_HARNESS }), null);
});

test("the database refuses a human agent with any other harness", (t) => {
  const store = makeStore(t);
  const { story } = hierarchy(store);
  const task = store.task.create({ storyId: story.id, title: "T", assigned: HUMAN_AGENT });
  assert.throws(
    () => store.db.prepare("UPDATE item_state SET assignee_harness='test' WHERE item_id=?").run(task.id),
    /CHECK/
  );
});
