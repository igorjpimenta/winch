// watcher.test.js — tick manifest: sweep, routing split, blocked list.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../src/store.js";
import { tick } from "../src/watcher.js";

let dir, store;

async function setup() {
  dir = mkdtempSync(path.join(tmpdir(), "backlog-watcher-"));
  store = await createStore({ dbPath: path.join(dir, "store.sqlite") });
}

function teardown() {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

function seed({ assigned = null, taskStatus = "todo" } = {}) {
  const epic = store.epic.create({ title: "E", status: "planned", priority: 80 });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready", priority: 70 });
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
  seed({ assigned: null });
  const m = tick(store);
  assert.equal(m.routed.length, 1);
  assert.equal(m.routed[0].taskId, a.task.id);
  assert.equal(m.routed[0].assigned, "builder");
  assert.equal(m.routed[0].executionKind, "manual");
  assert.equal(m.unrouted.length, 1);
  assert.equal(m.unrouted[0].assigned, null);
});

test("expired lease is swept back to todo and reported", () => {
  const { task } = seed({ assigned: "lens", taskStatus: "in_progress" });
  store.db.prepare("UPDATE tasks SET claim_expires_at=? WHERE id=?").run(Date.now() - 1000, task.id);
  const m = tick(store);
  assert.deepEqual(m.swept, [task.id]);
  assert.equal(store.task.get(task.id).status, "todo");
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

// ───────────────────────────────────────────────── S3.4 load-aware routing
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
