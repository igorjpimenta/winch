// webhook.test.js — subscriptions are keyed by topic and id, so one id can
// carry independent endpoints for different purposes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeStore } from "./_helpers.js";

test("one id can hold separate subscriptions per topic", (t) => {
  const store = makeStore(t);
  store.webhook.upsert({ topic: "dispatch", id: "e1", harness: "openclaw", executorId: "e1", url: "http://127.0.0.1:1/wake", bearer: "a" });
  store.webhook.upsert({ topic: "release", id: "e1", url: "http://127.0.0.1:4/release", bearer: "b" });

  assert.deepEqual(store.webhook.topics(), ["dispatch", "release"]);
  assert.equal(store.webhook.list({ topic: "dispatch" }).length, 1);
  assert.equal(store.webhook.list({ topic: "release" }).length, 1);
  assert.equal(store.webhook.list({ harness: "openclaw" }).length, 1);
  assert.equal(store.webhook.get({ topic: "release", id: "e1" }).executorId, null);
});

test("remove is scoped to one topic and requires a topic and id", (t) => {
  const store = makeStore(t);
  store.webhook.upsert({ topic: "dispatch", id: "e1", harness: "openclaw", executorId: "e1", url: "http://127.0.0.1:1/wake", bearer: "a" });
  store.webhook.upsert({ topic: "release", id: "e1", url: "http://127.0.0.1:4/release", bearer: "b" });

  assert.equal(store.webhook.remove({ topic: "release", id: "e1" }), true);
  assert.equal(store.webhook.get({ topic: "release", id: "e1" }), null);
  assert.ok(store.webhook.get({ topic: "dispatch", id: "e1" }));
  assert.throws(() => store.webhook.remove({ id: "e1" }), /requires a topic/);
  assert.throws(() => store.webhook.upsert({ topic: "dispatch", url: "http://127.0.0.1:1", bearer: "a" }), /requires an id/);
});

test("a heartbeat preserves failures; only a fresh registration re-enables", (t) => {
  const store = makeStore(t);
  const base = { topic: "dispatch", id: "c", harness: "openclaw", instanceId: "i1", url: "http://127.0.0.1:1/wake", bearer: "tok" };
  store.webhook.upsert({ ...base, managed: true, fresh: true, at: 1000, leaseMs: 100 });
  for (let i = 1; i <= 3; i++) store.webhook.recordFailure({ topic: "dispatch", id: "c", status: 500, threshold: 4, at: 1000 + i });
  let row = store.webhook.upsert({ ...base, managed: true, fresh: false, at: 2000, leaseMs: 100 });
  assert.equal(row.state, "suspect");
  assert.equal(row.failureCount, 3);
  store.webhook.recordFailure({ topic: "dispatch", id: "c", status: 500, threshold: 4, at: 2001 });
  row = store.webhook.upsert({ ...base, managed: true, fresh: false, at: 3000, leaseMs: 100 });
  assert.equal(row.state, "disabled");
  assert.equal(row.failureCount, 4);
  row = store.webhook.upsert({ ...base, managed: true, fresh: true, at: 4000, leaseMs: 100 });
  assert.equal(row.state, "active");
  assert.equal(row.failureCount, 0);
});
