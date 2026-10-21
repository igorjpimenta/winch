// store.test.js — schema v2 migration, CAS claim, sweeper, heartbeat.
// node:test + node:assert, zero deps. Each test gets a throwaway DB in
// os.tmpdir(); the live ~/.openclaw/backlog/store.sqlite is never touched.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore, MAX_ATTEMPTS } from "../src/store.js";

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "backlog-store-"));
  return { dir, dbPath: path.join(dir, "store.sqlite") };
}

function makeStore(t) {
  const { dir, dbPath } = tempDb();
  const store = createStore({ dbPath });
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return store;
}

function seedHierarchy(store) {
  const epic  = store.epic.create({ title: "epic" });
  const story = store.story.create({ epicId: epic.id, title: "story", status: "ready" });
  const task  = store.task.create({ storyId: story.id, title: "task" });
  return { epic, story, task };
}

function eventsFor(store, taskId) {
  return store.db.prepare("SELECT * FROM events WHERE task_id=? ORDER BY id").all(taskId);
}

// ────────────────────────────────────────────────────────── S0.2 MIGRATION

const V1_SCHEMA = `
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
  execution_kind TEXT NOT NULL CHECK (execution_kind IN ('pipeclaw','subagent','cli','gate','manual')),
  execution_args TEXT NOT NULL DEFAULT '{}', assigned TEXT, capabilities TEXT,
  flow_id TEXT, task_run_id TEXT, claim_expires_at INTEGER, result_summary TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, claimed_at INTEGER, closed_at INTEGER
);
CREATE TABLE deps (
  from_id TEXT NOT NULL, from_kind TEXT NOT NULL CHECK (from_kind IN ('epic','story','task')),
  to_id TEXT NOT NULL, to_kind TEXT NOT NULL CHECK (to_kind IN ('epic','story','task')),
  created_at INTEGER NOT NULL, PRIMARY KEY (from_id, to_id)
);
`;

// Mirrors the seeded live store: 1 epic, 2 stories, 4 tasks, 1 dep.
function seedV1(dbPath) {
  const raw = new DatabaseSync(dbPath);
  raw.exec(V1_SCHEMA);
  raw.prepare("INSERT INTO meta(key,value) VALUES('schema_version','1')").run();
  const t = 1700000000000;
  raw.prepare("INSERT INTO epics(id,title,status,created_at,updated_at) VALUES(?,?,?,?,?)")
    .run("EPIC-v1", "legacy epic", "planned", t, t);
  raw.prepare("INSERT INTO stories(id,epic_id,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .run("STORY-v1a", "EPIC-v1", "legacy story a", "ready", t, t);
  raw.prepare("INSERT INTO stories(id,epic_id,title,status,created_at,updated_at) VALUES(?,?,?,?,?,?)")
    .run("STORY-v1b", "EPIC-v1", "legacy story b", "backlog", t, t);
  for (const [id, storyId, title, status] of [
    ["TASK-v1-1", "STORY-v1a", "legacy task 1", "todo"],
    ["TASK-v1-2", "STORY-v1a", "legacy task 2", "in_progress"],
    ["TASK-v1-3", "STORY-v1b", "legacy task 3", "todo"],
    ["TASK-v1-4", "STORY-v1b", "legacy task 4", "done"],
  ]) {
    raw.prepare(`
      INSERT INTO tasks(id,story_id,title,status,execution_kind,execution_args,created_at,updated_at)
      VALUES (?,?,?,?, 'manual','{}',?,?)
    `).run(id, storyId, title, status, t, t);
  }
  raw.prepare("INSERT INTO deps(from_id,from_kind,to_id,to_kind,created_at) VALUES(?,?,?,?,?)")
    .run("STORY-v1a", "story", "STORY-v1b", "story", t);
  raw.close();
}

test("S0.2: v1 store migrates to v2, rows preserved, reopen idempotent", (t) => {
  const { dir, dbPath } = tempDb();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  seedV1(dbPath);

  const store = createStore({ dbPath });
  const cols = new Set(store.db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name));
  assert.ok(cols.has("lease_seconds"),  "lease_seconds column added");
  assert.ok(cols.has("last_heartbeat"), "last_heartbeat column added");
  assert.ok(cols.has("attempt_count"),  "attempt_count column added");
  const events = store.db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='events'"
  ).get();
  assert.ok(events, "events table created");

  assert.equal(store.epic.list().length, 1);
  assert.equal(store.story.list().length, 2);
  assert.equal(store.task.list().length, 4);
  assert.equal(store.dep.all().length, 1);
  const migrated = store.task.get("TASK-v1-2");
  assert.equal(migrated.title, "legacy task 2");
  assert.equal(migrated.status, "in_progress");
  assert.equal(migrated.attempt_count, 0);
  assert.equal(
    store.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value,
    "7"
  );
  store.close();

  const reopened = createStore({ dbPath });
  assert.equal(reopened.task.get("TASK-v1-1").title, "legacy task 1");
  assert.equal(
    reopened.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value,
    "7"
  );
  reopened.close();
});

