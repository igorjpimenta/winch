// migrations.test.js — the runner owns the version counter and refuses a
// store from the future. Legacy fixtures exercise the consolidated v6 step.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "../src/store.js";
import { SCHEMA } from "../src/schema.js";
import { SCHEMA_VERSION } from "../src/migrations.js";

function tempDb(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "winch-migrations-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, dbPath: path.join(dir, "store.sqlite") };
}

function counter(db) {
  return {
    pragma: db.prepare("PRAGMA user_version").get().user_version,
    meta: db.prepare("SELECT value FROM meta WHERE key='schema_version'").get()?.value,
  };
}

test("fresh store writes both version counters", (t) => {
  const { dbPath } = tempDb(t);
  const store = createStore({ dbPath });
  t.after(() => store.close());

  assert.deepEqual(counter(store.db), { pragma: SCHEMA_VERSION, meta: String(SCHEMA_VERSION) });
});

test("a v1 store migrates, repairs graph_flow, and is idempotent", (t) => {
  const { dbPath } = tempDb(t);
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE epics (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, acceptance TEXT,
      status TEXT NOT NULL CHECK (status IN ('idea','planned','in_progress','done','cancelled')),
      owner_team TEXT, priority INTEGER NOT NULL DEFAULT 50,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER
    );
    CREATE TABLE stories (
      id TEXT PRIMARY KEY, epic_id TEXT NOT NULL REFERENCES epics(id) ON DELETE CASCADE,
      title TEXT NOT NULL, description TEXT, acceptance TEXT,
      status TEXT NOT NULL CHECK (status IN ('backlog','ready','in_progress','review','done','blocked','cancelled')),
      size TEXT, priority INTEGER NOT NULL DEFAULT 50, assigned TEXT, capabilities TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      title TEXT NOT NULL, description TEXT,
      status TEXT NOT NULL CHECK (status IN ('todo','in_progress','done','blocked','cancelled')),
      execution_kind TEXT NOT NULL CHECK (execution_kind IN ('graph_flow','subagent','cli','gate','manual')),
      execution_args TEXT NOT NULL DEFAULT '{}', assigned TEXT, capabilities TEXT,
      flow_id TEXT, task_run_id TEXT, claim_expires_at INTEGER, result_summary TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, claimed_at INTEGER, closed_at INTEGER
    );
    CREATE TABLE deps (
      from_id TEXT NOT NULL, from_kind TEXT NOT NULL CHECK (from_kind IN ('epic','story','task')),
      to_id TEXT NOT NULL, to_kind TEXT NOT NULL CHECK (to_kind IN ('epic','story','task')),
      created_at INTEGER NOT NULL, PRIMARY KEY (from_id, to_id)
    );
    INSERT INTO meta(key,value) VALUES('schema_version','1');
    INSERT INTO epics(id,title,status,created_at,updated_at) VALUES('EPIC-1','epic','planned',1,1);
    INSERT INTO stories(id,epic_id,title,status,created_at,updated_at) VALUES('STORY-1','EPIC-1','story','ready',1,1);
    INSERT INTO tasks(id,story_id,title,status,execution_kind,created_at,updated_at)
      VALUES('TASK-1','STORY-1','legacy','todo','graph_flow',1,1);
  `);
  raw.close();

  const store = createStore({ dbPath });
  t.after(() => { if (store.db.isOpen) store.close(); });

  assert.deepEqual(counter(store.db), { pragma: SCHEMA_VERSION, meta: String(SCHEMA_VERSION) });
  assert.equal(store.task.get("TASK-1").execution_kind, "pipeclaw");
  const tasksSql = store.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='tasks'").get().sql;
  assert.match(tasksSql, /'pipeclaw'/);
  assert.doesNotMatch(tasksSql, /'graph_flow'/);

  // The rebuilt CHECK now accepts the current vocabulary.
  const created = store.task.create({ storyId: "STORY-1", title: "new", executionKind: "pipeclaw" });
  assert.equal(created.execution_kind, "pipeclaw");

  store.close();
  const reopened = createStore({ dbPath });
  t.after(() => reopened.close());
  assert.deepEqual(counter(reopened.db), { pragma: SCHEMA_VERSION, meta: String(SCHEMA_VERSION) });
  assert.equal(reopened.task.get("TASK-1").title, "legacy");
});

test("a meta-only version counter bootstraps PRAGMA user_version", (t) => {
  const { dbPath } = tempDb(t);
  const raw = new DatabaseSync(dbPath);
  raw.exec(SCHEMA);
  raw.prepare("INSERT INTO meta(key,value) VALUES('schema_version', ?)").run(String(SCHEMA_VERSION));
  raw.close();

  const store = createStore({ dbPath });
  t.after(() => store.close());
  assert.deepEqual(counter(store.db), { pragma: SCHEMA_VERSION, meta: String(SCHEMA_VERSION) });
});

test("a store from the future refuses to open instead of guessing", (t) => {
  const { dbPath } = tempDb(t);
  const raw = new DatabaseSync(dbPath);
  raw.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  raw.prepare("INSERT INTO meta(key,value) VALUES('schema_version','99')").run();
  raw.exec("PRAGMA user_version = 99");
  raw.close();

  assert.throws(() => createStore({ dbPath }), /newer than this build/);
});
