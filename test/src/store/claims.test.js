// Claim CAS: one winner, the loser gets null, and the assignment survives a
// release so the same worker can re-claim.

import test from "node:test";
import assert from "node:assert/strict";
import { makeStore, seedHierarchy, eventsFor } from "./_helpers.js";

test("claim is CAS — first wins, loser gets null, re-claim after release wins", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);

  const claimed = store.task.claim({ id: task.id, agentId: "agent-a" });
  assert.ok(claimed);
  assert.equal(claimed.status, "in_progress");
  assert.equal(claimed.assigned, "agent-a");
  assert.equal(claimed.lease_seconds, 1800);

  const evs = eventsFor(store, task.id);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].from_status, null);
  assert.equal(evs[0].to_status, "ready");
  assert.equal(evs[0].note, "task created");
  assert.equal(evs[1].from_status, "ready");
  assert.equal(evs[1].to_status, "in_progress");
  assert.equal(evs[1].actor, "agent-a");
  assert.equal(evs[1].note, "claim");

  assert.equal(store.task.claim({ id: task.id, agentId: "agent-b" }), null);
  assert.equal(store.task.claim({ id: task.id, agentId: "agent-a" }), null);

  assert.ok(store.task.release(task.id));
  const again = store.task.claim({ id: task.id, agentId: "agent-a" });
  assert.ok(again, "assigned agent re-claims after release");
  assert.equal(again.status, "in_progress");
});

test("claim event `at` equals the claim's `claimed_at`", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);
  const claimed = store.task.claim({ id: task.id, agentId: "agent-a" });
  assert.equal(claimed.lastEvent.created_at, claimed.claimed_at);
  assert.equal(claimed.lastEvent.note, "claim");
});

test("ready requires an assignment: assign moves backlog to ready, clearing returns backlog", (t) => {
  const store = makeStore(t);
  const epic = store.epic.create({ title: "E" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "in_progress" });
  const task = store.task.create({ storyId: story.id, title: "T" });
  assert.equal(task.status, "backlog");

  assert.throws(
    () => store.task.update(task.id, { status: "ready" }),
    /ready item requires an assignment/
  );

  const assigned = store.task.assign({ id: task.id, agentId: "agent-a", harness: "test" });
  assert.equal(assigned.status, "ready");
  assert.equal(assigned.assignee_harness, "test");
  assert.equal(assigned.assignee_agent, "agent-a");

  const cleared = store.task.assign({ id: task.id, agentId: null });
  assert.equal(cleared.status, "backlog");
  assert.equal(cleared.assignee_agent, null);

  assert.throws(
    () => store.db.prepare("UPDATE item_state SET status='ready', assignee_harness=NULL, assignee_agent=NULL WHERE item_id=?").run(task.id),
    /CHECK constraint failed/
  );
});

test("only the assigned harness:agent pair may claim", (t) => {
  const store = makeStore(t);
  const epic = store.epic.create({ title: "E" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "in_progress" });
  const task = store.task.create({
    storyId: story.id, title: "T", status: "ready",
    assigned: "agent-a", assigneeHarness: "test",
  });

  assert.equal(store.task.claim({ id: task.id, agentId: "agent-b", harness: "test" }), null);
  assert.equal(store.task.claim({ id: task.id, agentId: "agent-a", harness: "other" }), null);
  const claimed = store.task.claim({ id: task.id, agentId: "agent-a", harness: "test" });
  assert.ok(claimed);
  assert.equal(claimed.status, "in_progress");
});
