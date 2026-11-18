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
