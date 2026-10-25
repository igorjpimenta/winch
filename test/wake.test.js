// wake.test.js — after-transition webhook poster: newly-ready tasks POST
// once each to the gateway hooks endpoint; nothing else posts, ever.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../src/store.js";
import { createToolHandlers } from "../src/tools.js";
import { addDep } from "../src/deps.js";
import { snapshotReadyIds, routeAgent, runWakes, buildWakeBody } from "../src/wake.js";

const ID = { harness: "test", agent: "atlas", session: "sess-1" };
const HOOK = {
  hookUrl: "http://127.0.0.1:18789/hooks/agent",
  hookToken: "test-token",
  wakeAgent: "atlas",
};

let dir, store, handle, posts;

function setup(config = {}) {
  dir = mkdtempSync(path.join(tmpdir(), "winch-wake-"));
  store = createStore({ dbPath: path.join(dir, "store.sqlite"), config });
  ({ handle } = createToolHandlers(store, null));
  posts = [];
}

function teardown() {
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

function stubFetch() {
  return async (url, opts) => {
    posts.push({ url, opts, body: JSON.parse(opts.body) });
    return { ok: true, status: 200 };
  };
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

test("disabled by default: done unblocking a dependent posts nothing", async () => {
  const { t1 } = seedChain();
  store.task.claim({ id: t1.id, agentId: "atlas", sessionKey: "test:atlas:sess-1" });
  const res = await call("backlog_done", { taskId: t1.id, resultSummary: "x" }, ID, { fetchFn: stubFetch() });
  assert.equal(res.details.status, "ok");
  assert.equal(posts.length, 0);
});

test("no token, no post: url without token stays silent", async () => {
  teardown(); setup({ hookUrl: HOOK.hookUrl, wakeAgent: "atlas" });
  const { t1 } = seedChain();
  store.task.claim({ id: t1.id, agentId: "atlas", sessionKey: "test:atlas:sess-1" });
  const res = await call("backlog_done", { taskId: t1.id, resultSummary: "x" }, ID, { fetchFn: stubFetch() });
  assert.equal(res.details.status, "ok");
  assert.equal(posts.length, 0);
});

test("done that newly frees a task POSTs once with auth + idempotency", async () => {
  teardown(); setup({ ...HOOK });
  const { t1, t2 } = seedChain();
  store.task.claim({ id: t1.id, agentId: "atlas", sessionKey: "test:atlas:sess-1" });
  const res = await call("backlog_done", { taskId: t1.id, resultSummary: "x" }, ID, { fetchFn: stubFetch() });
  assert.equal(res.details.status, "ok");
  assert.equal(posts.length, 1);
  const [p] = posts;
  assert.equal(p.url, HOOK.hookUrl);
  assert.equal(p.opts.method, "POST");
  assert.equal(p.opts.headers.Authorization, "Bearer test-token");
  assert.equal(p.opts.headers["Content-Type"], "application/json");
  assert.ok(typeof p.opts.headers["Idempotency-Key"] === "string" && p.opts.headers["Idempotency-Key"].length > 0);
  assert.equal(p.body.agentId, "atlas");
  assert.equal(p.body.deliver, false);
  assert.match(p.body.message, new RegExp(`^winch: ${t2.id} `));
});

test("already-ready tasks never re-fire across later transitions", async () => {
  teardown(); setup({ ...HOOK });
  const { t1, t2 } = seedChain();
  const before = snapshotReadyIds(store);
  assert.ok(before.has(t1.id));
  assert.ok(!before.has(t2.id));
  const r = await call("backlog_update", { taskId: t2.id, comment: "q" }, ID, { fetchFn: stubFetch() });
  assert.equal(r.details.status, "rejected");
  assert.equal(posts.length, 0);
});

test("caps routing prefers the mapped agent over the default", async () => {
  teardown(); setup({ ...HOOK, wakeRoutes: { gpu: "lens" } });
  const epic = store.epic.create({ title: "E", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready" });
  const t = store.task.create({ storyId: story.id, title: "T", status: "todo", executionKind: "manual", capabilities: ["gpu"] });
  const cands = [{ task: store.task.get(t.id), story }];
  assert.equal(routeAgent(cands[0], store.config), "lens");
  assert.equal(routeAgent({ task: { capabilities: [] }, story: {} }, store.config), "atlas");
  assert.equal(routeAgent({ task: {}, story: {} }, { wakeAgent: "" }), null);
});

test("assigned tasks are excluded even when newly ready", async () => {
  teardown(); setup({ ...HOOK });
  const epic = store.epic.create({ title: "E", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready" });
  const t = store.task.create({ storyId: story.id, title: "T", status: "todo", executionKind: "manual", assigned: "builder" });
  const fired = await runWakes({ store, beforeIds: new Set(), cfg: store.config, fetchFn: stubFetch() });
  assert.deepEqual(fired, []);
  assert.equal(posts.length, 0);
  assert.ok(t.id);
});

test("per-transition cap bounds the burst, overflow logged not lost", async () => {
  teardown(); setup({ ...HOOK, wakeMax: 1 });
  const epic = store.epic.create({ title: "E", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready" });
  store.task.create({ storyId: story.id, title: "A", status: "todo", executionKind: "manual" });
  store.task.create({ storyId: story.id, title: "B", status: "todo", executionKind: "manual" });
  const fired = await runWakes({ store, beforeIds: new Set(), cfg: store.config, fetchFn: stubFetch() });
  assert.equal(fired.length, 1);
  assert.equal(posts.length, 1);
});

test("post failure never fails the triggering call", async () => {
  teardown(); setup({ ...HOOK });
  const { t1 } = seedChain();
  store.task.claim({ id: t1.id, agentId: "atlas", sessionKey: "test:atlas:sess-1" });
  const boom = async () => { throw new Error("conn refused"); };
  const res = await call("backlog_done", { taskId: t1.id, resultSummary: "x" }, ID, { fetchFn: boom });
  assert.equal(res.details.status, "ok");
  assert.equal(store.task.get(t1.id).status, "done");
});

test("rejected calls post nothing", async () => {
  teardown(); setup({ ...HOOK });
  seedChain();
  const res = await call("backlog_done", { taskId: "TASK-nope", resultSummary: "x" }, ID, { fetchFn: stubFetch() });
  assert.equal(res.details.reason, "not_found");
  assert.equal(posts.length, 0);
});

test("buildWakeBody shapes the hook payload", () => {
  const b = buildWakeBody({ agent: "atlas", task: { id: "TASK-x", title: "T" } });
  assert.equal(b.agentId, "atlas");
  assert.equal(b.deliver, false);
  assert.match(b.message, /^winch: TASK-x /);
  assert.ok(b.name.length > 0);
});
