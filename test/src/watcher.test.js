// watcher.test.js — tick manifest: sweep, routing split, blocked list.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../../src/store/index.js";
import { tick } from "../../src/watcher.js";

let dir, store;

function setup() {
  dir = mkdtempSync(path.join(tmpdir(), "backlog-watcher-"));
  store = createStore({ dbPath: path.join(dir, "store.sqlite") });
}

function teardown() {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

function seed({ assigned = "builder", taskStatus = "ready" } = {}) {
  const epic = store.epic.create({ title: "E", status: "in_progress", priority: 80 });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "in_progress", priority: 70 });
  const task = store.task.create({
    storyId: story.id, title: "T", status: taskStatus,
    executionKind: "manual", assigned,
  });
  return { epic, story, task };
}

test.beforeEach(setup);
test.afterEach(teardown);

test("empty tick: everything empty — the cron's silent-exit condition", () => {
  const m = tick(store);
  assert.deepEqual(m.swept, []);
  assert.deepEqual(m.routed, []);
  assert.deepEqual(m.unrouted, []);
  assert.deepEqual(m.blocked, []);
});

test("assigned claimable routes; unassigned lands in unrouted (heartbeat owns it)", () => {
  const a = seed({ assigned: "builder" });
  const b = seed({ assigned: null, taskStatus: "backlog" });
  const m = tick(store);
  assert.equal(m.routed.length, 1);
  assert.equal(m.routed[0].taskId, a.task.id);
  assert.equal(m.routed[0].assigned, "builder");
  assert.equal(m.routed[0].executionKind, "manual");
  assert.deepEqual(m.unrouted, []);
  assert.ok(!m.routed.some((r) => r.taskId === b.task.id), "backlog is not claimable");
});

test("expired lease is swept back to ready and reported", () => {
  const { task } = seed({ assigned: "lens", taskStatus: "ready" });
  store.task.claim({ id: task.id, agentId: "lens" });
  store.db.prepare("UPDATE attempts SET claimed_at=1, heartbeat_at=1 WHERE item_id=? AND ended_at IS NULL").run(task.id);
  const m = tick(store);
  assert.deepEqual(m.swept, [task.id]);
  assert.equal(store.task.get(task.id).status, "ready");
});

test("blocked tasks appear in blocked, never in claimable sets", () => {
  const { task } = seed({ assigned: "lens", taskStatus: "in_progress" });
  store.task.update(task.id, { status: "blocked", actor: "lens", note: "blocked: waiting" });
  const m = tick(store);
  assert.deepEqual(m.routed, []);
  assert.deepEqual(m.unrouted, []);
  assert.equal(m.blocked.length, 1);
  assert.equal(m.blocked[0].id, task.id);
});

// ───────────────────────────────────────────────────── load-aware routing
test("busy assignee's claimable work defers; free assignee still routes", () => {
  seed({ assigned: "scout" }); // free agent's claimable task
  // builder: two in_progress tasks (at the cap) + one claimable
  const busy = seed({ assigned: "builder", taskStatus: "in_progress" });
  seed({ assigned: "builder", taskStatus: "in_progress" });
  seed({ assigned: "builder" });
  // second busy task needs its own story/epic — seed() makes one each ✓
  const m = tick(store);

  const routedAgents = m.routed.map((r) => r.assigned);
  assert.ok(routedAgents.includes("scout"), "free agent routes");
  assert.ok(!routedAgents.includes("builder"), "busy agent defers");

  assert.equal(m.deferred.length, 1);
  assert.equal(m.deferred[0].assigned, "builder");
  assert.equal(m.deferred[0].activeCount, 2);
  assert.ok(busy.task.id);
});

test("agent under the cap still routes", () => {
  seed({ assigned: "lens", taskStatus: "in_progress" }); // 1 active < 2
  seed({ assigned: "lens" });
  const m = tick(store);
  assert.equal(m.routed.length, 1);
  assert.equal(m.routed[0].assigned, "lens");
  assert.equal(m.deferred.length, 0);
});

test("tick writes gate-waiting rows for stale gates and reports waiting age", () => {
  const { task } = seed({ assigned: "lens", taskStatus: "in_progress" });
  store.task.openGate({ id: task.id, gateType: "roadmap", reason: "ADR", actor: "lens" });
  store.db.prepare("UPDATE attempts SET gate_record_json=json_set(COALESCE(gate_record_json, '{}'), '$.openedAt', ?) WHERE item_id=? AND gate_record_json IS NOT NULL").run(Date.now() - 25 * 3600 * 1000, task.id);
  const u = seed({ assigned: null, taskStatus: "backlog" });
  const m = tick(store);
  assert.equal(m.waits.length, 1);
  assert.equal(m.waits[0].taskId, task.id);
  assert.equal(m.waits[0].label, "24h");
  assert.deepEqual(m.unrouted, []);
  assert.ok(!m.routed.some((r) => r.taskId === u.task.id), "unassigned backlog is not woken");
  const m2 = tick(store);
  assert.deepEqual(m2.waits, [], "second tick writes nothing new");
});
