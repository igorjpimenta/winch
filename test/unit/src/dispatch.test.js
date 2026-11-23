// Core dispatch: route rows to admissions, deliver over HTTP, and recover
// assigned work after a harness restart.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { createStore } from "../../../src/store/index.js";
import { toEventMessage } from "../../../src/events-ws.js";
import { startDispatchServer } from "../../../src/dispatch-server.js";
import { recover, observe, routesForEvent, tick } from "../../../src/dispatch.js";
import { deliverDue, deliverWake } from "../../../src/dispatch-webhook.js";
import { StaleRegistrationError } from "../../../src/store/webhook.js";

let dir, store, srv, receiver;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "winch-dispatch-"));
  store = createStore({
    dbPath: path.join(dir, "store.sqlite"),
    config: { dispatchOfferMs: 50, dispatchOfferBackoffMs: 10, dispatchOfferMaxBackoffMs: 20, dispatchOfferMaxAttempts: 3, dispatchDeliveryBackoffMs: 10, dispatchDeliveryMaxBackoffMs: 20, dispatchDeliveryMaxAttempts: 3, dispatchDeliveryFailureThreshold: 4, webhookTimeoutMs: 1000 },
  });
});
afterEach(async () => {
  if (receiver) await receiver.close();
  receiver = undefined;
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

async function wakeReceiver({ bearer = "tok", status = 202 } = {}) {
  const rows = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      rows.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      res.statusCode = status;
      res.end(JSON.stringify({ ok: status >= 200 && status < 300 }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/wake`,
    bearertoken: bearer,
    rows,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
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

test("completion wakes the unblocked task, not the completed task", () => {
  const first = seedAssigned({ agent: "worker" });
  const second = seedAssigned({ agent: "worker" });

  store.task.claim({ id: first.task.id, agentId: "worker", harness: "test", session: "s" });
  store.task.update(first.task.id, { status: "done", result_summary: "ok", actor: "worker" });

  const live = store.db.prepare("SELECT item_id FROM admission_queue WHERE ended_at IS NULL").all();
  assert.equal(live.some((row) => row.item_id === first.task.id), false, "a completed item must not be re-admitted");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM admission_attempts WHERE admission_id IN (SELECT id FROM admission_queue WHERE item_id=?) AND ended_at IS NULL").get(first.task.id).n, 0);
  assert.ok(live.some((row) => row.item_id === second.task.id), "ready work remains admitted");

  store.task.claim({ id: second.task.id, agentId: "worker", harness: "test", session: "s" });
  store.task.update(second.task.id, { status: "done", result_summary: "ok", actor: "worker" });
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM admission_queue WHERE ended_at IS NULL").get().n, 0);
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

test("webhook delivery sends the admission id and bearer", async () => {
  receiver = await wakeReceiver();
  store.webhook.upsert({ topic: "dispatch", id: "exec-a", harness: "test", executorId: "exec-a", url: receiver.url, bearer: "tok" });
  const { row } = seedAssigned();
  observeEvent(row);
  const [offer] = tick(store, { reachable: ["test"] });
  const result = await deliverWake(store, offer);
  assert.equal(result.ok, true);
  assert.equal(receiver.rows.length, 1);
  assert.equal(receiver.rows[0].auth, "Bearer tok");
  assert.equal(receiver.rows[0].body.type, "wake");
  assert.equal(receiver.rows[0].body.admissionId, offer.id);
  assert.equal(receiver.rows[0].body.itemId, row.item_id);
  assert.equal(receiver.rows[0].body.attemptNo, offer.attempt_no);
  assert.equal(store.admission.get(offer.id).status, "offered");
});

test("delivery disables a webhook that answers 410", async () => {
  receiver = await wakeReceiver({ status: 410 });
  store.webhook.upsert({ topic: "dispatch", id: "exec-dead", harness: "test", executorId: "exec-dead", url: receiver.url, bearer: "tok" });
  const { row } = seedAssigned();
  observeEvent(row);
  const [offer] = tick(store, { reachable: ["test"] });
  const result = await deliverWake(store, offer);
  assert.equal(result.ok, false);
  assert.equal(store.webhook.get({ topic: "dispatch", id: "exec-dead" }).state, "disabled");
  assert.equal(store.webhook.forHarness("test").length, 0);
});

test("delivery marks an unreachable webhook suspect, not gone", async () => {
  store.webhook.upsert({ topic: "dispatch", id: "exec-gone", harness: "test", executorId: "exec-gone", url: "http://127.0.0.1:1/wake", bearer: "tok" });
  const { row } = seedAssigned();
  observeEvent(row);
  const [offer] = tick(store, { reachable: ["test"] });
  const result = await deliverWake(store, offer);
  assert.equal(result.ok, false);
  const current = store.webhook.get({ topic: "dispatch", id: "exec-gone" });
  assert.equal(current.state, "suspect");
  assert.equal(current.failureCount, 1);
});

test("stale managed registrations are pruned; manual and disabled rows stay", () => {
  store.webhook.upsert({ topic: "dispatch", id: "c-old", harness: "test", instanceId: "i1", url: "http://127.0.0.1:1/wake", bearer: "tok", at: 1000, leaseMs: 100 });
  store.webhook.upsert({ topic: "dispatch", id: "c-new", harness: "test", instanceId: "i2", url: "http://127.0.0.1:2/wake", bearer: "tok", at: 5000, leaseMs: 100 });
  store.webhook.upsert({ topic: "dispatch", id: "manual", harness: "test", url: "http://127.0.0.1:3/wake", bearer: "tok", at: 1000 });
  store.webhook.upsert({ topic: "dispatch", id: "off", harness: "test", instanceId: "i3", url: "http://127.0.0.1:4/wake", bearer: "tok", at: 1000, leaseMs: 100 });
  store.webhook.recordFailure({ topic: "dispatch", id: "off", status: 500, permanent: true, at: 1001 });
  assert.equal(store.webhook.prune({ topic: "dispatch", before: 3000 }), 1);
  assert.deepEqual(store.webhook.list({ topic: "dispatch" }).map((w) => w.id), ["c-new", "manual", "off"]);
});

test("claim records the winning consumer for resume", () => {
  const { task, row } = seedAssigned();
  observeEvent(row);
  const [offer] = tick(store, { reachable: ["test"] });
  store.task.claim({ id: task.id, agentId: "worker", harness: "test", session: "s", consumerId: "consumer-a" });
  const claimRow = store.db.prepare("SELECT * FROM item_events WHERE item_id=? ORDER BY id DESC LIMIT 1").get(task.id);
  observeEvent(claimRow);

  const attempt = store.db.prepare("SELECT consumer_id FROM admission_attempts WHERE admission_id=? ORDER BY attempt_no DESC LIMIT 1").get(offer.id);
  assert.equal(attempt.consumer_id, "consumer-a");
  const mine = recover(store, { harness: "test", consumerId: "consumer-a" });
  assert.deepEqual(mine.resume.map((r) => r.task.id), [task.id]);
  assert.equal(mine.resume[0].consumerId, "consumer-a");
  assert.equal(mine.resume[0].leaseEpoch, 1);
  const other = recover(store, { harness: "test", consumerId: "consumer-b" });
  assert.deepEqual(other.resume, []);
});

test("recover returns in-progress resume work and fills free slots", () => {
  const first = seedAssigned({ agent: "worker" });
  const second = seedAssigned({ agent: "worker" });
  observeEvent(first.row);
  observeEvent(second.row);
  const [offer] = tick(store, { reachable: ["test"] });
  store.task.claim({ id: first.task.id, agentId: "worker", harness: "test", session: "s" });
  const claimRow = store.db.prepare("SELECT * FROM item_events WHERE item_id=? ORDER BY id DESC LIMIT 1").get(first.task.id);
  observeEvent(claimRow);

  const result = recover(store, { harness: "test", config: { ...store.config, dispatchHarnessMax: 4 } });
  assert.equal(result.resume.length, 1);
  assert.equal(result.resume[0].task.id, first.task.id);
  assert.ok(result.resume[0].attemptId);
  assert.ok(result.start.some((r) => r.admissionId === offer.id || r.itemId === second.task.id));
});

test("recover requeues offers beyond the cap, keeping the oldest", () => {
  for (let i = 0; i < 4; i++) {
    const { row } = seedAssigned({ agent: `worker-${i}` });
    observeEvent(row);
  }
  const offers = tick(store, {
    reachable: ["test"],
    at: 1000,
    config: { ...store.config, dispatchHarnessMax: 4, dispatchGlobalMax: 4 },
  });
  assert.equal(offers.length, 4);
  for (let i = 0; i < offers.length; i++) {
    store.db.prepare("UPDATE admission_attempts SET offered_at=? WHERE admission_id=? AND ended_at IS NULL")
      .run(1000 + i, offers[i].id);
  }

  const result = recover(store, {
    harness: "test",
    at: 1010,
    mutate: true,
    config: { ...store.config, dispatchHarnessMax: 2, dispatchGlobalMax: 2 },
  });
  assert.equal(result.start.length, 2);
  assert.deepEqual(result.start.map((r) => r.admissionId), offers.slice(0, 2).map((r) => r.id));
  assert.equal(result.free, 0);
  assert.equal(store.admission.get(offers[0].id).status, "offered");
  assert.equal(store.admission.get(offers[1].id).status, "offered");
  assert.equal(store.admission.get(offers[2].id).status, "queued");
  assert.equal(store.admission.get(offers[3].id).status, "queued");
});

test("register and recover endpoints are available on the server", async () => {
  receiver = await wakeReceiver();
  srv = await startDispatchServer({ store, port: 0, intervalMs: 20 });
  const base = `http://127.0.0.1:${srv.port}`;
  const reg = await fetch(`${base}/dispatch/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness: "test", executorId: "exec-a", url: receiver.url, bearer: "tok" }),
  });
  assert.equal(reg.status, 201);

  const { row } = seedAssigned();
  observeEvent(row);
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(receiver.rows.length >= 1);
  assert.equal(receiver.rows[0].body.itemId, row.item_id);

  const rec = await fetch(`${base}/dispatch/recover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness: "test", executorId: "exec-a" }),
  });
  assert.equal(rec.status, 200);
  const body = await rec.json();
  assert.ok(Array.isArray(body.start));
});

