// ws.test.js — the event pipe: welcome, history replay, live broadcast to
// every connected client. Uses the real server and real sockets on an
// ephemeral port; rows stream verbatim, typed kinds land in a follow-up.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import { createStore } from "../../src/store.js";
import { startEventServer, kindForEvent } from "../../src/events-ws.js";

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

test("a story-scoped row carries the item, its assignee and the epic creator", async () => {
  const epic = store.epic.create({ title: "E", status: "planned", createdBy: "atlas" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready", assigned: "tester" });
  store.db.prepare("INSERT INTO events(task_id,item_kind,from_status,to_status,kind,actor,note,at) VALUES(?,?,?,?,?,?,?,?)")
    .run(story.id, "story", "ready", "ready", "story.assigned", "openclaw:atlas", "assign tester", Date.now());
  const row = store.db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT 1").get();
  const { toEventMessage } = await import("../../src/events-ws.js");
  const msg = toEventMessage(store, row);
  assert.equal(msg.kind, "story.assigned");
  assert.equal(msg.item.kind, "story");
  assert.equal(msg.item.id, story.id);
  assert.equal(msg.item.assigned, "tester");
  assert.equal(msg.epicId, epic.id);
  assert.equal(msg.epicCreatedBy, "atlas");
  assert.equal(msg.task, null);
});

test("a close carries the work it just made claimable", async () => {
  const epic = store.epic.create({ title: "E", status: "planned" });
  const story = store.story.create({ epicId: epic.id, title: "S", status: "ready" });
  const first = store.task.create({ storyId: story.id, title: "first", status: "done", executionKind: "manual" });
  const next = store.task.create({ storyId: story.id, title: "next", status: "todo", executionKind: "manual", assigned: "builder" });
  const { addDep } = await import("../../src/deps.js");
  assert.ok(addDep(store, next.id, first.id).ok);
  const row = store.db.prepare("SELECT * FROM events WHERE task_id=? AND to_status='done' ORDER BY id DESC LIMIT 1").get(first.id);
  const { toEventMessage } = await import("../../src/events-ws.js");
  const msg = toEventMessage(store, row);
  assert.deepEqual(msg.unblocked, [{ id: next.id, assigned: "builder" }]);
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

test("kindForEvent: stored kind wins; kind-less rows map by structure, notes inert", () => {
  const cases = [
    [{ from_status: null, to_status: "todo", note: "task created" }, "task.created"],
    [{ from_status: "todo", to_status: "in_progress", note: "claim" }, "task.claimed"],
    [{ from_status: "in_progress", to_status: "in_progress", note: "heartbeat" }, "task.progressed"],
    [{ from_status: "todo", to_status: "done", note: "done" }, "task.completed"],
    [{ from_status: "in_progress", to_status: "todo", note: "sweeper" }, "task.released"],
    [{ from_status: "in_progress", to_status: "blocked", note: "blocked: reason" }, "task.blocked"],
    [{ from_status: "todo", to_status: "blocked", note: "gate open: architecture" }, "task.blocked"],
    [{ from_status: "blocked", to_status: "todo", note: "gate resume" }, "task.released"],
    [{ from_status: "blocked", to_status: "todo", note: "gate dissolved: closed unmerged PR #9" }, "task.released"],
    [{ from_status: "blocked", to_status: "todo", kind: "gate.dissolved", note: "whatever the note says" }, "gate.dissolved"],
    [{ from_status: "todo", to_status: "blocked", kind: "task.blocked", note: "gate open: architecture" }, "task.blocked"],
    [{ from_status: "todo", to_status: "cancelled", note: "cut" }, "task.cancelled"],
  ];
  for (const [row, want] of cases) {
    assert.equal(kindForEvent(row), want, JSON.stringify(row));
  }
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
