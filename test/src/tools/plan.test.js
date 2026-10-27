// plan.test.js — plan.js: create a plan, append to it, disable and restore.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeHarness } from "./_harness.js";

let h;
beforeEach(() => { h = makeHarness("winch-plan-"); });
afterEach(() => h.teardown());

test("plan writes a whole demand into records and wires dependencies", async () => {
  const res = await h.call("backlog_plan", {
    epic: { title: "Ship a slugifier", description: "one demand", acceptance: "CLI works", priority: 90 },
    stories: [{
      title: "Slugify",
      acceptance: "accent + punctuation handled",
      tasks: [
        { title: "Build", description: "stdlib only, CLI", capabilities: ["build"] },
        { title: "Test", description: "edge cases", capabilities: ["verify"], dependsOn: ["s0t0"] },
      ],
    }],
  });
  assert.equal(res.details.status, "ok");
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.stories.length, 1);
  assert.equal(body.dependencies, 1);
  const [build, verify] = body.stories[0].tasks;
  assert.equal(h.store.task.get(build.id).description, "stdlib only, CLI");
  assert.deepEqual(h.store.task.get(build.id).capabilities, ["build"]);
  const got = JSON.parse((await h.call("backlog_get", { id: verify.id })).content[0].text);
  assert.equal(got.dependencies[0].id, build.id);
  assert.equal(got.readiness.ready, false);
});

test("plan rejects a bad plan without leaving partial records", async () => {
  const before = h.store.db.prepare("SELECT COUNT(*) AS n FROM epics").get().n;
  const dup = await h.call("backlog_plan", {
    epic: { title: "E" },
    stories: [{ title: "S", tasks: [{ title: "a", key: "k" }, { title: "b", key: "k" }] }],
  });
  assert.equal(dup.details.status, "rejected");
  const forward = await h.call("backlog_plan", {
    epic: { title: "E" },
    stories: [{ title: "S", tasks: [{ title: "a", dependsOn: ["s0t1"] }, { title: "b" }] }],
  });
  assert.equal(forward.details.status, "rejected");
  const unknown = await h.call("backlog_plan", {
    epic: { title: "E" },
    stories: [{ title: "S", tasks: [{ title: "a", dependsOn: ["nope"] }] }],
  });
  assert.equal(unknown.details.status, "rejected");
  assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM epics").get().n, before);
});

test("append adds tasks to a story, unassigned, with an appended row", async () => {
  const { story } = h.seedReadyTask();
  const res = await h.call("backlog_append", {
    storyId: story.id,
    tasks: [
      { title: "Handle CRLF input", description: "found while testing", capabilities: ["build"] },
      { title: "Add regression test", dependsOn: ["a0"] },
    ],
  }, { harness: "test", agent: "tester", session: "s-append" });
  assert.equal(res.details.status, "ok");
  const body = JSON.parse(res.content[0].text);
  const [first, second] = body.tasks;
  assert.equal(h.store.task.get(first.id).assigned, null);
  const appended = h.store.db.prepare("SELECT * FROM events WHERE task_id=? AND kind='task.appended'").all(first.id);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].actor, "test:tester");
  assert.equal(h.store.task.get(second.id).status, "todo");
});

test("append adds a story to an epic and rejects unknown references atomically", async () => {
  const epic = h.store.epic.create({ title: "E-append", status: "planned" });
  const res = await h.call("backlog_append", {
    epicId: epic.id,
    stories: [{ title: "Late story", acceptance: "AC-late", tasks: [{ title: "work", description: "do it" }] }],
  });
  assert.equal(res.details.status, "ok");
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.stories.length, 1);
  assert.equal(h.store.story.get(body.stories[0].id).assigned, null);
  const before = h.store.db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n;
  const bad = await h.call("backlog_append", { epicId: epic.id, stories: [{ title: "X", tasks: [{ title: "y", dependsOn: ["nope"] }] }] });
  assert.equal(bad.details.reason, "error");
  assert.equal(h.store.db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n, before);
  const missingEpic = await h.call("backlog_append", { epicId: "EPIC-nope", stories: [{ title: "X", tasks: [{ title: "y" }] }] });
  assert.equal(missingEpic.details.reason, "not_found");
});

test("drop disables unclaimed work and leaves a dropped row", async () => {
  const { story, task } = h.seedReadyTask();
  const res = await h.call("backlog_drop", { id: task.id, reason: "duplicate" });
  assert.equal(res.details.status, "ok");
  assert.equal(h.store.task.get(task.id).status, "cancelled");
  const ev = h.store.db.prepare("SELECT * FROM events WHERE task_id=? AND kind='task.dropped'").all(task.id);
  assert.equal(ev.length, 1);
  assert.match(ev[0].note, /duplicate/);
  assert.ok(h.store.story.get(story.id));
});

test("drop refuses claimed work and keeps it untouched", async () => {
  const { task } = h.seedReadyTask({ assigned: "atlas", taskStatus: "in_progress" });
  const refused = await h.call("backlog_drop", { id: task.id });
  assert.equal(refused.details.reason, "not_droppable");
  assert.equal(h.store.task.get(task.id).status, "in_progress");
});

test("drop cascades to a story's tasks and restore brings them back", async () => {
  const { story, task } = h.seedReadyTask();
  const second = h.store.task.create({ storyId: story.id, title: "dep", status: "todo", executionKind: "manual" });
  const { addDep } = await import("../../../src/deps.js");
  assert.ok(addDep(h.store, second.id, task.id).ok);
  assert.equal((await h.call("backlog_drop", { id: story.id })).details.status, "ok");
  assert.equal(h.store.story.get(story.id).status, "cancelled");
  assert.equal(h.store.task.get(task.id).status, "cancelled");
  assert.equal(h.store.dep.listOutgoing(second.id).length, 1);
  const restored = await h.call("backlog_restore", { id: story.id });
  assert.equal(restored.details.status, "ok");
  assert.equal(h.store.story.get(story.id).status, "ready");
  assert.equal(h.store.task.get(task.id).status, "todo");
  assert.equal(h.store.task.get(second.id).status, "todo");
  assert.equal((await h.call("backlog_restore", { id: story.id })).details.reason, "not_dropped");
});

test("drop of an unknown id and restore of a live item are refused", async () => {
  const { task } = h.seedReadyTask();
  assert.equal((await h.call("backlog_drop", { id: "TASK-nope" })).details.reason, "not_found");
  assert.equal((await h.call("backlog_restore", { id: task.id })).details.reason, "not_dropped");
});
