// tools.test.js — agent tools: caller identity, claim, guards, audit events.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../src/store.js";
import { createToolHandlers, SESSION_TOOL_BUDGETS } from "../src/tools.js";

let dir, store, handle;

const DEFAULT_IDENTITY = { harness: "test", agent: "atlas", session: "sess-1" };

function setup() {
  dir = mkdtempSync(path.join(tmpdir(), "winch-tools-"));
  store = createStore({ dbPath: path.join(dir, "store.sqlite") });
  ({ handle } = createToolHandlers(store, null));
}

function teardown() {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

function call(name, args, identity = DEFAULT_IDENTITY) {
  return handle(name, args, identity);
}

function seedReadyTask({ assigned = null, taskStatus = "todo" } = {}) {
  const epic = store.epic.create({ title: "E", status: "planned", priority: 80 });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready", acceptance: "AC-1", priority: 70 });
  const task = store.task.create({ storyId: story.id, title: "T", status: taskStatus, executionKind: "manual", assigned });
  return { epic, story, task };
}

beforeEach(setup);
afterEach(teardown);

test("backlog_next claims the task for the session's agent, with handoff payload", async () => {
  const { story, task } = seedReadyTask();
  const res = await call("backlog_next", {});
  assert.equal(res.details.status, "ok");
  assert.equal(res.details.agentId, "atlas");
  assert.equal(res.details.taskId, task.id);
  const body = JSON.parse(res.content[0].text);
  assert.equal(body.task.status, "in_progress");
  assert.equal(body.task.assigned, "atlas");
  assert.equal(body.handoff.acceptance_criteria, "AC-1");
  const ev = store.db.prepare("SELECT * FROM events WHERE task_id=?").all(task.id);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].note, "claim");
  assert.equal(ev[0].session_ref, "test:atlas:sess-1");
  assert.ok(story.id);
});

test("backlog_next dryRun reports without claiming", async () => {
  seedReadyTask();
  const res = await call("backlog_next", { dryRun: true });
  assert.equal(res.details.dryRun, true);
  assert.equal(store.task.list({ status: "todo" }).length, 1);
});

test("backlog_next returns empty when no story is ready", async () => {
  const epic = store.epic.create({ title: "E", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "backlog" });
  store.task.create({ storyId: story.id, title: "T" });
  const res = await call("backlog_next", {});
  assert.equal(res.details.status, "empty");
});

test("backlog_done: foreign agent rejected, assignee succeeds with event", async () => {
  const { task } = seedReadyTask({ assigned: "atlas", taskStatus: "in_progress" });
  const wrong = await call("backlog_done", { taskId: task.id, resultSummary: "x" }, { harness: "test", agent: "scout", session: "s-1" });
  assert.equal(wrong.details.reason, "not_assignee");
  const right = await call("backlog_done", { taskId: task.id, resultSummary: "shipped", artifacts: ["pr:1"] });
  assert.equal(right.details.status, "ok");
  const t = store.task.get(task.id);
  assert.equal(t.status, "done");
  assert.match(t.result_summary, /artifacts: pr:1/);
  const ev = store.db.prepare("SELECT note FROM events WHERE task_id=? AND to_status='done'").all(task.id);
  assert.equal(ev.length, 1);
});

test("backlog_done on a non-claimed task is rejected", async () => {
  const { task } = seedReadyTask();
  const res = await call("backlog_done", { taskId: task.id, resultSummary: "x" });
  assert.equal(res.details.reason, "not_claimed");
});

test("backlog_update heartbeats and appends a progress event", async () => {
  const { task } = seedReadyTask({ assigned: "atlas", taskStatus: "in_progress" });
  const res = await call("backlog_update", { taskId: task.id, progressSummary: "half way" });
  assert.equal(res.details.status, "ok");
  const t = store.task.get(task.id);
  assert.ok(t.last_heartbeat > 0);
  const ev = store.db.prepare("SELECT note FROM events WHERE task_id=? AND note LIKE 'progress%'").all(task.id);
  assert.equal(ev.length, 1);
});

test("backlog_update rejects an unclaimed task", async () => {
  const { task } = seedReadyTask();
  const res = await call("backlog_update", { taskId: task.id });
  assert.equal(res.details.reason, "not_claimed");
});

test("backlog_block blocks and adds the declared dependency", async () => {
  const { task } = seedReadyTask({ assigned: "atlas", taskStatus: "in_progress" });
  const blocker = store.epic.create({ title: "other", status: "planned" });
  const res = await call("backlog_block", { taskId: task.id, reason: "waiting on vendor", blockedBy: { kind: "epic", id: blocker.id } });
  assert.equal(res.details.status, "ok");
  assert.equal(res.details.dep, "added");
  assert.equal(store.task.get(task.id).status, "blocked");
  const deps = store.dep.listOutgoing(task.id);
  assert.equal(deps.length, 1);
  assert.equal(deps[0].to_id, blocker.id);
});

