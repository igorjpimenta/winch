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
import { startEventServer } from "../src/events-ws.js";

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
  assert.equal(typeof welcome.lastEventId, "number");
  assert.equal(history.type, "history");
  assert.ok(history.events.length >= 1);
  const last = history.events[history.events.length - 1];
  assert.equal(last.note, "seeded");

  seedEvent();
  const [live] = await collect(ws, 1);
  assert.equal(live.type, "event");
  assert.equal(live.event.note, "seeded");
  assert.ok(live.event.id > last.id);
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
  assert.equal(liveA.event.id, liveB.event.id);
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
  assert.equal(live.event.note, "seeded");
});