// ───────────────────────────────────────────────────────────── S0.3 CAS

test("S0.3: claim is CAS — first wins, loser gets null, re-claim after release wins", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);

  const claimed = store.task.claim({ id: task.id, agentId: "agent-a" });
  assert.ok(claimed);
  assert.equal(claimed.status, "in_progress");
  assert.equal(claimed.assigned, "agent-a");
  assert.equal(claimed.lease_seconds, 1800);

  const evs = eventsFor(store, task.id);
  assert.equal(evs.length, 2);
  assert.equal(evs[0].from_status, null);
  assert.equal(evs[0].to_status, "todo");
  assert.equal(evs[0].note, "task created");
  assert.equal(evs[1].from_status, "todo");
  assert.equal(evs[1].to_status, "in_progress");
  assert.equal(evs[1].actor, "agent-a");
  assert.equal(evs[1].note, "claim");

  assert.equal(store.task.claim({ id: task.id, agentId: "agent-b" }), null);
  assert.equal(store.task.claim({ id: task.id, agentId: "agent-a" }), null);

  assert.ok(store.task.release(task.id));
  const again = store.task.claim({ id: task.id, agentId: "agent-a" });
  assert.ok(again, "assigned agent re-claims after release");
  assert.equal(again.status, "in_progress");
});

test("S0.3 atomicity: claim event `at` equals the claim's `claimed_at`", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);
  const claimed = store.task.claim({ id: task.id, agentId: "agent-a" });
  assert.equal(claimed.lastEvent.at, claimed.claimed_at);
  assert.equal(claimed.lastEvent.note, "claim");
});

// ───────────────────────────────────────────────────────── S0.4 SWEEPER

test("S0.4: sweeper re-releases expired claims, escalates at MAX_ATTEMPTS", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);

  let sweepAt = Date.now() + 10;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const claimed = store.task.claim({ id: task.id, agentId: "agent-a", watchdogMs: 1 });
    assert.ok(claimed, `claim ${attempt} succeeds`);
    const swept = store.task.sweepExpired({ now: sweepAt += 1000 });
    assert.equal(swept.length, 1);
    const after = store.task.get(task.id);
    if (attempt < MAX_ATTEMPTS) {
      assert.equal(after.status, "todo");
      assert.equal(after.attempt_count, attempt);
    } else {
      assert.equal(after.status, "blocked");
      assert.equal(after.attempt_count, MAX_ATTEMPTS);
    }
  }

  const evs = eventsFor(store, task.id);
  // birth + 3 claims + 3 sweep-releases + 1 escalation
  assert.equal(evs.length, 2 + 2 * MAX_ATTEMPTS);
  const sweeps = evs.filter((e) => e.note === "sweeper");
  assert.equal(sweeps.length, MAX_ATTEMPTS);
  for (const e of sweeps) {
    assert.equal(e.from_status, "in_progress");
    assert.equal(e.to_status, "todo");
  }
  const last = evs[evs.length - 1];
  assert.equal(last.note, "blocked: max attempts");
  assert.equal(last.from_status, "todo");
  assert.equal(last.to_status, "blocked");
});

