// wake.test.js — after-transition wake hook: newly-ready tasks fire exactly
// one turn each for the routed agent; nothing else spawns, ever.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../src/store.js";
import { createToolHandlers } from "../src/tools.js";
import { addDep } from "../src/deps.js";
import { snapshotReadyIds, routeAgent, runWakes, spawnWake } from "../src/wake.js";

const ID = { harness: "test", agent: "atlas", session: "sess-1" };

let dir, store, handle, calls, spawnFn;

function setup(config = {}) {
  dir = mkdtempSync(path.join(tmpdir(), "winch-wake-"));
  store = createStore({ dbPath: path.join(dir, "store.sqlite"), config });
  ({ handle } = createToolHandlers(store, null));
  calls = [];
  spawnFn = (bin, argv) => { calls.push([bin, argv]); return { unref() {} }; };
}

function teardown() {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

function seedChain() {
  const epic = store.epic.create({ title: "E", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready" });
  const t1 = store.task.create({ storyId: story.id, title: "T1", status: "todo", executionKind: "manual" });
  const t2 = store.task.create({ storyId: story.id, title: "T2", status: "todo", executionKind: "manual" });
  assert.ok(addDep(store, t2.id, t1.id).ok);
  return { epic, story, t1, t2 };
}

function call(name, args, identity = ID, hooks = {}) {
  return handle(name, args, identity, null, hooks);
}

beforeEach(() => setup());
afterEach(teardown);

test("disabled by default: done unblocking a dependent spawns nothing", async () => {
  const { t1 } = seedChain();
  store.task.claim({ id: t1.id, agentId: "atlas", sessionKey: "test:atlas:sess-1" });
  const res = await call("backlog_done", { taskId: t1.id, resultSummary: "x" }, ID, { spawnFn });
  assert.equal(res.details.status, "ok");
  assert.equal(calls.length, 0);
});

test("done that newly frees a task wakes the default agent once", async () => {
  teardown(); setup({ wakeAgent: "atlas" });
  const { t1, t2 } = seedChain();
  store.task.claim({ id: t1.id, agentId: "atlas", sessionKey: "test:atlas:sess-1" });
  const res = await call("backlog_done", { taskId: t1.id, resultSummary: "x" }, ID, { spawnFn });
  assert.equal(res.details.status, "ok");
  assert.equal(calls.length, 1);
  const [bin, argv] = calls[0];
  assert.equal(bin, "openclaw");
  assert.deepEqual(argv.slice(0, 3), ["agent", "--agent", "atlas"]);
  assert.match(argv[4], new RegExp(`^winch: ${t2.id} `));
});

test("already-ready tasks never re-fire across later transitions", async () => {
  teardown(); setup({ wakeAgent: "atlas" });
  const { t1, t2 } = seedChain();
  // t1 is ready from the start; a no-op (comment-only) update must not wake it.
  const r = await call("backlog_update", { taskId: t2.id, comment: "still queued" }, ID, { spawnFn });
  assert.equal(r.details.status, "rejected"); // todo, unclaimed — nothing changed
  assert.equal(calls.length, 0);
  const before = snapshotReadyIds(store);
  assert.ok(before.has(t1.id));
  assert.ok(!before.has(t2.id));
});

test("caps routing prefers the mapped agent over the default", async () => {
  teardown(); setup({ wakeAgent: "atlas", wakeRoutes: { gpu: "lens" } });
  const epic = store.epic.create({ title: "E", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready" });
  const t = store.task.create({ storyId: story.id, title: "T", status: "todo", executionKind: "manual", capabilities: ["gpu"] });
  const cands = [{ task: store.task.get(t.id), story }];
  assert.equal(routeAgent(cands[0], store.config), "lens");
  assert.equal(routeAgent({ task: { capabilities: [] }, story: {} }, store.config), "atlas");
  assert.equal(routeAgent({ task: {}, story: {} }, { wakeAgent: "" }), null);
});

test("assigned tasks are excluded even when newly ready", async () => {
  teardown(); setup({ wakeAgent: "atlas" });
  const epic = store.epic.create({ title: "E", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready" });
  const t = store.task.create({ storyId: story.id, title: "T", status: "todo", executionKind: "manual", assigned: "builder" });
  const fired = runWakes({ store, beforeIds: new Set(), cfg: store.config, spawnFn });
  assert.deepEqual(fired, []);
  assert.equal(calls.length, 0);
  assert.ok(t.id);
});

test("per-transition cap bounds the stampede, overflow logged not lost", async () => {
  teardown(); setup({ wakeAgent: "atlas", wakeMax: 1 });
  const epic = store.epic.create({ title: "E", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready" });
  store.task.create({ storyId: story.id, title: "A", status: "todo", executionKind: "manual" });
  store.task.create({ storyId: story.id, title: "B", status: "todo", executionKind: "manual" });
  const fired = runWakes({ store, beforeIds: new Set(), cfg: store.config, spawnFn });
  assert.equal(fired.length, 1);
  assert.equal(calls.length, 1);
});

test("hostile ids refuse instead of spawning", async () => {
  assert.throws(() => spawnWake({ bin: "openclaw", agent: "atlas; rm -rf /", task: { id: "TASK-x", title: "t" }, spawnFn }));
  assert.throws(() => spawnWake({ bin: "openclaw", agent: "atlas", task: { id: "TASK-x$(id)", title: "t" }, spawnFn }));
  assert.equal(calls.length, 0);
});

test("rejected calls wake nothing", async () => {
  teardown(); setup({ wakeAgent: "atlas" });
  seedChain();
  const res = await call("backlog_done", { taskId: "TASK-nope", resultSummary: "x" }, ID, { spawnFn });
  assert.equal(res.details.reason, "not_found");
  assert.equal(calls.length, 0);
});
