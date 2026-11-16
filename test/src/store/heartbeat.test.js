// Heartbeats renew a live attempt's lease; only the assigned agent may do it,
// and a heartbeat writes no event row.

import test from "node:test";
import assert from "node:assert/strict";
import { makeStore, seedHierarchy, eventsFor } from "./_helpers.js";

test("heartbeat advances last_heartbeat only for the assigned in_progress agent", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);

  assert.equal(store.task.heartbeat(task.id, "agent-a"), null, "ready task cannot heartbeat");

  const claimed = store.task.claim({ id: task.id, agentId: "agent-a" });
  const beat = store.task.heartbeat(task.id, "agent-a");
  assert.ok(beat);
  assert.ok(beat.last_heartbeat >= claimed.last_heartbeat);
  assert.equal(store.task.heartbeat(task.id, "agent-b"), null, "wrong agent rejected");

  const evCount = eventsFor(store, task.id).length;
  assert.equal(evCount, 2, "heartbeats write no event rows (birth + claim only)");
});

test("an expired lease requeues the task to its own worker", (t) => {
  const store = makeStore(t);
  const epic = store.epic.create({ title: "E-sweep", status: "in_progress" });
  const story = store.story.create({ epicId: epic.id, title: "S-sweep", status: "in_progress" });
  const task = store.task.create({ storyId: story.id, title: "t", status: "ready", executionKind: "manual", assigned: "worker" });
  store.task.claim({ id: task.id, agentId: "worker", sessionKey: "s", watchdogMs: 1000 });
  store.task.sweepExpired({ now: Date.now() + 5000 });
  const after = store.task.get(task.id);
  assert.equal(after.status, "ready");
  assert.equal(after.assigned, "worker", "the owner is kept so a dispatcher can re-wake it");
  assert.equal(after.attempt_count, 1);
});

test("heartbeat renews the claim lease — a live agent is never swept", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);
  store.task.claim({ id: task.id, agentId: "agent-a", watchdogMs: 60 * 1000 });
  // Expire the lease out from under a live agent, then heartbeat.
  store.db.prepare("UPDATE attempts SET claimed_at=1, heartbeat_at=1 WHERE item_id=? AND ended_at IS NULL").run(task.id);
  const beat = store.task.heartbeat(task.id, "agent-a");
  assert.ok(beat, "heartbeat accepted");
  assert.ok(beat.claim_expires_at > Date.now(), "lease renewed into the future");
  assert.deepEqual(store.task.sweepExpired({}), [], "nothing swept");
  assert.equal(store.task.get(task.id).status, "in_progress");
});
