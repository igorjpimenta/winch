// store.test.js — schema creation, CAS claim, sweeper, heartbeat.
// node:test + node:assert, zero deps. Each test gets a throwaway DB in
// os.tmpdir(); the live ~/.winch/store.sqlite is never touched.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore, MAX_ATTEMPTS } from "../src/store.js";

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "backlog-store-"));
  return { dir, dbPath: path.join(dir, "store.sqlite") };
}

function makeStore(t) {
  const { dir, dbPath } = tempDb();
  const store = createStore({ dbPath });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

function seedHierarchy(store) {
  const epic  = store.epic.create({ title: "epic" });
  const story = store.story.create({ epicId: epic.id, title: "story", status: "ready" });
  const task  = store.task.create({ storyId: story.id, title: "task" });
  return { epic, story, task };
}

function eventsFor(store, taskId) {
  return store.db.prepare("SELECT * FROM events WHERE task_id=? ORDER BY id").all(taskId);
}

// ───────────────────────────────────────────────────────────── S0.3 CAS

test("S0.3: claim is CAS — first wins, loser gets null, re-claim after release wins", (t) => {
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
  assert.equal(evs[0].to_status, "todo");
  assert.equal(evs[0].note, "task created");
  assert.equal(evs[1].from_status, "todo");
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

test("S0.3 atomicity: claim event `at` equals the claim's `claimed_at`", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);
  const claimed = store.task.claim({ id: task.id, agentId: "agent-a" });
  assert.equal(claimed.lastEvent.at, claimed.claimed_at);
  assert.equal(claimed.lastEvent.note, "claim");
});

// ───────────────────────────────────────────────────────── S0.4 SWEEPER

test("S0.4: sweeper re-releases expired claims, escalates at MAX_ATTEMPTS", (t) => {
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
      assert.equal(after.status, "todo");
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
    assert.equal(e.to_status, "todo");
  }
  const last = evs[evs.length - 1];
  assert.equal(last.note, "blocked: max attempts");
  assert.equal(last.from_status, "todo");
  assert.equal(last.to_status, "blocked");
});

test("S0.4: sweeper ignores unexpired and non-in_progress tasks", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);
  store.task.claim({ id: task.id, agentId: "agent-a", watchdogMs: 60_000 });
  assert.deepEqual(store.task.sweepExpired({ now: Date.now() }), []);
  assert.equal(store.task.get(task.id).status, "in_progress");
});

// ─────────────────────────────────────────────────────────── HEARTBEAT

test("heartbeat: advances last_heartbeat only for the assigned in_progress agent", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);

  assert.equal(store.task.heartbeat(task.id, "agent-a"), null, "todo task cannot heartbeat");

  const claimed = store.task.claim({ id: task.id, agentId: "agent-a" });
  const beat = store.task.heartbeat(task.id, "agent-a");
  assert.ok(beat);
  assert.ok(beat.last_heartbeat >= claimed.last_heartbeat);
  assert.equal(store.task.heartbeat(task.id, "agent-b"), null, "wrong agent rejected");

  const evCount = eventsFor(store, task.id).length;
  assert.equal(evCount, 2, "heartbeats write no event rows (birth + claim only)");
});

// ────────────────────────────────────────────────────── UPDATE EVENTS

test("task.update: status change writes an event; other patches do not", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);

  store.task.update(task.id, { description: "clarified" });
  assert.equal(eventsFor(store, task.id).length, 1, "birth row only");

  const done = store.task.update(task.id, { status: "done", actor: "agent-a", note: "finished" });
  assert.equal(done.status, "done");
  const evs = eventsFor(store, task.id);
  assert.equal(evs.length, 2);
  assert.equal(evs[1].from_status, "todo");
  assert.equal(evs[1].to_status, "done");
  assert.equal(evs[1].actor, "agent-a");
  assert.equal(evs[1].note, "finished");
});

test("task.update: actor/note optional — defaults to system", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);
  store.task.update(task.id, { status: "blocked" });
  const ev = eventsFor(store, task.id)[1];
  assert.equal(ev.actor, "system");
  assert.equal(ev.note, null);
});
