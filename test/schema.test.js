// schema.test.js — the Drizzle migration creates the fresh schema and the
// ledger makes reopen idempotent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createStore } from "../src/store.js";
import Database from "better-sqlite3";

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
  assert.ok(!tables(store.db).includes("session_budgets"), "session_budgets table absent");
  assert.equal(ledger(store.db).length, 3);
});

test("reopen is idempotent and keeps the data", (t) => {
  const dbPath = tempDb(t);
  const store = createStore({ dbPath });
  const epic = store.epic.create({ title: "E" });
  store.close();

  const reopened = createStore({ dbPath });
  t.after(() => reopened.close());
  assert.equal(ledger(reopened.db).length, 3);
  assert.equal(reopened.epic.get(epic.id).title, "E");
});

test("adopts a v6 store: data intact, pending migrations apply, budgets drop", (t) => {
  const dbPath = tempDb(t);
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE epics (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, acceptance TEXT,
      status TEXT NOT NULL, owner_team TEXT, priority INTEGER NOT NULL DEFAULT 50,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER);
    CREATE TABLE stories (id TEXT PRIMARY KEY, epic_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
      acceptance TEXT, status TEXT NOT NULL, size TEXT, priority INTEGER NOT NULL DEFAULT 50,
      assigned TEXT, capabilities TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, story_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL, execution_kind TEXT NOT NULL, execution_args TEXT NOT NULL DEFAULT '{}',
      assigned TEXT, capabilities TEXT, flow_id TEXT, task_run_id TEXT, claim_expires_at INTEGER,
      lease_seconds INTEGER, last_heartbeat INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0,
      gate_type TEXT, blocked_at INTEGER, result_summary TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, claimed_at INTEGER, closed_at INTEGER);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      from_status TEXT, to_status TEXT NOT NULL, actor TEXT, note TEXT, session_ref TEXT, at INTEGER NOT NULL);
    CREATE TABLE deps (from_id TEXT NOT NULL, to_id TEXT NOT NULL, from_kind TEXT NOT NULL, to_kind TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY (from_id, to_id));
    CREATE TABLE session_budgets (session_key TEXT PRIMARY KEY, agent_id TEXT NOT NULL,
      tool_calls INTEGER NOT NULL DEFAULT 0, limit_calls INTEGER NOT NULL,
      exhausted_at INTEGER, empty_wakes INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
    INSERT INTO meta(key,value) VALUES('schema_version','6');
    INSERT INTO epics(id,title,status,created_at,updated_at) VALUES('EPIC-1','legacy', 'planned',1,2);
    INSERT INTO stories(id,epic_id,title,status,created_at,updated_at) VALUES('STORY-1','EPIC-1','s','ready',1,2);
    INSERT INTO tasks(id,story_id,title,status,execution_kind,gate_type,created_at,updated_at)
      VALUES('TASK-1','STORY-1','gated','blocked','manual','release',1,2);
    INSERT INTO events(task_id,from_status,to_status,actor,note,at)
      VALUES('TASK-1','in_progress','blocked','a','blocked: need signoff',3);`);
  db.close();

  const store = createStore({ dbPath });
  t.after(() => store.close());
  assert.equal(store.task.get("TASK-1").status, "blocked", "row survives adoption");
  assert.equal(store.task.get("TASK-1").gate_type, "release");
  assert.ok(store.db.prepare("PRAGMA table_info(events)").all().some((c) => c.name === "kind"), "0001 applied");
  assert.ok(!tables(store.db).includes("session_budgets"), "0002 applied");
  assert.equal(ledger(store.db).length, 3, "baseline + two migrations");
  const row = store.db.prepare("SELECT kind FROM events WHERE task_id='TASK-1'").get();
  assert.equal(row.kind, null, "no backfill: history keeps the meanings it streamed with");
});

test("incompatible legacy refuses with the gap named, not a CREATE TABLE stack", (t) => {
  const dbPath = tempDb(t);
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE epics (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, acceptance TEXT,
      status TEXT NOT NULL, owner_team TEXT, priority INTEGER NOT NULL DEFAULT 50,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER);
    CREATE TABLE stories (id TEXT PRIMARY KEY, epic_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
      acceptance TEXT, status TEXT NOT NULL, size TEXT, priority INTEGER NOT NULL DEFAULT 50,
      assigned TEXT, capabilities TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, story_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL, execution_kind TEXT NOT NULL, execution_args TEXT NOT NULL DEFAULT '{}',
      assigned TEXT, capabilities TEXT, flow_id TEXT, task_run_id TEXT, claim_expires_at INTEGER,
      lease_seconds INTEGER, last_heartbeat INTEGER, attempt_count INTEGER NOT NULL DEFAULT 0,
      gate_type TEXT, blocked_at INTEGER, result_summary TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, claimed_at INTEGER, closed_at INTEGER);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      from_status TEXT, to_status TEXT NOT NULL, actor TEXT, note TEXT, session_ref TEXT, at INTEGER NOT NULL);
    CREATE TABLE deps (from_id TEXT NOT NULL, to_id TEXT NOT NULL, from_kind TEXT NOT NULL, to_kind TEXT NOT NULL,
      created_at INTEGER NOT NULL, PRIMARY KEY (from_id, to_id));`);
  db.exec(`ALTER TABLE tasks DROP COLUMN description;`);
  db.close();
  assert.throws(() => createStore({ dbPath }), /not adoptable \(tasks missing column description\)/);
});