test("S0.4: sweeper ignores unexpired and non-in_progress tasks", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);
  store.task.claim({ id: task.id, agentId: "agent-a", watchdogMs: 60_000 });
  assert.deepEqual(store.task.sweepExpired({ now: Date.now() }), []);
  assert.equal(store.task.get(task.id).status, "in_progress");
});

// ─────────────────────────────────────────────────────────── HEARTBEAT

test("heartbeat: advances last_heartbeat only for the assigned in_progress agent", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);

  assert.equal(store.task.heartbeat(task.id, "agent-a"), null, "todo task cannot heartbeat");

  const claimed = store.task.claim({ id: task.id, agentId: "agent-a" });
  const beat = store.task.heartbeat(task.id, "agent-a");
  assert.ok(beat);
  assert.ok(beat.last_heartbeat >= claimed.last_heartbeat);
  assert.equal(store.task.heartbeat(task.id, "agent-b"), null, "wrong agent rejected");

  const evCount = eventsFor(store, task.id).length;
  assert.equal(evCount, 2, "heartbeats write no event rows (birth + claim only)");
});

// ────────────────────────────────────────────────────── UPDATE EVENTS

test("task.update: status change writes an event; other patches do not", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);

  store.task.update(task.id, { description: "clarified" });
  assert.equal(eventsFor(store, task.id).length, 1, "birth row only");

  const done = store.task.update(task.id, { status: "done", actor: "agent-a", note: "finished" });
  assert.equal(done.status, "done");
  const evs = eventsFor(store, task.id);
  assert.equal(evs.length, 2);
  assert.equal(evs[1].from_status, "todo");
  assert.equal(evs[1].to_status, "done");
  assert.equal(evs[1].actor, "agent-a");
  assert.equal(evs[1].note, "finished");
});

test("task.update: actor/note optional — defaults to system", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);
  store.task.update(task.id, { status: "blocked" });
  const ev = eventsFor(store, task.id)[1];
  assert.equal(ev.actor, "system");
  assert.equal(ev.note, null);
});

