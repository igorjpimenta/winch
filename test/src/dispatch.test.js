// Core dispatch: route rows to admissions, admit under caps, and let exactly
// one executor win an offer.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../../src/store/index.js";
import { startEventServer, toEventMessage } from "../../src/events-ws.js";
import { observe, routesForEvent, tick } from "../../src/dispatch.js";

let dir, store, srv, sockets;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "winch-dispatch-"));
  store = createStore({
    dbPath: path.join(dir, "store.sqlite"),
    config: { dispatchMode: "core", dispatchOfferMs: 50, dispatchOfferBackoffMs: 10, dispatchOfferMaxBackoffMs: 20, dispatchOfferMaxAttempts: 3 },
  });
  sockets = [];
});
afterEach(async () => {
  for (const s of sockets) { try { s.close(); } catch { /* gone */ } }
  if (srv) await srv.close();
  srv = undefined;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function hierarchy() {
  const epic = store.epic.create({ title: "E", status: "in_progress" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "in_progress" });
  return { epic, story };
}

function seedAssigned({ agent = "worker", harness = "test", status = "backlog" } = {}) {
  const { story } = hierarchy();
  const task = store.task.create({ storyId: story.id, title: "T", status });
  store.task.assign({ id: task.id, agentId: agent, harness, actor: "test:atlas" });
  const row = store.db.prepare("SELECT * FROM item_events WHERE item_id=? ORDER BY id DESC LIMIT 1").get(task.id);
  return { task, row, msg: toEventMessage(store, row) };
}

function observeEvent(row) {
  const msg = toEventMessage(store, row);
  observe(store, msg);
  return msg;
}

test("routes an assignment and an append to the right target", () => {
  const { task, msg } = seedAssigned();
  const routes = routesForEvent(msg);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].itemId, task.id);
  assert.equal(routes[0].kind, "task");
  assert.equal(routes[0].agentId, "worker");
  assert.equal(routes[0].harness, "test");

  const epic = store.epic.create({ title: "E2", status: "in_progress", createdBy: "atlas" });
  const story = store.story.create({ epicId: epic.id, title: "S2", status: "in_progress" });
  const appended = store.task.create({ storyId: story.id, title: "A", status: "backlog", assigned: "worker", assigneeHarness: "test" });
  store.event.append({ itemId: appended.id, fromStatus: "ready", toStatus: "ready", kind: "task.appended", actor: "test:atlas" });
  const row = store.db.prepare("SELECT * FROM item_events WHERE item_id=? ORDER BY id DESC LIMIT 1").get(appended.id);
  const appendRoutes = routesForEvent(toEventMessage(store, row));
  const append = appendRoutes.find((r) => r.kind === "append");
  assert.ok(append, "the planner is woken for the append");
  assert.equal(append.itemId, epic.id, "append wakes the planner on the epic, not the task owner");
  assert.ok(appendRoutes.some((r) => r.kind === "task" && r.itemId === appended.id), "the assignee is woken for the new task");
});

test("one live admission per item and harness; duplicate rows collapse", () => {
  const { msg } = seedAssigned();
  observe(store, msg);
  observe(store, msg);
  assert.equal(store.admission.queued("test").length, 1);
  const first = tick(store, { reachable: ["test"] });
  assert.equal(first.length, 1);
  assert.equal(first[0].status, "offered");
  const again = tick(store, { reachable: ["test"] });
  assert.equal(again.length, 0, "an offered row is not offered twice");
});

test("per-harness and global caps hold the queue", () => {
  for (let i = 0; i < 3; i++) {
    const { row } = seedAssigned({ agent: "worker" });
    observeEvent(row);
  }
  const offered = tick(store, { reachable: ["test"], config: { ...store.config, dispatchHarnessMax: 2, dispatchGlobalMax: 2 } });
  assert.equal(offered.length, 2);
  assert.equal(store.admission.queued("test").length, 1);
});

test("in_progress activates and done releases the slot", () => {
  const { task, row } = seedAssigned();
  observeEvent(row);
  const [offer] = tick(store, { reachable: ["test"] });
  assert.equal(store.admission.accept(offer.id, { executorId: "A", harness: "test" }).granted, true);
  store.task.claim({ id: task.id, agentId: "worker", harness: "test", session: "s" });
  const claimRow = store.db.prepare("SELECT * FROM item_events WHERE item_id=? ORDER BY id DESC LIMIT 1").get(task.id);
  observeEvent(claimRow);
  assert.equal(store.admission.get(offer.id).status, "active");
  assert.equal(store.admission.slotCount("test"), 1);

  store.task.update(task.id, { status: "done", result_summary: "ok", actor: "worker" });
  const doneRow = store.db.prepare("SELECT * FROM item_events WHERE item_id=? ORDER BY id DESC LIMIT 1").get(task.id);
  observeEvent(doneRow);
  assert.equal(store.admission.get(offer.id).status, "done");
  assert.equal(store.admission.slotCount("test"), 0);
});

