// backlog_delegate: the parent stays with the accountable; the child carries
// the worker. Closing the child returns the parent to ready.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HUMAN_AGENT, HUMAN_HARNESS } from "../../../../src/reserved.js";
import { tick } from "../../../../src/watcher.js";
import { ATLAS, WORKER, makeHarness } from "./_harness.js";

let h;
beforeEach(() => { h = makeHarness("winch-delegate-"); });
afterEach(() => h.teardown());

test("delegation parks the parent and returns it when the child closes", async () => {
  const { task } = h.seedReadyTask();
  const res = await h.call("backlog_delegate", { taskId: task.id, agent: "worker", title: "child" });
  assert.equal(res.details.status, "ok");

  const parent = h.store.task.get(task.id);
  assert.equal(parent.status, "blocked");
  assert.equal(parent.assignee_agent, "atlas");
  assert.equal(parent.state_json.wait.kind, "deps");
  assert.equal(parent.state_json.wait.childId, res.details.childId);

  const child = h.store.task.get(res.details.childId);
  assert.equal(child.parent_id, task.id);
  assert.equal(child.status, "ready");
  assert.equal(child.assignee_agent, "worker");
  assert.deepEqual(h.store.dep.listOutgoing(task.id).map((e) => e.to_id), [child.id]);

  assert.equal((await h.call("backlog_claim", { taskId: child.id }, WORKER)).details.status, "ok");
  assert.equal((await h.call("backlog_done", { taskId: child.id, resultSummary: "done" }, WORKER)).details.status, "ok");

  const returned = h.store.task.get(task.id);
  assert.equal(returned.status, "ready");
  assert.equal(returned.assignee_agent, "atlas");
  assert.equal(returned.state_json.wait, undefined);
  const m = tick(h.store);
  assert.ok(m.routed.some((r) => r.taskId === task.id), "the accountable is woken for the returned parent");
});

test("human children carry the reserved pair and never the accountable", async () => {
  const { task } = h.seedReadyTask();
  const res = await h.call("backlog_delegate", { taskId: task.id, agent: HUMAN_AGENT, title: "human work" });
  const child = h.store.task.get(res.details.childId);
  assert.equal(child.assignee_agent, HUMAN_AGENT);
  assert.equal(child.assignee_harness, HUMAN_HARNESS);
  assert.equal(h.store.task.get(task.id).assignee_agent, "atlas");
});

test("only the accountable can delegate, and a live parent is released", async () => {
  const { task } = h.seedReadyTask({ assigned: "other" });
  const refused = await h.call("backlog_delegate", { taskId: task.id, agent: "worker", title: "child" });
  assert.equal(refused.details.reason, "not_assignee");

  const mine = h.seedReadyTask().task;
  h.store.task.claim({ id: mine.id, agentId: "atlas", harness: "test" });
  const res = await h.call("backlog_delegate", { taskId: mine.id, agent: "worker", title: "child" });
  assert.equal(res.details.status, "ok");
  assert.equal(h.store.attempt.list({ itemId: mine.id, live: true }).length, 0);
});

test("terminal, already-blocked and unassigned parents behave", async () => {
  const terminal = h.seedReadyTask({ taskStatus: "done" }).task;
  const done = await h.call("backlog_delegate", { taskId: terminal.id, agent: "worker", title: "child" });
  assert.equal(done.details.reason, "rejected");

  const unassigned = h.seedReadyTask({ assigned: null, taskStatus: "backlog" }).task;
  const adopted = await h.call("backlog_delegate", { taskId: unassigned.id, agent: "worker", title: "child" });
  assert.equal(adopted.details.status, "ok");
  assert.equal(h.store.task.get(unassigned.id).assignee_agent, "atlas");
  assert.equal(h.store.task.get(unassigned.id).status, "blocked");

  const again = await h.call("backlog_delegate", { taskId: unassigned.id, agent: "worker", title: "more" });
  assert.equal(again.details.status, "ok", "a dependency-blocked parent accepts a parallel child");
  assert.equal(h.store.task.get(unassigned.id).status, "blocked");
  assert.equal(h.store.item.children(unassigned.id).length, 2);

  const plain = h.seedReadyTask().task;
  h.store.task.claim({ id: plain.id, agentId: "atlas", harness: "test" });
  h.store.task.openGate({ id: plain.id, gateType: "architecture", reason: "test", actor: "atlas" });
  const refused = await h.call("backlog_delegate", { taskId: plain.id, agent: "worker", title: "child" });
  assert.equal(refused.details.reason, "rejected", "a non-dependency block is not a fan-out parent");
});

test("childKey makes delegation retry-safe and visitSeq starts a new round", async () => {
  const { task } = h.seedReadyTask();
  const first = await h.call("backlog_delegate", { taskId: task.id, agent: "worker", title: "docs", childKey: "docs" });
  assert.equal(first.details.status, "ok");
  const second = await h.call("backlog_delegate", { taskId: task.id, agent: "worker", title: "docs", childKey: "docs" });
  assert.equal(second.details.status, "ok");
  assert.equal(second.details.reused, true);
  assert.equal(second.details.childId, first.details.childId);

  const third = await h.call("backlog_delegate", { taskId: task.id, agent: "worker", title: "docs again", childKey: "docs", visitSeq: 1 });
  assert.equal(third.details.status, "ok");
  assert.notEqual(third.details.childId, first.details.childId);

  const child = h.store.task.get(first.details.childId);
  assert.equal(child.child_key, "docs");
  assert.equal(child.visit_seq, 0);
  assert.equal(child.state_json.fanout.parentSessionId, h.store.session.forItem(task.id).find((s) => s.external_session_id === ATLAS.session).id);

  assert.equal((await h.call("backlog_claim", { taskId: child.id }, WORKER)).details.status, "ok");
  const session = h.store.session.forItem(child.id).find((s) => s.external_session_id === WORKER.session);
  assert.equal(session.kind, "fanout");
  assert.equal(session.parent_session_id, child.state_json.fanout.parentSessionId);
});
