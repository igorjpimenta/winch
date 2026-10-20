// notify.test.js — S2.3: gate discovery, send-then-record, retry on failure.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../src/store.js";
import { gatesNeedingNotify, gateMessage, markGateNotified, notifyGates, remindGates } from "../src/notify.js";
import { tick } from "../src/watcher.js";

let dir, store;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "backlog-notify-"));
  store = createStore({ dbPath: path.join(dir, "store.sqlite") });
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function gate({ gateType = "architecture" } = {}) {
  const epic = store.epic.create({ title: "E2E epic", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "JTBD discovery", status: "ready", acceptance: "AC" });
  const task = store.task.create({ storyId: story.id, title: "Approve ADR", executionKind: "manual" });
  store.task.openGate({ id: task.id, gateType, reason: "review", actor: "forge" });
  return task;
}

test("only un-notified gates are listed; recording clears them", () => {
  const t = gate();
  assert.equal(gatesNeedingNotify(store).length, 1);
  const ev = markGateNotified(store, t.id, "watcher");
  assert.ok(ev, "event recorded");
  assert.equal(gatesNeedingNotify(store).length, 0);
  assert.equal(markGateNotified(store, t.id, "again"), null, "record-once per gate");
});

test("markGateNotified refuses non-gates", () => {
  const epic = store.epic.create({ title: "E", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready" });
  const plain = store.task.create({ storyId: story.id, title: "plain block", executionKind: "manual" });
  store.task.update(plain.id, { status: "blocked", actor: "x", note: "blocked: reason" });
  assert.equal(markGateNotified(store, plain.id), null);
});

test("gate message carries gate type, ids, story, and the reply instruction", () => {
  gate();
  const msg = gateMessage(gatesNeedingNotify(store)[0]);
  assert.match(msg, /ADT gate: architecture/);
  assert.match(msg, /Story: JTBD discovery \(Epic: E2E epic\)/);
  assert.match(msg, /resume TASK-/);
  assert.match(msg, /openclaw backlog resume TASK-/);
});

test("notifyGates: successful send records; second run sends nothing; failure retries", async () => {
  const t = gate();
  const sent = [];
  const good = async (text) => { sent.push(text); return true; };

  const first = await notifyGates(store, { send: good });
  assert.deepEqual(first.notified, [t.id]);
  assert.equal(sent.length, 1);

  const second = await notifyGates(store, { send: good });
  assert.deepEqual(second.notified, []);
  assert.equal(sent.length, 1, "idempotent — no duplicate ping");

  // A gate whose send fails writes no event → still owed next tick
  const t2 = gate({ gateType: "release" });
  const failing = async () => false;
  const third = await notifyGates(store, { send: failing });
  assert.deepEqual(third.failed, [t2.id]);
  assert.equal(gatesNeedingNotify(store).length, 1, "failed send stays owed");
  const fourth = await notifyGates(store, { send: good });
  assert.deepEqual(fourth.notified, [t2.id]);
});

test("watcher manifest separates gates with needsNotify", () => {
  gate();
  let m = tick(store);
  assert.equal(m.gates.length, 1);
  assert.equal(m.gates[0].needsNotify, true);
  markGateNotified(store, m.gates[0].id, "watcher");
  m = tick(store);
  assert.equal(m.gates[0].needsNotify, false);
});

// ───────────────────────────────────────────────── S2.4 reminders
test("reminders: none at 23h, 24h tier once, 72h tier supersedes, retry on failure", async () => {
  const t = gate();
  const sent = [];
  const good = async (text) => { sent.push(text); return true; };
  const setAge = (h) => store.db.prepare("UPDATE tasks SET blocked_at=? WHERE id=?").run(Date.now() - h * 3_600_000, t.id);

  setAge(23);
  assert.equal((await remindGates(store, { send: good })).reminded.length, 0, "23h: silent");
  setAge(25);
  const r1 = await remindGates(store, { send: good });
  assert.deepEqual(r1.reminded, [{ id: t.id, tier: 24 }]);
  assert.match(sent[0], /gate reminder 24h/);
  const r2 = await remindGates(store, { send: good });
  assert.equal(r2.reminded.length, 0, "one per tier");

  setAge(73);
  const failed = await remindGates(store, { send: async () => false });
  assert.deepEqual(failed.failed, [{ id: t.id, tier: 72 }], "failed send stays owed");
  const r3 = await remindGates(store, { send: good });
  assert.deepEqual(r3.reminded, [{ id: t.id, tier: 72 }]);
  const r4 = await remindGates(store, { send: good });
  assert.equal(r4.reminded.length, 0, "72h delivered once");
});
