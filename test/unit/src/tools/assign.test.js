// assign.test.js — backlog_assign behaves like any other tool: the caller is
// attributed by identity, and the only refusals are task-level (missing task,
// or a live claim that belongs to someone else).
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../../../../src/store/index.js";
import { createToolHandlers } from "../../../../src/tools/index.js";

let dir, store, handle;

const PLANNER = { harness: "openclaw", agent: "atlas", session: "s1" };
const WORKER = { harness: "openclaw", agent: "tester", session: "s2" };

function seed({ status = "backlog", assigned = null } = {}) {
  const epic = store.epic.create({ title: "E", status: "in_progress" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "in_progress" });
  return store.task.create({ storyId: story.id, title: "T", status, assigned, assigneeHarness: assigned ? "openclaw" : null });
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
  const r = await handle("backlog_assign", { id: task.id, agent: "tester", capabilities: ["qa"] }, PLANNER);
  assert.equal(r.details.status, "ok");
  const fresh = store.task.get(task.id);
  assert.equal(fresh.assigned, "tester");
  assert.deepEqual(fresh.capabilities, ["qa"]);
  const ev = store.db.prepare("SELECT * FROM item_events WHERE kind='task.assigned'").all();
  assert.equal(ev.length, 1);
  assert.equal(ev[0].item_id, task.id);
  assert.equal(ev[0].from_status, "backlog");
  assert.equal(ev[0].to_status, "ready");
  assert.equal(ev[0].actor, "openclaw:atlas");
  assert.equal(ev[0].note, "assign tester");
});

test("any caller may assign — identity is attribution, not a gate", async () => {
  const task = seed();
  const r = await handle("backlog_assign", { id: task.id, agent: "scorer" }, WORKER);
  assert.equal(r.details.status, "ok");
  assert.equal(store.task.get(task.id).assigned, "scorer");
  assert.equal(
    store.db.prepare("SELECT actor FROM item_events WHERE kind='task.assigned'").get().actor,
    "openclaw:tester"
  );
});

test("null is rejected; capabilities survive when omitted", async () => {
  const task = seed();
  await handle("backlog_assign", { id: task.id, agent: "tester", capabilities: ["qa"] }, PLANNER);
  const r = await handle("backlog_assign", { id: task.id, agent: null }, PLANNER);
  assert.equal(r.details.reason, "rejected");
  const fresh = store.task.get(task.id);
  assert.equal(fresh.assigned, "tester");
  assert.deepEqual(fresh.capabilities, ["qa"]);
});

test("unknown task is refused without writing anything", async () => {
  const r = await handle("backlog_assign", { id: "TASK-nope", agent: "tester" }, PLANNER);
  assert.equal(r.details.reason, "not_found");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM item_events WHERE kind='task.assigned'").get().n, 0);
});

test("a live claim cannot be reassigned out from under its worker", async () => {
  const task = seed({ status: "ready", assigned: "tester" });
  await handle("backlog_claim", {}, WORKER);
  assert.equal(store.task.get(task.id).status, "in_progress");
  const r = await handle("backlog_assign", { id: task.id, agent: "scorer" }, PLANNER);
  assert.equal(r.details.reason, "rejected");
  assert.match(r.content[0].text, /in_progress by tester/);
  assert.equal(store.task.get(task.id).assigned, "tester");
});

test("re-assigning a live task to its own worker is a no-op, not an error", async () => {
  const task = seed({ status: "ready", assigned: "tester" });
  await handle("backlog_claim", {}, WORKER);
  const r = await handle("backlog_assign", { id: task.id, agent: "tester" }, PLANNER);
  assert.equal(r.details.status, "ok");
  assert.equal(store.task.get(task.id).assigned, "tester");
});

test("a story can be assigned, and its owner is the one woken", async () => {
  const epic = store.epic.create({ title: "E-story", status: "in_progress" });
  const story = store.story.create({ epicId: epic.id, title: "S-story", acceptance: "AC", status: "in_progress" });
  const res = await handle("backlog_assign", { id: story.id, agent: "tester", capabilities: ["verify"] }, PLANNER);
  assert.equal(res.details.status, "ok");
  assert.equal(res.details.level, "story");
  assert.equal(store.story.get(story.id).assigned, "tester");
  const ev = store.db.prepare("SELECT * FROM item_events WHERE item_id=? AND kind='story.assigned'").all(story.id);
  assert.equal(ev.length, 1);
  assert.equal(store.itemKindOf(ev[0].item_id), "story");
});

