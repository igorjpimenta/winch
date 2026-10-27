// schema.test.js — the Drizzle migration creates the fresh schema and the
// ledger makes reopen idempotent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../../src/store.js";

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

test("fresh store creates the schema and records the Drizzle migration", (t) => {
  const store = createStore({ dbPath: tempDb(t) });
  t.after(() => store.close());

  assert.ok(tables(store.db).includes("epics"));
  assert.ok(tables(store.db).includes("stories"));
  assert.ok(tables(store.db).includes("tasks"));
  assert.ok(tables(store.db).includes("events"));
  assert.ok(tables(store.db).includes("deps"));
  assert.ok(tables(store.db).includes("webhook_targets"));
  assert.ok(!tables(store.db).includes("session_budgets"), "session_budgets table absent");
  assert.equal(ledger(store.db).length, 6);
});

test("reopen is idempotent and keeps the data", (t) => {
  const dbPath = tempDb(t);
  const store = createStore({ dbPath });
  const epic = store.epic.create({ title: "E" });
  store.close();

  const reopened = createStore({ dbPath });
  t.after(() => reopened.close());
  assert.equal(ledger(reopened.db).length, 6);
  assert.equal(reopened.epic.get(epic.id).title, "E");
});
