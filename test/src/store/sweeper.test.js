// Lease sweeper: expired claims return to the queue, and the attempt limit
// escalates the task instead of cycling forever.

import test from "node:test";
import assert from "node:assert/strict";
import { MAX_ATTEMPTS } from "../../../src/store/index.js";
import { makeStore, seedHierarchy, eventsFor } from "./_helpers.js";

test("sweeper re-releases expired claims, escalates at MAX_ATTEMPTS", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);

  let sweepAt = Date.now() + 10;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const claimed = store.task.claim({ id: task.id, agentId: "agent-a", watchdogMs: 1 });
    assert.ok(claimed, `claim ${attempt} succeeds`);
    const swept = store.task.sweepExpired({ now: sweepAt += 1000 });
    assert.equal(swept.length, 1);
    const after = store.task.get(task.id);
    if (attempt < MAX_ATTEMPTS) {
      assert.equal(after.status, "ready");
      assert.equal(after.attempt_count, attempt);
    } else {
      assert.equal(after.status, "blocked");
      assert.equal(after.attempt_count, MAX_ATTEMPTS);
    }
  }

  const evs = eventsFor(store, task.id);
  // birth + 3 claims + 3 sweep-releases + 1 escalation
  assert.equal(evs.length, 2 + 2 * MAX_ATTEMPTS);
  const sweeps = evs.filter((e) => e.note === "sweeper");
  assert.equal(sweeps.length, MAX_ATTEMPTS);
  for (const e of sweeps) {
    assert.equal(e.from_status, "in_progress");
    assert.equal(e.to_status, "ready");
  }
  const last = evs[evs.length - 1];
  assert.equal(last.note, "blocked: max attempts");
  assert.equal(last.from_status, "ready");
  assert.equal(last.to_status, "blocked");
});

test("sweeper ignores unexpired and non-in_progress tasks", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);
  store.task.claim({ id: task.id, agentId: "agent-a", watchdogMs: 60_000 });
  assert.deepEqual(store.task.sweepExpired({ now: Date.now() }), []);
  assert.equal(store.task.get(task.id).status, "in_progress");
});