test("clearing a story assignee is rejected and closed stories refuse assignment", async () => {
  const epic = store.epic.create({ title: "E-story2", status: "in_progress" });
  const story = store.story.create({ epicId: epic.id, title: "S-story2", status: "in_progress" });
  await handle("backlog_assign", { id: story.id, agent: "tester" }, PLANNER);
  const cleared = await handle("backlog_assign", { id: story.id, agent: null }, PLANNER);
  assert.equal(cleared.details.reason, "rejected");
  assert.equal(store.story.get(story.id).assigned, "tester");
  store.story.update(story.id, { status: "done" });
  const refused = await handle("backlog_assign", { id: story.id, agent: "tester" }, PLANNER);
  assert.equal(refused.details.reason, "rejected");
  const missing = await handle("backlog_assign", { id: "STORY-nope", agent: "tester" }, PLANNER);
  assert.equal(missing.details.reason, "not_found");
});

function registerDispatch(harness, { state = null } = {}) {
  const row = store.webhook.upsert({
    topic: "dispatch", id: `e-${harness}`, harness, executorId: `e-${harness}`,
    url: `http://127.0.0.1:1/wake-${harness}`, bearer: "b",
  });
  if (state === "disabled") store.webhook.disable({ topic: "dispatch", id: row.id });
  return row;
}

test("assign warns no_route when no dispatch subscription matches the harness", async () => {
  const task = seed();
  const r = await handle("backlog_assign", { id: task.id, agent: "tester" }, PLANNER);
  assert.equal(r.details.status, "ok");
  assert.equal(r.details.warning.code, "no_route");
  assert.equal(r.details.warning.harness, "openclaw");
  const body = JSON.parse(r.content[0].text);
  assert.equal(body.ok, true);
  assert.equal(body.warning.code, "no_route");
  assert.equal(store.task.get(task.id).status, "ready");
});

test("assign stays silent when the harness has an enabled subscription", async () => {
  registerDispatch("openclaw");
  const task = seed();
  const r = await handle("backlog_assign", { id: task.id, agent: "tester" }, PLANNER);
  assert.equal(r.details.status, "ok");
  assert.equal(r.details.warning, undefined);
  assert.equal(JSON.parse(r.content[0].text).warning, undefined);
});

test("a subscription for another harness still warns no_route", async () => {
  registerDispatch("opencode");
  const task = seed();
  const r = await handle("backlog_assign", { id: task.id, agent: "tester" }, PLANNER);
  assert.equal(r.details.status, "ok");
  assert.equal(r.details.warning.code, "no_route");
  assert.equal(r.details.warning.harness, "openclaw");
});

test("a disabled subscription does not count as a route", async () => {
  registerDispatch("openclaw", { state: "disabled" });
  const task = seed();
  const r = await handle("backlog_assign", { id: task.id, agent: "tester" }, PLANNER);
  assert.equal(r.details.status, "ok");
  assert.equal(r.details.warning.code, "no_route");
});

test("human assignments never warn — human work does not route", async () => {
  const task = seed();
  const r = await handle("backlog_assign", { id: task.id, agent: "human" }, PLANNER);
  assert.equal(r.details.status, "ok");
  assert.equal(r.details.warning, undefined);
  assert.equal(store.task.get(task.id).assignee_harness, "human_in_the_loop");
});

test("an assignment that does not enqueue (in_progress no-op) does not warn", async () => {
  const task = seed({ status: "ready", assigned: "tester" });
  await handle("backlog_claim", {}, WORKER);
  const r = await handle("backlog_assign", { id: task.id, agent: "tester" }, PLANNER);
  assert.equal(r.details.status, "ok");
  assert.equal(r.details.warning, undefined);
});

test("story assignment warns no_route only when it moves the story to ready", async () => {
  const epic = store.epic.create({ title: "E-route", status: "in_progress" });
  const backlog = store.story.create({ epicId: epic.id, title: "S-route", status: "backlog" });
  const inProgress = store.story.create({ epicId: epic.id, title: "S-live", status: "in_progress" });
  const warned = await handle("backlog_assign", { id: backlog.id, agent: "tester" }, PLANNER);
  assert.equal(warned.details.status, "ok");
  assert.equal(warned.details.warning.code, "no_route");
  const silent = await handle("backlog_assign", { id: inProgress.id, agent: "tester" }, PLANNER);
  assert.equal(silent.details.status, "ok");
  assert.equal(silent.details.warning, undefined);
});