// ──────────────────────────────── S1.3 fixup: stale graph_flow CHECK
test("stale graph_flow CHECK is repaired and stored values are renamed", (t) => {
  const { dir } = tempDb();
  const dbPath = path.join(dir, "legacy.sqlite");
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Legacy pre-rename table shape, with one graph_flow-era row.
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO meta(key,value) VALUES('schema_version','1');
    CREATE TABLE epics (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, acceptance TEXT,
      status TEXT NOT NULL, owner_team TEXT, priority INTEGER NOT NULL DEFAULT 50,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER
    );
    CREATE TABLE stories (
      id TEXT PRIMARY KEY, epic_id TEXT NOT NULL REFERENCES epics(id), title TEXT NOT NULL,
      description TEXT, acceptance TEXT, status TEXT NOT NULL, size TEXT,
      priority INTEGER NOT NULL DEFAULT 50, assigned TEXT, capabilities TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, story_id TEXT NOT NULL REFERENCES stories(id), title TEXT NOT NULL,
      description TEXT, status TEXT NOT NULL,
      execution_kind TEXT NOT NULL CHECK (execution_kind IN ('graph_flow','subagent','cli','gate','manual')),
      execution_args TEXT NOT NULL DEFAULT '{}', assigned TEXT, capabilities TEXT,
      flow_id TEXT, task_run_id TEXT, claim_expires_at INTEGER, result_summary TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, claimed_at INTEGER, closed_at INTEGER
    );
    CREATE TABLE deps (from_id TEXT NOT NULL, from_kind TEXT NOT NULL, to_id TEXT NOT NULL,
      to_kind TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (from_id, to_id));
    INSERT INTO epics(id,title,status,created_at,updated_at) VALUES('EPIC-1','E','planned',1,1);
    INSERT INTO stories(id,epic_id,title,status,created_at,updated_at) VALUES('STORY-1','EPIC-1','S','ready',1,1);
    INSERT INTO tasks(id,story_id,title,status,execution_kind,created_at,updated_at)
      VALUES('TASK-legacy','STORY-1','legacy pipe task','todo','graph_flow',1,1);
  `);
  raw.close();

  const store = createStore({ dbPath });
  // value renamed, constraint accepts the new vocabulary, inserts work
  assert.equal(store.task.get("TASK-legacy").execution_kind, "pipeclaw");
  const created = store.task.create({ storyId: "STORY-1", title: "fresh", executionKind: "pipeclaw" });
  assert.equal(created.execution_kind, "pipeclaw");
  // indexes usable after rebuild
  store.db.prepare("SELECT id FROM tasks WHERE status='todo' AND assigned IS NULL").all();
  store.close();
});

test("heartbeat renews the claim lease — a live agent is never swept", (t) => {
  const store = makeStore(t);
  const { task } = seedHierarchy(store);
  store.task.claim({ id: task.id, agentId: "agent-a", watchdogMs: 60 * 1000 });
  // Expire the lease out from under a live agent, then heartbeat.
  store.db.prepare("UPDATE tasks SET claim_expires_at=? WHERE id=?").run(1, task.id);
  const beat = store.task.heartbeat(task.id, "agent-a");
  assert.ok(beat, "heartbeat accepted");
  assert.ok(beat.claim_expires_at > Date.now(), "lease renewed into the future");
  assert.deepEqual(store.task.sweepExpired({}), [], "nothing swept");
  assert.equal(store.task.get(task.id).status, "in_progress");
});

test("session budgets roll up per agent across sessions", (t) => {
  const store = makeStore(t);
  const a = store.sessionBudget.charge({ sessionKey: "s-1", agentId: "x", limit: 100, agentLimit: 3 });
  assert.equal(a.agentToolCalls, 1);
  assert.equal(a.agentExhausted, false);
  store.sessionBudget.charge({ sessionKey: "s-2", agentId: "x", limit: 100, agentLimit: 3 });
  const c = store.sessionBudget.charge({ sessionKey: "s-2", agentId: "x", limit: 100, agentLimit: 3 });
  assert.equal(c.agentToolCalls, 3);
  assert.equal(c.agentExhausted, true, "campaign total trips the agent latch");
  assert.equal(c.exhausted, false, "session latch untouched");
});

test("v6 store gains nullable events.task_id, rows preserved, reopen idempotent", (t) => {
  const { dir, dbPath } = tempDb();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const raw = new DatabaseSync(dbPath);
  raw.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
      from_status TEXT, to_status TEXT NOT NULL, actor TEXT, note TEXT, session_ref TEXT, at INTEGER NOT NULL);
    INSERT INTO meta(key,value) VALUES('schema_version','6');
    INSERT INTO events(task_id, from_status, to_status, actor, note, at)
      VALUES('TASK-x','todo','in_progress','a','claim',1700000000000);`);
  raw.close();
  const store = createStore({ dbPath });
  const flags = store.db.prepare("PRAGMA table_info(events)").all();
  assert.equal(flags.find((c) => c.name === "task_id").notnull, 0, "task_id nullable after rebuild");
  assert.equal(flags.find((c) => c.name === "to_status").notnull, 0, "to_status nullable after rebuild");
  assert.equal(store.db.prepare("SELECT note FROM events").get().note, "claim", "row survives");
  // The taskless latch marker the migration exists for is now insertable.
  store.db.prepare("INSERT INTO events(task_id, from_status, to_status, actor, note, at) VALUES (NULL, NULL, NULL, 'a', 'session budget exhausted: 1/1 backlog calls; claims halted', 1)").run();
  assert.equal(store.db.prepare("SELECT value FROM meta WHERE key='schema_version'").get().value, "7");
  store.close();
  const reopened = createStore({ dbPath });
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS n FROM events").get().n, 2);
  reopened.close();
});
