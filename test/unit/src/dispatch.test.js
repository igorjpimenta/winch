// Core dispatch: route rows to admissions, deliver over HTTP, and recover
// assigned work after a harness restart.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { createStore } from "../../../src/store/index.js";
import { startEventServer, toEventMessage } from "../../../src/events-ws.js";
import { recover, observe, routesForEvent, tick } from "../../../src/dispatch.js";
import { deliverWake } from "../../../src/dispatch-webhook.js";

let dir, store, srv, receiver;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "winch-dispatch-"));
  store = createStore({
    dbPath: path.join(dir, "store.sqlite"),
    config: { dispatchOfferMs: 50, dispatchOfferBackoffMs: 10, dispatchOfferMaxBackoffMs: 20, dispatchOfferMaxAttempts: 3, dispatchWebhookTimeoutMs: 1000 },
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

async function wakeReceiver({ bearer = "tok" } = {}) {
  const rows = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      rows.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
      res.statusCode = 202;
      res.end(JSON.stringify({ ok: true }));
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
  store.dispatch.upsert({ harness: "test", executorId: "exec-a", url: receiver.url, bearer: "tok" });
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
  assert.equal(store.admission.get(offer.id).status, "offered");
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

test("register and recover endpoints are available on the server", async () => {
  receiver = await wakeReceiver();
  srv = await startEventServer({ store, port: 0, intervalMs: 20 });
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

test("a review wake is one-shot after a successful delivery", () => {
  const epic = store.epic.create({ title: "E", status: "done", createdBy: "atlas" });
  observe(store, {
    type: "event", kind: "epic.completed", id: 999, epicCreatedBy: "atlas",
    item: { id: epic.id, kind: "epic", status: "done" },
  });
  const [offer] = tick(store, { reachable: ["test"] });
  assert.ok(offer);
  assert.equal(store.admission.get(offer.id).status, "offered");
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
