// ws.test.js — the event pipe: welcome, history replay, live broadcast to
// every connected client. Uses the real server and real sockets on an
// ephemeral port; rows stream verbatim, typed kinds land in a follow-up.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { createStore } from "../src/store.js";
import { startEventServer, kindForEvent } from "../src/events-ws.js";

let dir, store, srv, sockets;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "backlog-ws-"));
  store = createStore({ dbPath: path.join(dir, "store.sqlite") });
  sockets = [];
});
afterEach(async () => {
  for (const s of sockets) {
    try { s.close(); } catch { /* already gone */ }
  }
  if (srv) await srv.close();
  srv = undefined;
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedEvent() {
  const epic = store.epic.create({ title: "E", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready" });
  const task = store.task.create({ storyId: story.id, title: "T", executionKind: "manual" });
  // a status transition writes exactly one event row
  store.task.update(task.id, { status: "done", actor: "seed", note: "seeded" });
  return task;
}

// The inbox is attached at connect time and never replaced: with several
// clients racing the same broadcast, attaching a fresh onmessage per
// collect() call drops frames that land between collects.
function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    sockets.push(ws);
    ws.inbox = [];
    ws.onmessage = (e) => {
      ws.inbox.push(JSON.parse(String(e.data)));
    };
    const timer = setTimeout(() => reject(new Error("ws open timed out")), 5000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(ws);
    };
    ws.onerror = (e) => {
      clearTimeout(timer);
      reject(new Error(`ws error: ${e?.message ?? "unknown"}`));
    };
  });
}

function collect(ws, count, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (ws.inbox.length >= count) {
        clearInterval(timer);
        resolve(ws.inbox.splice(0, count));
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`timed out waiting for ${count} frames, got ${ws.inbox.length}`));
      }
    }, 10);
  });
}

test("subscriber gets welcome + history, then live rows", async () => {
  seedEvent();
  srv = await startEventServer({ store, port: 0, intervalMs: 50 });
  const ws = await connect(srv.port);
  const [welcome, history] = await collect(ws, 2);
  assert.equal(welcome.type, "welcome");
  assert.equal(welcome.payload, "v2");
  assert.equal(typeof welcome.lastEventId, "number");
  assert.equal(history.type, "history");
  assert.ok(history.events.length >= 1);
  const last = history.events[history.events.length - 1];
  assert.equal(last.kind, "task.completed");
  assert.equal(last.task.title, "T");
  assert.equal(last.note, "seeded");

  seedEvent();
  const [birth, done] = await collect(ws, 2);
  assert.equal(birth.kind, "task.created");
  assert.equal(birth.task.title, "T");
  assert.equal(done.kind, "task.completed");
  assert.ok(birth.id > last.id);
});

test("every connected client receives the same broadcast", async () => {
  seedEvent();
  srv = await startEventServer({ store, port: 0, intervalMs: 50 });
  const a = await connect(srv.port);
  const b = await connect(srv.port);
  await collect(a, 2);
  await collect(b, 2);
  seedEvent();
  const [liveA] = await collect(a, 1);
  const [liveB] = await collect(b, 1);
  assert.equal(liveA.id, liveB.id);
  assert.equal(liveA.kind, "task.created");
  assert.equal(srv.clients(), 2);
});