test("recover endpoint offers queued work", async () => {
  srv = await startDispatchServer({ store, port: 0, intervalMs: 60000 });
  const base = `http://127.0.0.1:${srv.port}`;
  const { row } = seedAssigned();
  observeEvent(row);
  assert.equal(store.admission.queued("test").length, 1);

  const res = await fetch(`${base}/dispatch/recover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness: "test" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.start.length, 1);
  assert.equal(store.admission.queued("test").length, 0);
});

test("dispatch registration is one row per consumer, with executor metadata", async () => {
  srv = await startDispatchServer({ store, port: 0, intervalMs: 1000 });
  const base = `http://127.0.0.1:${srv.port}`;
  const register = (body) => fetch(`${base}/dispatch/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  let res = await register({ harness: "test", executorId: "exec-legacy", url: "http://127.0.0.1:1/wake", bearer: "tok" });
  assert.equal(res.status, 201);
  assert.equal(store.webhook.list({ topic: "dispatch" }).length, 1, "legacy executor registration exists");

  res = await register({ harness: "test", consumerId: "test:host", executorId: "exec-legacy", url: "http://127.0.0.1:2/wake", bearer: "tok" });
  assert.equal(res.status, 201);
  res = await register({ harness: "test", consumerId: "test:host", executorId: "exec-new", url: "http://127.0.0.1:3/wake", bearer: "tok" });
  assert.equal(res.status, 409, "a different live instance cannot steal the lease");
  const conflict = await res.json();
  assert.equal(conflict.current.bearer, undefined, "409 never returns the receiver bearer");
  assert.equal(conflict.current.instanceId, "exec-legacy");

  res = await register({ harness: "test", consumerId: "test:host", executorId: "exec-new", instanceId: "exec-new", url: "http://127.0.0.1:3/wake", bearer: "tok" });
  assert.equal(res.status, 409);

  res = await register({ harness: "test", consumerId: "test:host", executorId: "exec-legacy", instanceId: "exec-legacy", url: "http://127.0.0.1:4/wake", bearer: "tok" });
  assert.equal(res.status, 201);
  const rows = store.webhook.list({ topic: "dispatch" });
  assert.equal(rows.length, 1, "one consumer owns one wake route");
  assert.equal(rows[0].id, "test:host");
  assert.equal(rows[0].executorId, "exec-legacy");
  assert.equal(rows[0].url, "http://127.0.0.1:4/wake");
});

test("a live assignment reaches the queue and the receiver without a restart", async () => {
  receiver = await wakeReceiver();
  srv = await startDispatchServer({ store, port: 0, intervalMs: 1000 });
  const base = `http://127.0.0.1:${srv.port}`;
  const reg = await fetch(`${base}/dispatch/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ harness: "test", executorId: "exec-a", url: receiver.url, bearer: "tok" }),
  });
  assert.equal(reg.status, 201);

  const { row } = seedAssigned();
  assert.equal(store.admission.queued("test").length, 1, "the write hook admitted the wake");

  const notify = await fetch(`${base}/dispatch/notify`, { method: "POST" });
  assert.equal(notify.status, 202);
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(receiver.rows.length >= 1, "notify drained the queue without waiting for the poll");
  assert.equal(receiver.rows[0].body.itemId, row.item_id);
});

test("the store rings the dispatcher after a committed write", async () => {
  let hits = 0;
  const doorbell = http.createServer((req, res) => {
    req.resume();
    hits++;
    res.statusCode = 202;
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => doorbell.listen(0, "127.0.0.1", resolve));
  const notifyUrl = `http://127.0.0.1:${doorbell.address().port}/dispatch/notify`;
  const notifying = createStore({
    dbPath: path.join(dir, "notify.sqlite"),
    config: { dispatchOfferMs: 50, dispatchOfferBackoffMs: 10, dispatchOfferMaxBackoffMs: 20, dispatchOfferMaxAttempts: 3, dispatchDeliveryBackoffMs: 10, dispatchDeliveryMaxBackoffMs: 20, dispatchDeliveryMaxAttempts: 3, dispatchDeliveryFailureThreshold: 4, webhookTimeoutMs: 1000 },
    notifyDispatch: true,
    notifyUrl,
  });
  try {
    const epic = notifying.epic.create({ title: "notify" });
    const story = notifying.story.create({ epicId: epic.id, title: "notify" });
    notifying.task.create({ storyId: story.id, title: "notify" });
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(hits >= 1, "the post-commit notification reached the dispatcher");
  } finally {
    notifying.close();
    await new Promise((resolve) => doorbell.close(resolve));
  }
});

test("an unaccepted review wake requeues instead of disappearing", () => {
  const epic = store.epic.create({ title: "E", status: "done", createdBy: "atlas" });
  observe(store, {
    type: "event", kind: "epic.completed", id: 999, epicCreatedBy: "atlas",
    item: { id: epic.id, kind: "epic", status: "done" },
  });
  const [offer] = tick(store, { reachable: ["test"] });
  assert.ok(offer);
  assert.equal(store.admission.get(offer.id).status, "offered");
  tick(store, { at: Date.now() + 10_000, reachable: [] });
  assert.equal(store.admission.get(offer.id).status, "expired");
});

test("an accepted review wake is one-shot after its lease TTL", () => {
  const epic = store.epic.create({ title: "E", status: "done", createdBy: "atlas" });
  observe(store, {
    type: "event", kind: "epic.completed", id: 999, epicCreatedBy: "atlas",
    item: { id: epic.id, kind: "epic", status: "done" },
  });
  const [offer] = tick(store, { reachable: ["test"] });
  assert.ok(offer);
  const lease = store.admission.acceptWake({
    id: offer.id, attemptNo: offer.attempt_no, consumerId: "c", leaseEpoch: 0, leaseMs: 1000,
  });
  assert.equal(lease.leaseEpoch, 1);
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


test("partial fan-out retries only the failed consumer", async (t) => {
  const good = await wakeReceiver({ status: 202 });
  const bad = await wakeReceiver({ status: 500 });
  t.after(async () => { await good.close(); await bad.close(); });
  store.webhook.upsert({ topic: "dispatch", id: "a", harness: "test", instanceId: "a", url: good.url, bearer: "tok" });
  store.webhook.upsert({ topic: "dispatch", id: "b", harness: "test", instanceId: "b", url: bad.url, bearer: "tok" });
  const { row } = seedAssigned();
  observeEvent(row);
  const [offer] = tick(store, { reachable: ["test"] });
  const result = await deliverWake(store, offer);
  assert.equal(result.ok, true, "at least one receiver accepted");
  assert.equal(result.delivered.length, 1);
  assert.equal(result.failed.length, 1);
  const rows = store.delivery.allForAttempt(offer.id, offer.attempt_no);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((r) => r.status === "delivered").length, 1);
  assert.equal(rows.filter((r) => r.status === "pending").length, 1);
  const goodHits = good.rows.length;
  await deliverDue(store, { at: Date.now() + 20 });
  assert.equal(good.rows.length, goodHits, "the delivered consumer is not retried");
  assert.equal(bad.rows.length, 2, "the failed consumer gets its own retry");
});

test("an active consumer that is gone is replaced by its standby", async (t) => {
  const gone = await wakeReceiver({ status: 410 });
  const standby = await wakeReceiver({ status: 202 });
  t.after(async () => { await gone.close(); await standby.close(); });
  store.webhook.upsert({ topic: "dispatch", id: "a", harness: "test", instanceId: "a", url: gone.url, bearer: "tok" });
  store.webhook.upsert({ topic: "dispatch", id: "b", harness: "test", instanceId: "b", url: standby.url, bearer: "tok" });
  const { row } = seedAssigned();
  observeEvent(row);
  const [offer] = tick(store, { reachable: ["test"] });
  store.db.prepare("UPDATE admission_attempts SET active_consumer_id='a' WHERE admission_id=?").run(offer.id);
  const live = store.admission.get(offer.id);
  await deliverWake(store, live);
  assert.equal(store.webhook.get({ topic: "dispatch", id: "a" }).state, "disabled");
  assert.equal(standby.rows.at(-1).body.execution, "standby");

  await deliverDue(store, { at: Date.now() + 20 });
  const promoted = store.admission.get(offer.id);
  assert.equal(promoted.active_consumer_id, "b");
  assert.ok(promoted.lease_epoch >= 1);
  assert.equal(standby.rows.at(-1).body.execution, "active");
  assert.equal(standby.rows.at(-1).body.leaseEpoch, promoted.lease_epoch);
});

test("a subscription lease fences a second live instance", () => {
  store.webhook.upsert({ topic: "dispatch", id: "c", harness: "test", instanceId: "i1", url: "http://127.0.0.1:1/wake", bearer: "tok", at: 1000, leaseMs: 100 });
  assert.throws(() => store.webhook.upsert({
    topic: "dispatch", id: "c", harness: "test", instanceId: "i2", url: "http://127.0.0.1:2/wake", bearer: "tok", at: 1050, leaseMs: 100,
  }), StaleRegistrationError);
  const taken = store.webhook.upsert({
    topic: "dispatch", id: "c", harness: "test", instanceId: "i2", url: "http://127.0.0.1:2/wake", bearer: "tok", at: 1101, leaseMs: 100,
  });
  assert.equal(taken.instanceId, "i2");
  assert.equal(taken.generation, 1);
  assert.equal(taken.state, "active");
});

test("four transient failures disable the subscription", () => {
  store.webhook.upsert({ topic: "dispatch", id: "c", harness: "test", instanceId: "i1", url: "http://127.0.0.1:1/wake", bearer: "tok" });
  for (let i = 1; i <= 4; i++) {
    const row = store.webhook.recordFailure({ topic: "dispatch", id: "c", status: 500, threshold: 4, at: 1000 + i });
    assert.equal(row.state, i === 4 ? "disabled" : "suspect");
    assert.equal(row.failureCount, i);
  }
});

test("the work attempt carries the consumer, and resume falls back to the active lease", () => {
  store.webhook.upsert({ topic: "dispatch", id: "a", harness: "test", instanceId: "a", url: "http://127.0.0.1:1/wake", bearer: "tok" });
  store.webhook.upsert({ topic: "dispatch", id: "b", harness: "test", instanceId: "b", url: "http://127.0.0.1:2/wake", bearer: "tok" });
  const { task, row } = seedAssigned();
  observeEvent(row);
  const [offer] = tick(store, { reachable: ["test"] });
  store.task.claim({ id: task.id, agentId: "worker", harness: "test", session: "s" });
  const claimRow = store.db.prepare("SELECT * FROM item_events WHERE item_id=? ORDER BY id DESC LIMIT 1").get(task.id);
  observeEvent(claimRow);

  const attempt = store.db.prepare("SELECT consumer_id FROM attempts WHERE item_id=? AND ended_at IS NULL").get(task.id);
  assert.equal(attempt.consumer_id, null, "a manual claim has no wake consumer");
  const mine = recover(store, { harness: "test", consumerId: offer.active_consumer_id });
  assert.equal(mine.resume.length, 1, "unowned resume goes to the active lease holder");
  const other = recover(store, { harness: "test", consumerId: "not-the-active" });
  assert.equal(other.resume.length, 0, "the standby does not resume the same attempt");
});

test("read-only recover does not mutate the queue", () => {
  const { row } = seedAssigned();
  observeEvent(row);
  const before = store.admission.queued("test").length;
  const result = recover(store, { harness: "test", mutate: false });
  assert.equal(result.start.length, 0);
  assert.equal(store.admission.queued("test").length, before, "no offer was minted by a read-only recover");
});


test("tick trims offers when the cap is lowered", () => {
  for (let i = 0; i < 4; i++) {
    const { row } = seedAssigned({ agent: `worker-${i}` });
    observeEvent(row);
  }
  const offers = tick(store, { reachable: ["test"], at: 1000, config: { ...store.config, dispatchHarnessMax: 4, dispatchGlobalMax: 4 } });
  assert.equal(offers.length, 4);
  tick(store, { reachable: ["test"], at: 1010, config: { ...store.config, dispatchHarnessMax: 2, dispatchGlobalMax: 2 } });
  assert.equal(store.admission.offers("test").length, 2);
  assert.equal(store.admission.queued("test").length, 2);
});


test("only the active consumer gets a start row", () => {
  store.webhook.upsert({ topic: "dispatch", id: "a", harness: "test", instanceId: "a", url: "http://127.0.0.1:1/wake", bearer: "tok" });
  store.webhook.upsert({ topic: "dispatch", id: "b", harness: "test", instanceId: "b", url: "http://127.0.0.1:2/wake", bearer: "tok" });
  const { row } = seedAssigned();
  observeEvent(row);
  const [offer] = tick(store, { reachable: ["test"] });
  const active = recover(store, { harness: "test", consumerId: offer.active_consumer_id, mutate: false });
  const standbyId = offer.active_consumer_id === "a" ? "b" : "a";
  const standby = recover(store, { harness: "test", consumerId: standbyId, mutate: false });
  assert.deepEqual(active.start.map((r) => r.admissionId), [offer.id]);
  assert.deepEqual(standby.start, []);
});

test("ownerless resume fails closed when no active lease names a holder", () => {
  const { task, row } = seedAssigned();
  // No observeEvent: this is the legacy/manual shape the old fallback fanned out.
  store.task.claim({ id: task.id, agentId: "worker", harness: "test", session: "legacy" });
  const a = recover(store, { harness: "test", consumerId: "a", mutate: false });
  const b = recover(store, { harness: "test", consumerId: "b", mutate: false });
  assert.deepEqual(a.resume, []);
  assert.deepEqual(b.resume, []);
  assert.equal(recover(store, { harness: "test", mutate: false }).resume.length, 1, "operator view still sees it");
});

test("a wake-owned task records and enforces its lease epoch", () => {
  store.webhook.upsert({ topic: "dispatch", id: "a", harness: "test", instanceId: "a", url: "http://127.0.0.1:1/wake", bearer: "tok" });
  const { task, row } = seedAssigned();
  observeEvent(row);
  const [offer] = tick(store, { reachable: ["test"] });
  const claimed = store.task.claim({
    id: task.id, agentId: "worker", harness: "test", session: "wake",
    consumerId: offer.active_consumer_id, ownerInstance: "instance-a",
  });
  assert.equal(claimed.lease_epoch, 1);
  assert.equal(claimed.owner_instance, "instance-a");
  assert.equal(store.task.heartbeat(task.id, "worker", claimed.attempt_id, null), null, "missing epoch is rejected");
  assert.equal(store.task.heartbeat(task.id, "worker", claimed.attempt_id, 99), null, "wrong epoch is rejected");
  assert.ok(store.task.heartbeat(task.id, "worker", claimed.attempt_id, 1));
});

test("accepting a planner wake is single-flight and one-shot", () => {
  const epic = store.epic.create({ title: "E", status: "done", createdBy: "atlas" });
  observe(store, {
    type: "event", kind: "epic.completed", id: 1001, epicCreatedBy: "atlas",
    item: { id: epic.id, kind: "epic", status: "done" },
  });
  const [offer] = tick(store, { reachable: ["test"] });
  const accepted = store.admission.acceptWake({
    id: offer.id, attemptNo: offer.attempt_no, consumerId: "a", leaseEpoch: 0, leaseMs: 1000,
  });
  assert.equal(accepted.leaseEpoch, 1);
  assert.equal(store.admission.acceptWake({
    id: offer.id, attemptNo: offer.attempt_no, consumerId: "a", leaseEpoch: 0, leaseMs: 1000,
  }).error, "stale_lease");
  assert.equal(store.admission.acceptWake({
    id: offer.id, attemptNo: offer.attempt_no, consumerId: "b", leaseEpoch: 1, leaseMs: 1000,
  }).error, "stale_lease");
  tick(store, { at: Date.now() + 10_000, reachable: [] });
  assert.equal(store.admission.get(offer.id).status, "done");
});

test("an expired active lease promotes a standby even after a 2xx delivery", async (t) => {
  const active = await wakeReceiver({ status: 202 });
  const standby = await wakeReceiver({ status: 202 });
  t.after(async () => { await active.close(); await standby.close(); });
  store.webhook.upsert({ topic: "dispatch", id: "a", harness: "test", instanceId: "a", url: active.url, bearer: "tok" });
  store.webhook.upsert({ topic: "dispatch", id: "b", harness: "test", instanceId: "b", url: standby.url, bearer: "tok" });
  const { row } = seedAssigned();
  observeEvent(row);
  const [offer] = tick(store, { reachable: ["test"] });
  store.db.prepare("UPDATE admission_attempts SET active_consumer_id='a', lease_until=? WHERE admission_id=?")
    .run(Date.now() - 1, offer.id);
  await deliverWake(store, store.admission.get(offer.id));
  assert.equal(store.delivery.allForAttempt(offer.id, offer.attempt_no).find((d) => d.consumer_id === "a").status, "delivered");
  await deliverDue(store, { at: Date.now() + 1 });
  assert.equal(store.admission.get(offer.id).active_consumer_id, "b");
  assert.equal(standby.rows.at(-1).body.execution, "active");
});

test("delivery keeps a stable event and a per-attempt audit row", async (t) => {
  const receiver = await wakeReceiver({ status: 202 });
  t.after(() => receiver.close());
  store.webhook.upsert({ topic: "dispatch", id: "a", harness: "test", instanceId: "a", url: receiver.url, bearer: "tok" });
  const { row } = seedAssigned();
  observeEvent(row);
  const [offer] = tick(store, { reachable: ["test"] });
  await deliverWake(store, offer);
  const delivery = store.delivery.allForAttempt(offer.id, offer.attempt_no)[0];
  const event = store.dispatchEvent.get({ admissionId: offer.id, attemptNo: offer.attempt_no });
  assert.ok(event);
  assert.equal(delivery.event_id, event.id);
  assert.equal(store.db.prepare("SELECT status FROM dispatch_delivery_attempts WHERE delivery_id=? ORDER BY id DESC LIMIT 1").get(delivery.id).status, "delivered");
});

test("dispatch management endpoints require WINCH_DISPATCH_TOKEN when set", async () => {
  const previous = process.env.WINCH_DISPATCH_TOKEN;
  process.env.WINCH_DISPATCH_TOKEN = "secret";
  try {
    srv = await startDispatchServer({ store, port: 0, intervalMs: 1000 });
    const base = `http://127.0.0.1:${srv.port}`;
    const body = { harness: "test", executorId: "exec", url: "http://127.0.0.1:1/wake", bearer: "tok" };
    let res = await fetch(`${base}/dispatch/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(res.status, 401);
    res = await fetch(`${base}/dispatch/register`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer secret" }, body: JSON.stringify(body) });
    assert.equal(res.status, 201);
    assert.equal((await fetch(`${base}/dispatch/recover`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ harness: "test" }) })).status, 401);
    assert.equal((await fetch(`${base}/dispatch/recover`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer secret" }, body: JSON.stringify({ harness: "test" }) })).status, 200);
  } finally {
    if (previous === undefined) delete process.env.WINCH_DISPATCH_TOKEN;
    else process.env.WINCH_DISPATCH_TOKEN = previous;
  }
});

test("POST /usage records usage against the session's item", async () => {
  srv = await startDispatchServer({ store, port: 0, intervalMs: 60000 });
  const base = `http://127.0.0.1:${srv.port}`;
  const { story } = hierarchy();
  const task = store.task.create({ storyId: story.id, title: "T", status: "backlog" });
  const sess = store.session.ensure({ harness: "test", agentId: "worker", externalSessionId: "s1", itemId: task.id, kind: "claim" });

  let res = await fetch(`${base}/usage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionKey: "nope", usage: { tokensIn: 1 } }),
  });
  assert.equal(res.status, 404, "unknown session is refused");

  res = await fetch(`${base}/usage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionKey: sess.session_key }),
  });
  assert.equal(res.status, 400, "empty usage is refused");

  res = await fetch(`${base}/usage`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sessionKey: sess.session_key, usage: { model: "gpt-4", tokens_in: 10, tokens_out: 5, cost_usd: 0.01 } }),
  });
  assert.equal(res.status, 201);

  const summary = store.usage.summary({ itemId: task.id });
  assert.equal(summary.calls, 1);
  assert.equal(summary.tokens_in, 10);
  assert.equal(summary.tokens_out, 5);
  assert.equal(summary.cost_usd, 0.01);
});

test("POST /usage requires WINCH_DISPATCH_TOKEN when set", async () => {
  const previous = process.env.WINCH_DISPATCH_TOKEN;
  process.env.WINCH_DISPATCH_TOKEN = "secret";
  try {
    srv = await startDispatchServer({ store, port: 0, intervalMs: 60000 });
    const base = `http://127.0.0.1:${srv.port}`;
    const { story } = hierarchy();
    const task = store.task.create({ storyId: story.id, title: "T", status: "backlog" });
    const sess = store.session.ensure({ harness: "test", agentId: "worker", externalSessionId: "s1", itemId: task.id, kind: "claim" });
    const payload = JSON.stringify({ sessionKey: sess.session_key, usage: { tokensIn: 1 } });
    let res = await fetch(`${base}/usage`, { method: "POST", headers: { "content-type": "application/json" }, body: payload });
    assert.equal(res.status, 401);
    res = await fetch(`${base}/usage`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer secret" }, body: payload });
    assert.equal(res.status, 201);
  } finally {
    if (previous === undefined) delete process.env.WINCH_DISPATCH_TOKEN;
    else process.env.WINCH_DISPATCH_TOKEN = previous;
  }
});
