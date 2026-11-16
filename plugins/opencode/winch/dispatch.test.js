// dispatch.test.js — the opencode adapter routes rows and admits wakes with a cap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { wakeFor, createRouter, createWakeQueue, defaultStatePath } from "./dispatch.js";

const taskEvent = (id = "TASK-1", assigned = "builder") => ({
  kind: "task.assigned",
  item: { id, kind: "task", status: "todo", assigned },
  task: { id, assignee: assigned },
});

test("a task assignment wakes its assignee with the id alone", () => {
  assert.deepEqual(wakeFor(taskEvent()), {
    agent: "builder",
    sessionKey: "winch-task-TASK-1",
    message: "TASK-1",
    kind: "task",
  });
});

test("no planner is hardcoded; a null assignee routes nothing", () => {
  assert.equal(wakeFor(taskEvent("TASK-1", null)), null);
  assert.equal(wakeFor({ kind: "task.appended", item: { id: "TASK-2", status: "todo" } }), null);
});

test("the queue admits FIFO and never drops work", async () => {
  const ran = [];
  let active = 0;
  let peak = 0;
  const queue = createWakeQueue({
    limit: 2,
    run: async (r) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      ran.push(r.message);
      active--;
    },
  });
  for (let i = 1; i <= 8; i++) queue.enqueue({ kind: "task", message: `TASK-${i}`, agent: "builder" });
  while (ran.length < 8) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(peak, 2);
  assert.deepEqual(ran, Array.from({ length: 8 }, (_, i) => `TASK-${i + 1}`));
});

test("the router caps concurrency and dedupes a replayed row", async () => {
  const started = [];
  const gates = [];
  const router = createRouter({
    wake: (r) => new Promise((resolve) => { started.push(r.message); gates.push(resolve); }),
    maxConcurrent: 1,
  });
  router.handle(taskEvent("TASK-1"));
  router.handle(taskEvent("TASK-2"));
  router.handle(taskEvent("TASK-1"));
  await Promise.resolve();
  assert.deepEqual(started, ["TASK-1"]);
  gates.shift()();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(started, ["TASK-1", "TASK-2"]);
  gates.forEach((g) => g());
  await new Promise((r) => setImmediate(r));
});

test("the default state file lives under the opencode state dir", () => {
  assert.match(defaultStatePath(), /\.opencode[/\\]state[/\\]winch-plugin-dispatch\.json$/);
});