test("an expired offer releases capacity and retries with backoff", () => {
  const { row } = seedAssigned();
  observeEvent(row);
  const [offer] = tick(store, { reachable: ["test"] });
  store.db.prepare("UPDATE admission_attempts SET offered_at=? WHERE admission_id=?").run(Date.now() - 10_000, offer.id);
  const retried = tick(store, { reachable: ["test"] });
  assert.equal(retried.length, 0, "backoff holds the row out of the next tick");
  assert.equal(store.admission.get(offer.id).status, "expired");
  const after = tick(store, { at: Date.now() + 20, reachable: ["test"] });
  assert.equal(after.length, 1);
  assert.equal(after[0].status, "offered");
  assert.equal(after[0].offers, 2);
});

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    sockets.push(ws);
    ws.inbox = [];
    ws.onmessage = (e) => ws.inbox.push(JSON.parse(String(e.data)));
    const timer = setTimeout(() => reject(new Error("ws open timed out")), 5000);
    ws.onopen = () => { clearTimeout(timer); resolve(ws); };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error(`ws error: ${e?.message ?? "unknown"}`)); };
  });
}

function waitFor(ws, pred, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const i = ws.inbox.findIndex(pred);
      if (i >= 0) {
        clearInterval(timer);
        resolve(ws.inbox.splice(i, 1)[0]);
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out; inbox=${JSON.stringify(ws.inbox)}`));
      }
    }, 10);
  });
}

test("two gateways on one harness offer the wake, one accept wins", async () => {
  srv = await startEventServer({ store, port: 0, intervalMs: 20 });
  const a = await connect(srv.port);
  const b = await connect(srv.port);
  a.send(JSON.stringify({ type: "hello", executorId: "exec-a", harness: "test" }));
  b.send(JSON.stringify({ type: "hello", executorId: "exec-b", harness: "test" }));
  await waitFor(a, (f) => f.type === "hello_ok");
  await waitFor(b, (f) => f.type === "hello_ok");

  const { row } = seedAssigned();
  observeEvent(row);
  const [offerA, offerB] = await Promise.all([
    waitFor(a, (f) => f.type === "wake"),
    waitFor(b, (f) => f.type === "wake"),
  ]);
  assert.equal(offerA.admissionId, offerB.admissionId);
  a.send(JSON.stringify({ type: "wake_accept", admissionId: offerA.admissionId, executorId: "exec-a" }));
  b.send(JSON.stringify({ type: "wake_accept", admissionId: offerA.admissionId, executorId: "exec-b" }));
  const answers = await Promise.all([
    waitFor(a, (f) => f.type === "wake_granted" || f.type === "wake_taken"),
    waitFor(b, (f) => f.type === "wake_granted" || f.type === "wake_taken"),
  ]);
  assert.equal(answers.filter((f) => f.type === "wake_granted").length, 1);
  assert.equal(answers.filter((f) => f.type === "wake_taken").length, 1);
  assert.equal(store.admission.get(offerA.admissionId).status, "accepted");
});

test("offering a child moves the parent cursor to its childKey", () => {
  const { story } = hierarchy();
  const parent = store.task.create({ storyId: story.id, title: "P", status: "backlog" });
  const child = store.task.create({
    storyId: parent.id, title: "docs", status: "backlog", childKey: "docs",
    assigned: "worker", assigneeHarness: "test",
  });
  const row = store.db.prepare("SELECT * FROM item_events WHERE item_id=? ORDER BY id DESC LIMIT 1").get(child.id);
  observeEvent(row);
  const [offer] = tick(store, { reachable: ["test"] });
  assert.ok(offer);
  assert.equal(store.item.get(parent.id).current_child_key, "docs");
});

test("a server restart catches up on events written while it was down", async () => {
  srv = await startEventServer({ store, port: 0, intervalMs: 20 });
  await srv.close();
  const { row } = seedAssigned();
  srv = await startEventServer({ store, port: 0, intervalMs: 20 });
  const a = await connect(srv.port);
  a.send(JSON.stringify({ type: "hello", executorId: "exec-restart", harness: "test" }));
  const offer = await waitFor(a, (f) => f.type === "wake");
  assert.equal(offer.itemId, row.item_id);
});

test("a review wake is one-shot: its TTL ends it instead of retrying", () => {
  const epic = store.epic.create({ title: "E", status: "done", createdBy: "atlas" });
  observe(store, {
    type: "event", kind: "epic.completed", id: 999, epicCreatedBy: "atlas",
    item: { id: epic.id, kind: "epic", status: "done" },
  });
  const [offer] = tick(store, { reachable: ["test"] });
  assert.ok(offer);
  const result = store.admission.accept(offer.id, { executorId: "exec-review", harness: "test" });
  assert.equal(result.granted, true);
  assert.equal(store.admission.get(offer.id).status, "accepted");
  assert.equal(store.admission.globalSlotCount(), 1);
  tick(store, { at: Date.now() + 10_000, reachable: [] });
  assert.equal(store.admission.get(offer.id).status, "done");
  assert.equal(store.admission.globalSlotCount(), 0);
});

test("attempt state is normalized out of the admission queue", () => {
  const { row } = seedAssigned();
  observeEvent(row);
  const [offer] = tick(store, { reachable: ["test"] });
  const columns = store.db.prepare("PRAGMA table_info(admission_queue)").all().map((c) => c.name);
  for (const gone of ["executor_id", "offers", "offered_at", "accepted_at", "backoff_until", "admitted_at"]) {
    assert.ok(!columns.includes(gone), `${gone} is not a queue column`);
  }
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM admission_attempts WHERE admission_id=?").get(offer.id).n, 1);
  store.admission.accept(offer.id, { executorId: "A", harness: "test" });
  const attempt = store.db.prepare("SELECT * FROM admission_attempts WHERE admission_id=? AND ended_at IS NULL").get(offer.id);
  assert.equal(attempt.executor_id, "A");
  assert.ok(attempt.accepted_at);
});
