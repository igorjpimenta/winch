// schema.test.js — the Drizzle migrations create the schema and the ledger
// makes reopen idempotent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../../../../src/store/index.js";

function tempDb(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "winch-schema-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path.join(dir, "store.sqlite");
}

function tables(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
}

function ledger(db) {
  return db.prepare("SELECT hash FROM __drizzle_migrations ORDER BY created_at").all();
}

test("fresh store creates the schema and records the Drizzle migrations", (t) => {
  const store = createStore({ dbPath: tempDb(t) });
  t.after(() => store.close());

  for (const name of ["items", "item_state", "item_tags", "item_edges", "attempts", "work_sessions", "artifacts", "item_events", "admission_queue", "admission_attempts", "webhook_deliveries", "webhook_delivery_attempts", "dispatch_events", "webhooks"]) {
    assert.ok(tables(store.db).includes(name), `${name} exists`);
  }
  for (const old of ["epics", "stories", "tasks", "events", "deps", "webhook_targets", "harness_webhooks", "session_budgets"]) {
    assert.ok(!tables(store.db).includes(old), `${old} is gone`);
  }
  assert.equal(ledger(store.db).length, 14);
});

test("reopen is idempotent and keeps the data", (t) => {
  const dbPath = tempDb(t);
  const store = createStore({ dbPath });
  const epic = store.epic.create({ title: "E" });
  store.close();

  const reopened = createStore({ dbPath });
  t.after(() => reopened.close());
  assert.equal(ledger(reopened.db).length, 14);
  assert.equal(reopened.epic.get(epic.id).title, "E");
});
