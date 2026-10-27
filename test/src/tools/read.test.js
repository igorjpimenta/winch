// read.test.js — read.js: one read tool, the level follows the id prefix.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, WORKER } from "./_harness.js";

let h;
beforeEach(() => { h = makeHarness("winch-read-"); });
afterEach(() => h.teardown());

test("a task read returns the record a worker needs, without claiming", async () => {
  const epic = h.store.epic.create({ title: "E-get", description: "epic body", acceptance: "EP-AC", status: "planned", priority: 80 });
  const story = h.store.story.create({ epicId: epic.id, title: "S-get", description: "story body", acceptance: "AC-get", status: "ready", priority: 70 });
  const task = h.store.task.create({ storyId: story.id, title: "T-get", description: "task body", status: "todo", executionKind: "cli" });
  const res = await h.call("backlog_get", { id: task.id });
  assert.equal(res.details.status, "ok");
  assert.equal(res.details.level, "task");
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.task.description, "task body");
  assert.equal(body.story.acceptance, "AC-get");
  assert.equal(body.story.description, "story body");
  assert.equal(body.epic.id, epic.id);
  assert.equal(body.readiness.ready, true);
  assert.deepEqual(body.readiness.blockers, []);
  assert.match(body.brief, /AC-get/);
  assert.equal(h.store.task.get(task.id).status, "todo");
  assert.equal(h.store.task.get(task.id).assigned, null);
});

test("a task read explains why it is not ready for this agent", async () => {
  const epic = h.store.epic.create({ title: "E-get2", status: "planned" });
  const story = h.store.story.create({ epicId: epic.id, title: "S-get2", status: "ready", acceptance: "AC-2" });
  const dep = h.store.task.create({ storyId: story.id, title: "T-dep", status: "todo", executionKind: "manual" });
  const task = h.store.task.create({ storyId: story.id, title: "T-blocked", status: "todo", executionKind: "manual", capabilities: ["gpu"] });
  const { addDep } = await import("../../../src/deps.js");
  assert.ok(addDep(h.store, task.id, dep.id).ok);
  const mine = JSON.parse((await h.call("backlog_get", { id: task.id, capabilities: ["gpu"] })).content[0].text);
  assert.equal(mine.readiness.ready, false);
  assert.ok(mine.readiness.blockers.includes("task dependencies unresolved"));
  assert.equal(mine.dependencies[0].id, dep.id);
  const foreign = JSON.parse((await h.call("backlog_get", { id: task.id }, WORKER)).content[0].text);
  assert.equal(foreign.level, "task");
});

test("a story read returns its tasks, parent epic and artifacts", async () => {
  const { epic, story, task } = h.seedReadyTask();
  h.store.db.prepare("INSERT INTO events(task_id,from_status,to_status,actor,note,at) VALUES(?,?,?,?,?,?)")
    .run(task.id, "todo", "todo", "atlas", "artifact: https://example.test/a", Date.now());
  const res = await h.call("backlog_get", { id: story.id });
  assert.equal(res.details.level, "story");
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.story.acceptance, "AC-1");
  assert.equal(body.epic.id, epic.id);
  assert.equal(body.tasks.length, 1);
  assert.deepEqual(body.artifacts, ["https://example.test/a"]);
});

test("an epic read returns the tree a reviewer needs", async () => {
  const epic = h.store.epic.create({ title: "E-rev", acceptance: "EA", status: "planned" });
  const story = h.store.story.create({ epicId: epic.id, title: "S-rev", acceptance: "SA", status: "ready" });
  const t1 = h.store.task.create({ storyId: story.id, title: "built", status: "done", executionKind: "manual" });
  h.store.task.update(t1.id, { result_summary: "ok" });
  h.store.task.create({ storyId: story.id, title: "pending", status: "todo", executionKind: "manual" });
  const res = await h.call("backlog_get", { id: epic.id });
  assert.equal(res.details.level, "epic");
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.epic.acceptance, "EA");
  assert.equal(body.stories[0].acceptance, "SA");
  assert.equal(body.summary.tasks, 2);
  assert.equal(body.summary.done, 1);
  assert.equal(body.stories[0].tasks.find((t) => t.id === t1.id).result_summary, "ok");
});

test("unknown and missing ids are refused, and no id at all is a rejection", async () => {
  assert.equal((await h.call("backlog_get", { id: "EPIC-nope" })).details.reason, "not_found");
  assert.equal((await h.call("backlog_get", { id: "STORY-nope" })).details.reason, "not_found");
  assert.equal((await h.call("backlog_get", { id: "TASK-nope" })).details.reason, "not_found");
  assert.equal((await h.call("backlog_get", {})).details.reason, "rejected");
});