test("backlog_block rejects a task assigned to another agent", async () => {
  const { task } = seedReadyTask({ assigned: "builder", taskStatus: "in_progress" });
  const res = await call("backlog_block", { taskId: task.id, reason: "x" }, { harness: "test", agent: "atlas", session: "s-1" });
  assert.equal(res.details.reason, "not_assignee");
});

test("backlog_resume resumes a gated task for the caller, and rejects a second resume", async () => {
  const { task } = seedReadyTask({ assigned: "builder", taskStatus: "in_progress" });
  store.task.openGate({ id: task.id, gateType: "release", reason: "sign-off", actor: "builder" });
  const res = await call("backlog_resume", { taskId: task.id }, { harness: "test", agent: "operator", session: "op-1" });
  assert.equal(res.details.status, "ok");
  assert.equal(res.details.taskId, task.id);
  const t = store.task.get(task.id);
  assert.equal(t.status, "todo");
  assert.equal(t.assigned, null);
  const again = await call("backlog_resume", { taskId: task.id }, { harness: "test", agent: "operator", session: "op-1" });
  assert.equal(again.details.reason, "not_resumable");
});

// ───────────────────────────────────────────────────── S1.3 session budgets

test("per-agent budgets match the plan's two-key termination table", () => {
  assert.deepEqual(SESSION_TOOL_BUDGETS, { atlas: 120, scout: 40, forge: 60, builder: 120, lens: 60, herald: 40 });
});

test("budget exhausts new claims, latches, and never blocks completion", async () => {
  SESSION_TOOL_BUDGETS["bud"] = 2;
  try {
    const identity = { harness: "test", agent: "bud", session: "sess-1" };
    const { task } = seedReadyTask({ assigned: "bud", taskStatus: "in_progress" });
    seedReadyTask(); // unassigned claimable candidate for dryRun

    const first = await call("backlog_next", { dryRun: true }, identity);
    assert.equal(first.details.status, "ok");
    const second = await call("backlog_next", { dryRun: true }, identity);
    assert.equal(second.details.status, "budget_exhausted");
    assert.match(second.content[0].text, /Session budget exhausted/);

    // event row on the session's in-progress task
    const ev = store.db.prepare("SELECT note FROM events WHERE task_id=? AND note LIKE 'session budget%'").all(task.id);
    assert.equal(ev.length, 1);
    assert.match(ev[0].note, /2\/2/);

    // latched — budget key is the resolved harness:agent:session triple
    const row = store.sessionBudget.get("test:bud:sess-1");
    assert.ok(row.exhausted_at > 0);

    // completion still allowed after exhaustion (finish, don't strand)
    const done = await call("backlog_done", { taskId: task.id, resultSummary: "closed despite budget" }, identity);
    assert.equal(done.details.status, "ok");
    assert.equal(done.details.budget.exhausted, true);
    assert.equal(store.task.get(task.id).status, "done");
  } finally {
    delete SESSION_TOOL_BUDGETS["bud"];
  }
});

test("unknown agents fall back to the default budget", async () => {
  const identity = { harness: "test", agent: "random-agent", session: "sess-1" };
  seedReadyTask();
  const res = await call("backlog_next", { dryRun: true }, identity);
  assert.equal(res.details.status, "ok");
  assert.equal(res.details.agentId, "random-agent");
});

// ────────────────────────────────────────────── S1.5 handoff payload contract

