import { test } from "node:test";
import assert from "node:assert/strict";
import { startDispatchClient } from "./dispatch.js";

const RealWebSocket = globalThis.WebSocket;

class FakeWebSocket extends EventTarget {
  static last = null;
  static sent = [];
  constructor(url) {
    super();
    FakeWebSocket.last = this;
    FakeWebSocket.sent = [];
    this.url = url;
    this.readyState = 1;
    queueMicrotask(() => this.dispatchEvent(new Event("open")));
  }
  send(data) { FakeWebSocket.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}

function frame(obj) {
  FakeWebSocket.last.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(obj) }));
}

test("core dispatch hello, offer, and grant", async () => {
  globalThis.WebSocket = FakeWebSocket;
  const wakes = [];
  const client = startDispatchClient({
    url: "ws://test",
    harness: "opencode",
    wake: (route) => wakes.push(route),
    logger: { info() {}, warn() {} },
  });
  await new Promise((r) => setTimeout(r, 0));

  frame({ type: "welcome", dispatchMode: "core", requiresHello: true });
  assert.deepEqual(FakeWebSocket.sent[0], { type: "hello", executorId: client.executorId, harness: "opencode" });

  frame({ type: "wake", admissionId: "adm-1", itemId: "ITM-1", kind: "task", agent: "worker" });
  assert.equal(FakeWebSocket.sent.at(-1).type, "wake_accept");
  assert.equal(FakeWebSocket.sent.at(-1).admissionId, "adm-1");

  frame({ type: "wake_granted", admissionId: "adm-1", itemId: "ITM-1", kind: "task", agent: "worker" });
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].message, "ITM-1");
  assert.equal(wakes[0].admissionId, "adm-1");
  client.close();
  globalThis.WebSocket = RealWebSocket;
});

test("plugin mode routes events to the legacy router", async () => {
  globalThis.WebSocket = FakeWebSocket;
  const seen = [];
  const client = startDispatchClient({
    url: "ws://test",
    router: { handle: (ev) => seen.push(ev) },
    logger: { info() {}, warn() {} },
  });
  await new Promise((r) => setTimeout(r, 0));
  frame({ type: "welcome", dispatchMode: "plugin" });
  frame({ type: "event", id: 1, kind: "task.assigned" });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].id, 1);
  client.close();
  globalThis.WebSocket = RealWebSocket;
});
