// assign.test.js — backlog_assign behaves like any other tool: the caller is
// attributed by identity, and the only refusals are task-level (missing task,
// or a live claim that belongs to someone else).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../../src/store.js";
import { createToolHandlers } from "../../src/tools.js";

let dir, store, handle;

const PLANNER = { harness: "openclaw", agent: "atlas", session: "s1" };
const WORKER = { harness: "openclaw", agent: "tester", session: "s2" };

function seed({ status = "todo", assigned = null } = {}) {
  const epic = store.epic.create({ title: "E", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready" });
  return store.task.create({ storyId: story.id, title: "T", status, assigned });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "winch-assign-"));
  store = createStore({ dbPath: path.join(dir, "store.sqlite") });
  ({ handle } = createToolHandlers(store, null));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("assigns and writes the audit event", async () => {
  const task = seed();
  const r = await handle("backlog_assign", { taskId: task.id, agent: "tester", capabilities: ["qa"] }, PLANNER);
  assert.equal(r.details.status, "ok");
  const fresh = store.task.get(task.id);
  assert.equal(fresh.assigned, "tester");
  assert.deepEqual(fresh.capabilities, ["qa"]);
  const ev = store.db.prepare("SELECT * FROM events WHERE kind='task.assigned'").all();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].task_id, task.id);
  assert.equal(ev[0].from_status, ev[0].to_status, "assignment never fakes a status transition");
  assert.equal(ev[0].actor, "openclaw:atlas");
  assert.equal(ev[0].note, "assign tester");
});

test("any caller may assign — identity is attribution, not a gate", async () => {
  const task = seed();
  const r = await handle("backlog_assign", { taskId: task.id, agent: "scorer" }, WORKER);
  assert.equal(r.details.status, "ok");
  assert.equal(store.task.get(task.id).assigned, "scorer");
  assert.equal(
    store.db.prepare("SELECT actor FROM events WHERE kind='task.assigned'").get().actor,
    "openclaw:tester"
  );
});

test("null clears the assignee; capabilities survive when omitted", async () => {
  const task = seed();
  await handle("backlog_assign", { taskId: task.id, agent: "tester", capabilities: ["qa"] }, PLANNER);
  await handle("backlog_assign", { taskId: task.id, agent: null }, PLANNER);
  const fresh = store.task.get(task.id);
  assert.equal(fresh.assigned, null);
  assert.deepEqual(fresh.capabilities, ["qa"]);
  assert.equal(
    store.db.prepare("SELECT note FROM events WHERE kind='task.assigned' ORDER BY id DESC LIMIT 1").get().note,
    "assign nobody"
  );
});

test("unknown task is refused without writing anything", async () => {
  const r = await handle("backlog_assign", { taskId: "TASK-nope", agent: "tester" }, PLANNER);
  assert.equal(r.details.reason, "not_found");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='task.assigned'").get().n, 0);
});

test("a live claim cannot be reassigned out from under its worker", async () => {
  const task = seed();
  await handle("backlog_next", {}, WORKER);
  assert.equal(store.task.get(task.id).status, "in_progress");
  const r = await handle("backlog_assign", { taskId: task.id, agent: "scorer" }, PLANNER);
  assert.equal(r.details.reason, "rejected");
  assert.match(r.content[0].text, /in_progress by tester/);
  assert.equal(store.task.get(task.id).assigned, "tester");
});

test("re-assigning a live task to its own worker is a no-op, not an error", async () => {
  const task = seed();
  await handle("backlog_next", {}, WORKER);
  const r = await handle("backlog_assign", { taskId: task.id, agent: "tester" }, PLANNER);
  assert.equal(r.details.status, "ok");
  assert.equal(store.task.get(task.id).assigned, "tester");
});