test("handoff carries the store-only payload: acceptance, upstream artifacts, receiverPrompt", async () => {
  const epic = store.epic.create({ title: "E2E epic", status: "planned", priority: 80 });
  const story = store.story.create({ epicId: epic.id, title: "JTBD discovery", status: "ready", acceptance: "Users can file in 2 taps", priority: 70 });
  const up = store.task.create({ storyId: story.id, title: "Interview synthesis", executionKind: "manual" });
  store.task.update(up.id, { status: "done", result_summary: "done\nartifacts: docs/jtbd.md, notes/wave1.md", actor: "scout", note: "done" });
  store.task.create({ storyId: story.id, title: "Write scope doc", executionKind: "manual" });

  const res = await call("backlog_next", {}, { harness: "test", agent: "forge", session: "sess-9" });
  assert.equal(res.details.agentId, "forge");
  const body = JSON.parse(res.content[0].text);
  assert.deepEqual(
    Object.keys(body.handoff).sort(),
    ["acceptance_criteria", "artifacts", "priority", "reason", "receiverPrompt"]
  );
  assert.equal(body.handoff.acceptance_criteria, "Users can file in 2 taps");
  assert.deepEqual([...body.handoff.artifacts].sort(), ["docs/jtbd.md", "notes/wave1.md"]);
  assert.match(body.handoff.receiverPrompt, /# Task: Write scope doc/);
  assert.match(body.handoff.receiverPrompt, /Users can file in 2 taps/);
  assert.match(body.handoff.receiverPrompt, /- docs\/jtbd\.md/);
  assert.match(body.handoff.receiverPrompt, /E2E epic — JTBD discovery/);
});

test("addArtifact records mid-flight and flows into the next claim's handoff", async () => {
  const epic = store.epic.create({ title: "E", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready", acceptance: "AC" });
  const first = store.task.create({ storyId: story.id, title: "T1", executionKind: "manual" });
  const second = store.task.create({ storyId: story.id, title: "T2", executionKind: "manual" });

  const identity = { harness: "test", agent: "scout", session: "s-1" };
  const claimed = await call("backlog_next", {}, identity);
  assert.equal(JSON.parse(claimed.content[0].text).task.id, first.id);
  const upd = await call("backlog_update", { taskId: first.id, addArtifact: "/artifacts/scope-draft.md" }, identity);
  assert.equal(upd.details.status, "ok");
  const ev = store.db.prepare("SELECT note FROM events WHERE task_id=? AND note LIKE 'artifact:%'").all(first.id);
  assert.equal(ev[0].note, "artifact: /artifacts/scope-draft.md");
  await call("backlog_done", { taskId: first.id, resultSummary: "done" }, identity);

  const next = await call("backlog_next", {}, identity);
  const body = JSON.parse(next.content[0].text);
  assert.equal(body.task.id, second.id);
  assert.deepEqual(body.handoff.artifacts, ["/artifacts/scope-draft.md"]);
  assert.match(body.handoff.receiverPrompt, /- \/artifacts\/scope-draft\.md/);
});

test("receiverPrompt derives only from store rows — params and session cannot enter", async () => {
  const epic = store.epic.create({ title: "E", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready", acceptance: "AC" });
  store.task.create({ storyId: story.id, title: "T", executionKind: "manual" });
  const res = await call("backlog_next", { capabilities: ["SENTINEL-CAP"] }, { harness: "test", agent: "scout", session: "SENTINEL-SESSION" });
  const prompt = JSON.parse(res.content[0].text).handoff.receiverPrompt;
  assert.ok(!prompt.includes("SENTINEL"), "prompt must not contain call params or session identity");
});

// ───────────────────────────────────────────────────── S3.1 empty-wake metric
test("empty backlog_next wakes are counted per session (wasted-wake metric)", async () => {
  const epic = store.epic.create({ title: "E", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready" });
  store.task.create({ storyId: story.id, title: "T", executionKind: "manual" });
  // no ready task → this claim finds nothing even though tasks exist elsewhere
  store.story.update(story.id, { status: "backlog" });

  const identity = { harness: "test", agent: "scout", session: "wake-metric" };
  const first = await call("backlog_next", {}, identity);
  assert.equal(first.details.status, "empty");
  let row = store.sessionBudget.get("test:scout:wake-metric");
  assert.equal(row.empty_wakes, 1);

  const second = await call("backlog_next", {}, identity);
  assert.equal(second.details.status, "empty");
  row = store.sessionBudget.get("test:scout:wake-metric");
  assert.equal(row.empty_wakes, 2);
  assert.equal(row.tool_calls, 2);

  const ratio = store.sessionBudget.wastedWakeRatio();
  assert.equal(ratio.empty, 2);
  assert.equal(ratio.calls, 2);
  assert.equal(ratio.ratio, 1);

  // a productive wake moves the ratio down
  store.story.update(story.id, { status: "ready" });
  const claimed = await call("backlog_next", {}, identity);
  assert.equal(claimed.details.status, "ok");
  const after = store.sessionBudget.wastedWakeRatio();
  assert.equal(after.empty, 2);
  assert.equal(after.calls, 3);
  assert.ok(after.ratio < 1);
});

// ──────────────────────────────────── poisoned identity fails the call
test("handle refuses an unknown-flavoured identity instead of minting a key", async () => {
  seedReadyTask();
  await assert.rejects(
    () => handle("backlog_next", {}, { harness: "test", agent: "unknown", session: "s-1" }),
    /refused caller identity for backlog_next.*agent/
  );
  await assert.rejects(
    () => handle("backlog_next", {}, { harness: "test", agent: "builder", session: "instance:999" }),
    /bad layers: session/
  );
  // and nothing was charged or claimed in the attempt
  assert.equal(store.task.list({ status: "todo" }).length, 1);
});
