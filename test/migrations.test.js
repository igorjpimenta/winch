// migrations.test.js — a fresh store is created by the initial migration;
// the ledger makes reopen idempotent and refuses rows from a newer build.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../src/store.js";

const INITIAL = "0001-initial";

function tempDb(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "winch-migrations-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, dbPath: path.join(dir, "store.sqlite") };
}

function ledger(db) {
  return db.prepare("SELECT name FROM schema_migrations ORDER BY name").all().map((r) => r.name);
}

function table(db, name) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

test("fresh store creates the current schema and records the initial migration", async (t) => {
  const { dbPath } = tempDb(t);
  const store = await createStore({ dbPath });
  t.after(() => store.close());

  assert.deepEqual(ledger(store.db), [INITIAL]);
  for (const name of ["epics", "stories", "tasks", "events", "deps", "session_budgets"]) {
    assert.ok(table(store.db, name), `${name} table exists`);
  }
});

test("reopen is idempotent and keeps the data", async (t) => {
  const { dbPath } = tempDb(t);
  const store = await createStore({ dbPath });
  const epic = store.epic.create({ title: "E" });
  store.close();

  const reopened = await createStore({ dbPath });
  t.after(() => reopened.close());
  assert.deepEqual(ledger(reopened.db), [INITIAL]);
  assert.equal(reopened.epic.get(epic.id).title, "E");
});

test("a ledger row from a newer build refuses to open", async (t) => {
  const { dbPath } = tempDb(t);
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL);
    INSERT INTO schema_migrations(name, applied_at) VALUES('9999-future', 1);
  `);
  raw.close();

  await assert.rejects(createStore({ dbPath }), /unknown to this build/);
});
