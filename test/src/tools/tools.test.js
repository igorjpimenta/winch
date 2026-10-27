// tools.test.js — cross-tool integration: the paths that only work when the
// modules agree. Per-module behaviour lives in claim/plan/read/report/assign.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { makeHarness, ATLAS, WORKER } from "./_harness.js";

let h;
beforeEach(() => { h = makeHarness("winch-integration-"); });
afterEach(() => h.teardown());

test("a claim carries the store-only handoff: acceptance, artifacts, receiver prompt", async () => {
  const { story, task } = h.seedReadyTask();
  h.store.db.prepare("INSERT INTO events(task_id,from_status,to_status,actor,note,at) VALUES(?,?,?,?,?,?)")
    .run(task.id, "todo", "todo", "atlas", "artifact: https://example.test/upstream", Date.now());
  const res = await h.call("backlog_claim", { taskId: task.id });
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.handoff.acceptance_criteria, "AC-1");
  assert.deepEqual(body.handoff.artifacts, ["https://example.test/upstream"]);
  assert.match(body.handoff.receiverPrompt, /## Acceptance\nAC-1/);
  assert.ok(story.id);
});

test("an artifact added mid-flight reaches the next claim on the story", async () => {
  const { story, task } = h.seedReadyTask();
  const next = h.store.task.create({ storyId: story.id, title: "next", status: "todo", executionKind: "manual" });
  await h.call("backlog_claim", { taskId: task.id });
  await h.call("backlog_update", { taskId: task.id, addArtifact: "https://example.test/mid" });
  await h.call("backlog_done", { taskId: task.id, resultSummary: "done" });
  const claimed = await h.call("backlog_claim", { taskId: next.id });
  const body = JSON.parse(claimed.content[0].text);
  assert.ok(body.handoff.artifacts.includes("https://example.test/mid"));
});

test("plan → claim → done makes the dependent task claimable by its own worker", async () => {
  const planned = await h.call("backlog_plan", {
    epic: { title: "E2E", acceptance: "works" },
    stories: [{
      title: "S",
      acceptance: "AC",
      tasks: [
        { title: "build", description: "build it", capabilities: ["build"] },
        { title: "verify", description: "check it", capabilities: ["verify"], dependsOn: ["s0t0"] },
      ],
    }],
  });
  const body = JSON.parse(planned.content[0].text);
  const [build, verify] = body.stories[0].tasks;
  await h.call("backlog_assign", { id: build.id, agent: "worker" });
  await h.call("backlog_assign", { id: verify.id, agent: "worker" });
  const beforeVerify = await h.call("backlog_claim", { taskId: verify.id }, WORKER);
  assert.equal(beforeVerify.details.reason, "not_ready");
  const built = await h.call("backlog_claim", { taskId: build.id, capabilities: ["build"] }, WORKER);
  assert.equal(built.details.status, "ok");
  await h.call("backlog_done", { taskId: build.id, resultSummary: "built" }, WORKER);
  const verified = await h.call("backlog_claim", { taskId: verify.id, capabilities: ["verify"] }, WORKER);
  assert.equal(verified.details.status, "ok");
});

test("a ready-queue claim never takes a task assigned to someone else", async () => {
  const mine = h.seedReadyTask({ assigned: "atlas" });
  const theirs = h.seedReadyTask({ assigned: "worker" });
  const claimed = await h.call("backlog_claim", {});
  assert.equal(claimed.details.taskId, mine.task.id);
  const second = await h.call("backlog_claim", {});
  assert.equal(second.details.status, "empty");
  assert.equal(h.store.task.get(theirs.task.id).assigned, "worker");
});

test("a task read by the assignee shows the same brief the claim would hand off", async () => {
  const { task } = h.seedReadyTask({ assigned: "atlas" });
  const read = JSON.parse((await h.call("backlog_get", { id: task.id })).content[0].text);
  const claimed = JSON.parse((await h.call("backlog_claim", { taskId: task.id })).content[0].text);
  assert.equal(read.brief, claimed.handoff.receiverPrompt);
});
