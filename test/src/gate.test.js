// gate.test.js — S2.2: openGate/resumeGate CAS, gate metadata invariants,
// tool + watcher surfaces.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../../src/store.js";
import { createToolHandlers } from "../../src/tools.js";
import { tick } from "../../src/watcher.js";

let dir, store, handle;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "winch-gates-"));
  store = createStore({ dbPath: path.join(dir, "store.sqlite") });
  ({ handle } = createToolHandlers(store, null));
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function call(name, args, identity = { harness: "test", agent: "atlas", session: "sess-1" }) {
  return handle(name, args, identity);
}

function seed({ assigned = null, taskStatus = "todo" } = {}) {
  const epic = store.epic.create({ title: "E", status: "planned", priority: 80 });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready", priority: 70 });
  const task = store.task.create({
    storyId: story.id, title: "T", status: taskStatus,
    executionKind: "manual", assigned,
  });
  return { epic, story, task };
}

test("openGate stamps gate fields + event, and a gate opens exactly once", () => {
  const { task } = seed();
  const opened = store.task.openGate({ id: task.id, gateType: "architecture", reason: "ADR review", actor: "forge" });
  assert.equal(opened.status, "blocked");
  assert.equal(opened.gate_type, "architecture");
  assert.ok(opened.blocked_at > 0);
  const ev = store.db.prepare("SELECT * FROM events WHERE task_id=? AND note LIKE 'gate open%'").all(task.id);
  assert.equal(ev.length, 1);
  assert.match(ev[0].note, /gate open: architecture — ADR review/);
  assert.equal(store.task.openGate({ id: task.id, gateType: "roadmap", reason: "x" }), null);
  assert.equal(store.task.get(task.id).gate_type, "architecture");
});

test("resumeGate CAS: blocked → todo clears claim + gate, one resume per gate", () => {
  const { task } = seed({ assigned: "atlas", taskStatus: "in_progress" });
  store.task.openGate({ id: task.id, gateType: "release", actor: "herald" });
  const res = store.task.resumeGate({ id: task.id, actor: "operator" });
  assert.equal(res.status, "todo");
  assert.equal(res.assigned, null);
  assert.equal(res.gate_type, null);
  assert.equal(res.blocked_at, null);
  const ev = store.db.prepare("SELECT * FROM events WHERE task_id=? AND note='gate resume'").all(task.id);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].from_status, "blocked");
  assert.equal(ev[0].to_status, "todo");
  assert.equal(store.task.resumeGate({ id: task.id, actor: "operator" }), null);
  assert.equal(ev.length, 1);
});

test("update-block stamps gate metadata; leaving blocked clears it", () => {
  const { task } = seed();
  const blocked = store.task.update(task.id, { status: "blocked", gateType: "roadmap", actor: "atlas", note: "blocked: gate" });
  assert.equal(blocked.gate_type, "roadmap");
  assert.ok(blocked.blocked_at > 0);
  const back = store.task.update(task.id, { status: "todo", actor: "operator", note: "released" });
  assert.equal(back.gate_type, null);
  assert.equal(back.blocked_at, null);
});

test("backlog_block with gateType + watcher manifest carries gate fields", async () => {
  const { task } = seed({ assigned: "builder", taskStatus: "in_progress" });
  const res = await call(
    "backlog_block",
    { taskId: task.id, reason: "waiting on API spec", gateType: "architecture" },
    { harness: "test", agent: "builder", session: "s-1" }
  );
  assert.equal(res.details.status, "ok");
  const row = store.task.get(task.id);
  assert.equal(row.gate_type, "architecture");
  const m = tick(store);
  assert.equal(m.blocked.length, 1);
  assert.equal(m.blocked[0].gate_type, "architecture");
  assert.ok(m.blocked[0].blocked_at > 0);
});

test("gate rows carry producer-stamped kinds, not inference", () => {
  const { task } = seed({ assigned: "builder", taskStatus: "in_progress" });
  store.task.openGate({ id: task.id, gateType: "roadmap", reason: "ADR", actor: "builder" });
  const opened = store.db.prepare("SELECT kind FROM events WHERE task_id=? AND to_status='blocked'").get(task.id);
  assert.equal(opened.kind, "gate.opened");
  store.task.resumeGate({ id: task.id, actor: "operator" });
  const resolved = store.db.prepare("SELECT kind FROM events WHERE task_id=? AND note='gate resume'").get(task.id);
  assert.equal(resolved.kind, "gate.resolved");
});

test("update() entering blocked with gateType stamps gate.opened at write", () => {
  const { task } = seed({ taskStatus: "todo" });
  store.task.update(task.id, { status: "blocked", gateType: "release", actor: "x", note: "blocked: need signoff" });
  const row = store.db.prepare("SELECT kind FROM events WHERE task_id=? AND to_status='blocked'").get(task.id);
  assert.equal(row.kind, "gate.opened", "gate context at write time beats note sniffing");
});

test("recordGateWaits writes one 24h/72h row per gate, never twice", () => {
  const { task } = seed({ assigned: "builder", taskStatus: "in_progress" });
  store.task.openGate({ id: task.id, gateType: "roadmap", reason: "ADR", actor: "builder" });
  assert.deepEqual(store.task.recordGateWaits({}), [], "fresh gate is silent");
  store.db.prepare("UPDATE tasks SET blocked_at=? WHERE id=?").run(Date.now() - 25 * 3600 * 1000, task.id);
  const w1 = store.task.recordGateWaits({});
  assert.equal(w1.length, 1);
  assert.equal(w1[0].taskId, task.id);
  assert.equal(w1[0].label, "24h");
  const rows = store.db.prepare("SELECT * FROM events WHERE task_id=? AND note LIKE 'gate waiting:%'").all(task.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "gate.waiting", "declared at write");
  assert.equal(rows[0].from_status, "blocked");
  assert.equal(rows[0].to_status, "blocked");
  assert.deepEqual(store.task.recordGateWaits({}), [], "rerun writes nothing");
  store.db.prepare("UPDATE tasks SET blocked_at=? WHERE id=?").run(Date.now() - 73 * 3600 * 1000, task.id);
  const w2 = store.task.recordGateWaits({});
  assert.deepEqual(w2.map((w) => w.label), ["72h"], "next threshold fires once");
  assert.deepEqual(store.task.recordGateWaits({}), [], "both levels recorded — silent after");
});

test("recordGateWaits ignores plain blocks and unstamped legacy gates", () => {
  const a = seed();
  store.task.update(a.task.id, { status: "blocked", actor: "x", note: "blocked: reason" });
  // Legacy shape: gate_type stamped but no blocked_at to age from.
  store.db.prepare("UPDATE tasks SET gate_type='roadmap', blocked_at=NULL WHERE id=?").run(a.task.id);
  assert.deepEqual(store.task.recordGateWaits({}), [], "nothing to age from, nothing written");
});