test("plain HTTP hits get 404, not a hijacked upgrade", async () => {
  seedEvent();
  srv = await startEventServer({ store, port: 0, intervalMs: 50 });
  const status = await new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${srv.port}/`, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on("error", reject);
  });
  assert.equal(status, 404);
});

test("empty store: welcome id 0, empty history, still streams later rows", async () => {
  srv = await startEventServer({ store, port: 0, intervalMs: 50 });
  const ws = await connect(srv.port);
  const [welcome, history] = await collect(ws, 2);
  assert.equal(welcome.lastEventId, 0);
  assert.deepEqual(history.events, []);
  seedEvent();
  const [live] = await collect(ws, 1);
  assert.equal(live.kind, "task.created");
  assert.equal(live.task.title, "T");
});

test("history and live rows share one envelope", async () => {
  seedEvent();
  srv = await startEventServer({ store, port: 0, intervalMs: 50 });
  const ws = await connect(srv.port);
  const [, history] = await collect(ws, 2);
  seedEvent();
  const [live] = await collect(ws, 1);
  assert.deepEqual(
    Object.keys(history.events[0]).sort(),
    Object.keys(live).sort()
  );
  assert.equal(history.events[0].kind, live.kind);
});

test("kindForEvent: task family maps; gate rows key on note vocabulary or joined gate_type", () => {
  const cases = [
    [{ from_status: null, to_status: "todo", note: "task created" }, null, "task.created"],
    [{ from_status: "todo", to_status: "in_progress", note: "claim" }, null, "task.claimed"],
    [{ from_status: "in_progress", to_status: "in_progress", note: "heartbeat" }, null, "task.progressed"],
    [{ from_status: "in_progress", to_status: "in_progress", note: "session budget exhausted: 40/40 backlog calls; claims halted" }, null, "budget.exhausted"],
    [{ from_status: "todo", to_status: "done", note: "done" }, null, "task.completed"],
    [{ from_status: "in_progress", to_status: "todo", note: "sweeper" }, null, "task.released"],
    [{ from_status: "todo", to_status: "blocked", note: "gate open: architecture" }, null, "gate.opened"],
    [{ from_status: "in_progress", to_status: "blocked", note: "blocked: reason" }, { gate_type: "architecture" }, "gate.opened"],
    [{ from_status: "todo", to_status: "blocked", note: "blocked: reason" }, { gate_type: null }, "task.blocked"],
    [{ from_status: "blocked", to_status: "todo", note: "gate resume" }, null, "gate.resolved"],
    [{ from_status: "in_progress", to_status: "in_progress", note: "session budget exhausted: 40/40" }, null, "budget.exhausted"],
    [{ from_status: "done", to_status: "done", note: "release shipped: v2.0.0" }, null, "release.shipped"],
    [{ from_status: "blocked", to_status: "todo", note: "manual reopen" }, null, "task.released"],
    [{ from_status: "blocked", to_status: "blocked", note: "gate waiting: 24h unanswered" }, { gate_type: "roadmap" }, "gate.waiting"],
    [{ from_status: "in_progress", to_status: "in_progress", note: "agent budget exhausted: 300/300 backlog calls across sessions; claims halted" }, null, "budget.exhausted"],
    [{ from_status: null, to_status: null, note: "session budget exhausted: 60/60 backlog calls; claims halted" }, null, "budget.exhausted"],
    [{ from_status: "todo", to_status: "cancelled", note: "cut" }, null, "task.cancelled"],
  ];
  for (const [row, task, want] of cases) {
    assert.equal(kindForEvent(row, task), want, JSON.stringify(row));
  }
});

test("gate.opened streams with gate context, gate resume resolves it", async () => {
  const epic = store.epic.create({ title: "E", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready" });
  const task = store.task.create({ storyId: story.id, title: "G", executionKind: "manual" });
  store.task.openGate({ id: task.id, gateType: "architecture", reason: "ADR review" });
  srv = await startEventServer({ store, port: 0, intervalMs: 50 });
  const ws = await connect(srv.port);
  const [, history] = await collect(ws, 2);
  const opened = history.events.find((e) => e.kind === "gate.opened");
  assert.ok(opened, "history carries the gate opening");
  assert.equal(opened.task.title, "G");
  store.task.resumeGate({ id: task.id });
  const [live] = await collect(ws, 1);
  assert.equal(live.kind, "gate.resolved");
  assert.equal(live.task.id, task.id);
});

test("task.create writes a birth row the stream picks up", async () => {
  srv = await startEventServer({ store, port: 0, intervalMs: 50 });
  const ws = await connect(srv.port);
  await collect(ws, 2); // welcome + empty history
  const epic = store.epic.create({ title: "E", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready" });
  store.task.create({ storyId: story.id, title: "born", executionKind: "manual" });
  const [live] = await collect(ws, 1);
  assert.equal(live.kind, "task.created");
  assert.equal(live.task.title, "born");
});
